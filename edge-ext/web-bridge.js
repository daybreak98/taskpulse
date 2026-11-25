// 跑在 DataAgent 页面里，用页面自己的 cookie 拉数据（不需要 OBO token）。
// 只读，结果只发给本机 TaskPulse，不外传。
//
// 频率照抄网页自己的策略：
//   正在跑的会话  5 秒复查
//   其它会话      60 秒复查
//   会话列表      30 秒刷新
(function () {
  // 后台会对已开页面再注入一次。但扩展重载后，旧的 content script 会变成
  // 「孤儿」——它和扩展的连接已断，却仍在 window 上留了标记。若只判断标记，
  // 新实例会被直接挡掉，页面从此永远不上报。所以先验旧实例是否还有效。
  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;                 // 上下文已失效
    }
  }
  if (window.__tpWebBridge && typeof window.__tpWebBridge === "object" && window.__tpWebBridge.ok && window.__tpWebBridge.ok()) {
    return;
  }
  window.__tpWebBridge = { ok: alive };

  let CFG = null;
  let convs = [];
  const queues = {};        // cid -> {sessionState, pending, ...}
  const queueAt = {};       // cid -> 这条队列是哪一刻成功取到的
  const lastMessages = {};  // cid -> {sender, content}
  const lastQueueAt = {};   // cid -> 上次拉队列的时刻
  const seenUpdate = {};    // cid -> 上一次看到的 updateTime
  const hotUntil = {};      // cid -> 这个时刻之前按「刚有动静」加密采样
  const lastMsgAt = {};     // cid -> 上次拉最后一条消息的 updateTime
  let lastListAt = 0;
  let lastReportAt = 0;
  let busy = false;
  let lastError = "";     // 最近一次采集失败的原因，随上报带出
  let roleWanted = false;   // 后台是否把采集权给了这一页；没给就不该开定时器
  let timer = null;

  const now = () => Date.now();

  // 后台只在选主结果变化时发消息，稳定状态下这里不会被打扰
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.kind !== "tp-role") return;
    roleWanted = !!msg.leader;
    sync();
  });

  function askConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ kind: "get-config" }, (r) => resolve(r || null));
    });
  }

  // 谁采集由后台选主决定：几十个同类标签页各自定时拉，等于把同一份数据拉几十遍
  function askRole() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ kind: "tp-role-ask" }, (r) => resolve(r || null));
      } catch (_) {
        resolve(null);
      }
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
    // 和 API 侧同一套契约：业务失败（success:false / result 非 0）要报错，
    // 不能当成「空列表」发布出去——那会把当前状态刷成 0 个会话
    if (!data || !data.data || typeof data.data !== "object") {
      throw new Error("列表响应结构无效");
    }
    if (data.success === false) throw new Error("列表接口返回业务失败");
    if (data.error_msg) throw new Error("列表接口报错：" + String(data.error_msg).slice(0, 80));
    const d = data.data;
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
      if (d) {
        queues[cid] = d;
        // 成功取到的那一刻：后端据此判断「这条样本是新的还是沿用旧值」，
        // 光靠上报时刻会把几分钟前的旧队列说成刚刚观测
        queueAt[cid] = now();
      }
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
      const path = (CFG.api.messages || "/conversations/{cid}/messages?pageNo=1&pageSize=1")
        .replace("{cid}", cid);
      const data = await jfetch(CFG.api.prefix + path);
      const list = ((data && data.data) || {}).list || [];
      const m = list[0];
      if (m) lastMessages[cid] = { sender: m.sender, content: (m.content || "").slice(0, 400) };
    } catch (_) {}
  }

  function isBusy(cid) {
    const q = queues[cid];
    if (!q || !CFG.api) return null;
    // 字段名与 poller 同源（config.js 由 install.command 生成），不在这里写死
    const st = q[CFG.api.state || "state"];
    if (st == null || st === "") return null;
    const pending = CFG.api.pending ? q[CFG.api.pending] : null;
    const idle = CFG.api.idle || [];
    return Boolean(pending) || idle.indexOf(st) < 0;
  }

  function report() {
    if (now() - lastReportAt < 4000) return;
    lastReportAt = now();
    // 分好组的会话往往不活跃、updateTime 靠后，按时间截断会把它们整批丢掉；
    // 所以先把所有带分组的挑出来，再补上最近的未分组会话。
    const grouped = convs.filter((c) => c.groupName);
    const rest = convs.filter((c) => !c.groupName).slice(0, 60);
    const pick = grouped.concat(rest).map((c) => ({
      id: c.id, name: c.name, agentId: c.agentId,
      updateTime: c.updateTime, createTime: c.createTime, groupName: c.groupName
    }));
    const payload = {
      at: now(),
      url: location.href,
      error: lastError || undefined,
      conversations: pick,
      queues: queues,
      queueAt: queueAt,
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
        // 列表里的 updateTime 变了＝这一轮刚有动静（用户发消息 / 回复落地）。
        // 只按「忙不忙」决定采样间隔是不够的：刚发完消息的那 60 秒里它仍然是
        // IDLE，等下一次 60 秒的采样赶到，短任务已经结束，什么都看不到。
        if (c.updateTime && c.updateTime !== seenUpdate[cid]) {
          seenUpdate[cid] = c.updateTime;
          hotUntil[cid] = now() + 120000;
        }
        const hot = (hotUntil[cid] || 0) > now();
        const b = isBusy(cid);
        const gap = b === true ? 5000 : (hot ? 5000 : 60000);
        const last = lastQueueAt[cid] || 0;
        if (now() - last < gap) continue;
        if (pulled >= 6) break;       // 单轮最多 6 个，避免突发
        await pullQueue(cid);
        pulled += 1;
        if (isBusy(cid) === false && c.updateTime) await pullLastMessage(cid, c.updateTime);
      }
      report();
    } catch (exc) {
      // 页面切走/登录失效都很常见，但这轮失败要带出去：否则后端只看到
      // 「页面没上报」，分不清是没注入、没登录，还是解析挂了
      lastError = String((exc && exc.message) || exc || "").slice(0, 120);
      report();
    } finally {
      busy = false;
    }
  }

  function sync() {
    const want = roleWanted && !!CFG;
    if (want && !timer) {
      tick();                                // 刚拿到采集权先补一轮，别干等 2 秒
      timer = setInterval(tick, 2000);
    } else if (!want && timer) {
      clearInterval(timer);                  // 被换下来就立刻停：后面拉的数据没人要
      timer = null;
    }
  }

  (async () => {
    CFG = await askConfig();
    if (!CFG || !CFG.api) return;
    // 后台在页面被节流时靠这个口子来敲门；没采集权就不该被敲动
    window.__tpWebBridgeTick = () => { if (roleWanted) tick(); };
    // 先问一句「这一页要不要采集」，默认不采：判断权在后台，页面自己不开火
    const r = await askRole();
    roleWanted = !!(r && r.leader);
    sync();
    document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) tick(); });
  })();
})();
