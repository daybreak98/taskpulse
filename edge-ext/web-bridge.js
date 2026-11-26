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
  const queueErrors = {};
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
  let roleWanted = false;
  let roleGeneration = "";
  let roleLease = "";
  let roleChange = 0;
  let requestController = null;
  const pageId = crypto.randomUUID();
  let timer = null;
  const now = () => Date.now();

  function owns(lease) { return roleWanted && lease === roleLease && !!roleGeneration; }
  function acceptRole(msg) {
    const wanted = !!msg?.leader && typeof msg.generation === "string" && !!msg.generation &&
      typeof msg.lease === "string" && !!msg.lease;
    if (wanted === roleWanted && msg?.lease === roleLease && msg?.generation === roleGeneration) return;
    roleChange += 1;
    roleWanted = wanted;
    roleLease = msg?.lease || "";
    roleGeneration = msg?.generation || "";
    requestController?.abort();
    convs = [];
    lastListAt = lastReportAt = 0;
    lastError = "";
    for (const cache of [queues, queueAt, queueErrors, lastMessages, lastQueueAt, seenUpdate, hotUntil, lastMsgAt]) {
      for (const key of Object.keys(cache)) delete cache[key];
    }
    sync();
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.kind !== "tp-role") return;
    acceptRole(msg);
    respond({ pageId });
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
        chrome.runtime.sendMessage({ kind: "tp-role-ask", pageId }, (r) => resolve(r || null));
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function jfetch(path, init, lease) {
    if (!owns(lease)) throw new Error("采集权已变更");
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const opts = Object.assign({ credentials: "include", cache: "no-store", signal: controller.signal }, init || {});
      const r = await fetch(path, opts);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (!owns(lease)) throw new Error("采集权已变更");
      if (!data || data.success === false || data.error_msg || !data.data || typeof data.data !== "object") {
        throw new Error("接口返回无效数据");
      }
      return data;
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = null;
    }
  }

  async function pullList(lease) {
    const body = (CFG.api && CFG.api.body) || {};
    const data = await jfetch(CFG.api.prefix + CFG.api.conv, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, lease);
    // 和 API 侧同一套契约：业务失败（success:false / result 非 0）要报错，
    // 不能当成「空列表」发布出去——那会把当前状态刷成 0 个会话
    if (!data || !data.data || typeof data.data !== "object") {
      throw new Error("列表响应结构无效");
    }
    if (data.success === false) throw new Error("列表接口返回业务失败");
    if (data.error_msg) throw new Error("列表接口报错：" + String(data.error_msg).slice(0, 80));
    const d = data.data;
    if (!Array.isArray(d.groups) && !Array.isArray(d.ungrouped?.conversations)) {
      throw new Error("会话列表结构无效");
    }
    const out = [];
    for (const g of d.groups || []) {
      for (const c of (g.conversations || [])) out.push(Object.assign({}, c, { groupName: g.name || "" }));
    }
    const un = (d.ungrouped && d.ungrouped.conversations) || [];
    for (const c of un) out.push(Object.assign({}, c, { groupName: "" }));
    out.sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
    const unique = new Map();
    for (const c of out) if (c.id != null && !unique.has(String(c.id))) unique.set(String(c.id), c);
    convs = [...unique.values()];
    lastListAt = now();
    lastError = "";
    const present = new Set(convs.map(c => String(c.id)));
    for (const cache of [queues, queueAt, queueErrors, lastMessages, lastQueueAt, seenUpdate, hotUntil, lastMsgAt]) {
      for (const cid of Object.keys(cache)) if (!present.has(cid)) delete cache[cid];
    }
  }

  async function pullQueue(cid, lease) {
    try {
      const data = await jfetch(CFG.api.prefix + CFG.api.queue.replace("{cid}", cid), {}, lease);
      const d = data.data;
      const state = d[CFG.api.state || "state"];
      if ((typeof state !== "string" && typeof state !== "number") || state === "") {
        throw new Error("队列结构无效");
      }
      queues[cid] = d;
      queueAt[cid] = now();
      delete queueErrors[cid];
      return true;
    } catch (_) {
      if (owns(lease)) queueErrors[cid] = now();
      return false;
    } finally {
      if (owns(lease)) lastQueueAt[cid] = now();
    }
  }

  // 只在「有新回复」时拉一次最后一条消息，供限流识别使用
  async function pullLastMessage(cid, updateTime, lease) {
    const previous = lastMsgAt[cid];
    if (previous?.version === updateTime && now() < previous.nextAt) return;
    lastMsgAt[cid] = { version: updateTime, nextAt: now() + 10000 };
    if (lastMessages[cid]?.updateTime !== updateTime) delete lastMessages[cid];
    try {
      const path = (CFG.api.messages || "/conversations/{cid}/messages?pageNo=1&pageSize=1")
        .replace("{cid}", cid).replace(/([?&]pageSize=)\d+/, (_, prefix) => prefix + "20");
      const data = await jfetch(CFG.api.prefix + path, {}, lease);
      const list = data.data.list;
      if (!Array.isArray(list)) throw new Error("消息列表结构无效");
      const marks = CFG.api.marks || [];
      const messages = list.filter(m => m && (m.sender === "assistant" || m.sender === "user")).map(m => ({
        sender: m.sender,
        id: m.messageId ?? m.id,
        createTime: m.createTime ?? m.createdAt,
        failed: m.sender === "assistant" && typeof m.content === "string" &&
          marks.some(k => m.content.includes(k))
      }));
      lastMessages[cid] = { messages, updateTime, sampledAt: now() };
      lastMsgAt[cid].nextAt = now() + (messages[0]?.sender === "assistant" ? 30000 : 10000);
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
    return (Array.isArray(pending) ? pending.length > 0 : Boolean(pending)) || idle.indexOf(st) < 0;
  }

  function report(lease) {
    if (!owns(lease) || now() - lastReportAt < 4000) return;
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
      generation: roleGeneration,
      listAt: lastListAt,
      url: location.href,
      error: lastError || undefined,
      conversations: pick,
      queues: queues,
      queueAt: queueAt,
      queueErrors: queueErrors,
      lastMessages: lastMessages
    };
    chrome.runtime.sendMessage({ kind: "webstate", payload, pageId, lease }, () => void 0);
  }

  async function tick() {
    if (busy || !CFG || !roleWanted) return;
    busy = true;
    const lease = roleLease;
    try {
      if (!lastListAt || now() - lastListAt > 30000) await pullList(lease);
      if (!owns(lease)) return;

      const watch = convs.filter((c, index) => index < 24 || isBusy(String(c.id)) === true || (hotUntil[String(c.id)] || 0) > now());
      const due = [];
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
        if (now() - last >= gap) due.push(c);
      }
      due.sort((a, b) => (lastQueueAt[String(a.id)] || 0) - (lastQueueAt[String(b.id)] || 0));
      const deadline = now() + 10000;
      for (const c of due.slice(0, 6)) {
        if (!owns(lease) || now() >= deadline) break;
        const cid = String(c.id);
        const wasBusy = isBusy(cid) === true;
        if (await pullQueue(cid, lease) && owns(lease)) {
          const stillBusy = isBusy(cid) === true;
          if (wasBusy || stillBusy) hotUntil[cid] = now() + 120000;
          if (wasBusy && !stillBusy) delete lastMsgAt[cid];
          if ((!stillBusy || !lastMessages[cid]) && c.updateTime && now() < deadline) {
            await pullLastMessage(cid, c.updateTime, lease);
          }
        }
      }
      report(lease);
    } catch (exc) {
      // 页面切走/登录失效都很常见，但这轮失败要带出去：否则后端只看到
      // 「页面没上报」，分不清是没注入、没登录，还是解析挂了
      if (owns(lease)) {
        lastError = String((exc && exc.message) || exc || "").slice(0, 120);
        report(lease);
      }
    } finally {
      busy = false;
    }
  }

  function sync() {
    const want = roleWanted && !!CFG;
    if (want && !timer) {
      lastListAt = 0;
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
    const before = roleChange;
    const r = await askRole();
    if (before === roleChange) acceptRole(r);
    sync();
    document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) tick(); });
    let lastVisit = 0;
    const userVisit = event => {
      if (!event.isTrusted || document.hidden || !document.hasFocus() || now() - lastVisit < 1000) return;
      lastVisit = now();
      try { chrome.runtime.sendMessage({ kind: "tp-user-visit", at: lastVisit }, () => void 0); } catch (_) {}
    };
    document.addEventListener("pointerdown", userVisit, true);
    document.addEventListener("keydown", userVisit, true);
  })();
})();
