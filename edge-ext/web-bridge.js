// 跑在 DataAgent 页面里，用页面自己的 cookie 拉数据（不需要 OBO token）。
// 只读，结果只发给本机 TaskPulse，不外传。
//
// 频率照抄网页自己的策略：
//   正在跑的会话  5 秒复查
//   其它会话      60 秒复查
//   会话列表      30 秒刷新
(function () {
  // 后台会对已经开着的页面再注入一次（免去手刷），这里挡住重复启动
  if (window.__tpWebBridge) return;
  window.__tpWebBridge = true;

  let CFG = null;
  let convs = [];
  const queues = {};        // cid -> {sessionState, pending, ...}
  const lastMessages = {};  // cid -> {sender, content}
  const lastQueueAt = {};   // cid -> 上次拉队列的时刻
  const lastMsgAt = {};     // cid -> 上次拉最后一条消息的 updateTime
  let lastListAt = 0;
  let lastReportAt = 0;
  let busy = false;

  const now = () => Date.now();

  function askConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ kind: "get-config" }, (r) => resolve(r || null));
    });
  }

  async function jfetch(path, init) {
    const opts = Object.assign({ credentials: "include" }, init || {});
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function pullList() {
    const body = (CFG.api && CFG.api.body) || {};
    const data = await jfetch(CFG.api.prefix + CFG.api.conv, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const d = (data && data.data) || {};
    const out = [];
    for (const g of d.groups || []) {
      for (const c of (g.conversations || [])) out.push(Object.assign({}, c, { groupName: g.name || "" }));
    }
    const un = (d.ungrouped && d.ungrouped.conversations) || [];
    for (const c of un) out.push(Object.assign({}, c, { groupName: "" }));
    out.sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
    convs = out;
    lastListAt = now();
  }

  async function pullQueue(cid) {
    try {
      const data = await jfetch(CFG.api.prefix + CFG.api.queue.replace("{cid}", cid));
      const d = (data && data.data) || null;
      if (d) queues[cid] = d;
      lastQueueAt[cid] = now();
    } catch (_) {
      lastQueueAt[cid] = now();
    }
  }

  // 只在「有新回复」时拉一次最后一条消息，供限流识别使用
  async function pullLastMessage(cid, updateTime) {
    if (lastMsgAt[cid] === updateTime) return;
    lastMsgAt[cid] = updateTime;
    try {
      const data = await jfetch(CFG.api.prefix + "/conversations/" + cid + "/messages?pageNo=1&pageSize=1");
      const list = ((data && data.data) || {}).list || [];
      const m = list[0];
      if (m) lastMessages[cid] = { sender: m.sender, content: (m.content || "").slice(0, 400) };
    } catch (_) {}
  }

  function isBusy(cid) {
    const q = queues[cid];
    if (!q) return null;
    const st = q.sessionState;
    if (st == null || st === "") return null;
    const idle = (CFG.api && CFG.api.idle) || [];
    return (Array.isArray(q.pending) && q.pending.length > 0) || idle.indexOf(st) < 0;
  }

  function report() {
    if (now() - lastReportAt < 4000) return;
    lastReportAt = now();
    const payload = {
      at: now(),
      url: location.href,
      conversations: convs.slice(0, 60).map((c) => ({
        id: c.id, name: c.name, agentId: c.agentId,
        updateTime: c.updateTime, createTime: c.createTime, groupName: c.groupName
      })),
      queues: queues,
      lastMessages: lastMessages
    };
    chrome.runtime.sendMessage({ kind: "webstate", payload }, () => void 0);
  }

  async function tick() {
    if (busy || !CFG) return;
    busy = true;
    try {
      if (!lastListAt || now() - lastListAt > 30000) await pullList();

      const watch = convs.slice(0, 24);
      let pulled = 0;
      for (const c of watch) {
        const cid = String(c.id);
        const b = isBusy(cid);
        const gap = b === true ? 5000 : 60000;
        const last = lastQueueAt[cid] || 0;
        if (now() - last < gap) continue;
        if (pulled >= 6) break;       // 单轮最多 6 个，避免突发
        await pullQueue(cid);
        pulled += 1;
        if (isBusy(cid) === false && c.updateTime) await pullLastMessage(cid, c.updateTime);
      }
      report();
    } catch (_) {
      // 页面切走/登录失效时静默等下轮
    } finally {
      busy = false;
    }
  }

  (async () => {
    CFG = await askConfig();
    if (!CFG || !CFG.api) return;
    // 后台在页面被节流时靠这个口子来敲门
    window.__tpWebBridgeTick = tick;
    tick();
    setInterval(tick, 2000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  })();
})();
