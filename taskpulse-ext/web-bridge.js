// Based on edge-ext/web-bridge.js. This collector uses only the current site's login.
(() => {
  const web = globalThis.TaskPulseWeb;
  if (!web.conversationPage(location.href) || globalThis.taskPulseCollector?.alive()) return;
  const { api, timing } = web;
  const pageId = crypto.randomUUID();
  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }
  globalThis.taskPulseCollector = { alive };

  let lease = "";
  let timer = null;
  let request = null;
  let collecting = false;
  let conversations = [];
  let listAt = 0;
  let nextListAt = 0;
  let reportAt = 0;
  let error = "";
  let dirty = true;
  const samples = new Map();
  const messages = new Map();
  const probes = new Map();

  async function fetchInfo(path, deadline, init = {}) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !lease) throw new Error("已暂停采集");
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), Math.min(remaining, timing.request));
    try {
      const response = await fetch(new URL(path, location.origin), {
        ...init, credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: controller.signal
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (!data?.data || typeof data.data !== "object" || data.success === false || data.error_msg) {
        throw new Error("DataAgent 返回无效数据");
      }
      return data.data;
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
    }
  }

  async function pullList(deadline) {
    const data = await fetchInfo(api.prefix + api.conv, deadline, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(api.body)
    });
    const groups = data.groups;
    const ungrouped = data.ungrouped?.conversations;
    if (!Array.isArray(groups) && !Array.isArray(ungrouped)) throw new Error("会话列表结构无效");
    const found = new Map();
    function take(rows, groupName) {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const id = web.id(row?.id);
        if (!id || found.has(id)) continue;
        found.set(id, { id, name: row.name, agentId: row.agentId,
          createTime: row.createTime, updateTime: row.updateTime, groupName });
      }
    }
    if (Array.isArray(groups)) {
      for (const group of groups) take(group?.conversations, group?.name || "");
    }
    take(ungrouped, "");
    conversations = [...found.values()].sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
    listAt = Date.now();
    dirty = true;
    const watched = new Set(conversations.slice(0, timing.watch).map(row => row.id));
    for (const map of [samples, messages, probes]) {
      for (const id of map.keys()) if (!watched.has(id)) map.delete(id);
    }
  }

  async function pullQueue(row, sample, deadline) {
    sample.checked = Date.now();
    try {
      const data = await fetchInfo(api.prefix + api.queue.replace("{cid}", row.id), deadline);
      const state = data[api.state];
      if ((typeof state !== "string" && typeof state !== "number") || state === "") throw new Error("队列结构无效");
      const pending = data[api.pending];
      sample.queue = {
        [api.state]: state,
        [api.pending]: Array.isArray(pending) ? pending.length > 0 : Boolean(pending)
      };
      sample.at = Date.now();
      sample.errorAt = 0;
    } catch {
      sample.errorAt = Date.now();
      return false;
    } finally {
      dirty = true;
    }
    return true;
  }

  async function pullLastMessage(row, deadline) {
    const updateTime = Number(row.updateTime) || 0;
    if (!updateTime || deadline - Date.now() < 250) return;
    const previous = probes.get(row.id);
    const sameVersion = previous?.updateTime === updateTime;
    if (sameVersion && Date.now() < previous.nextAt) return;
    const failures = sameVersion ? previous.failures : 0;
    const probe = { updateTime, failures: failures + 1,
      nextAt: Date.now() + Math.min(60_000, 10_000 * (2 ** Math.min(failures, 3))) };
    probes.set(row.id, probe);
    try {
      const data = await fetchInfo(api.prefix + api.messages.replace("{cid}", row.id), deadline);
      const latest = Array.isArray(data.list) && data.list[0];
      if (typeof latest?.sender !== "string") return;
      const sender = latest.sender === "assistant" ? "assistant" : "other";
      const content = typeof latest.content === "string" ? latest.content : "";
      const failed = sender === "assistant" && api.marks.some(mark => content.includes(mark));
      const messageId = latest.id ?? latest.messageId;
      let atMessage = Number(latest.createTime ?? latest.createdAt);
      if (atMessage > 0 && atMessage < 1e12) atMessage *= 1000;
      const message = {
        sender, failed, updateTime, at: Date.now(),
        messageId: typeof messageId === "string" || typeof messageId === "number"
          ? String(messageId).slice(0, 100) : "",
        atMessage: Number.isSafeInteger(atMessage) ? atMessage : 0
      };
      messages.set(row.id, message);
      probe.failures = 0;
      probe.nextAt = Date.now() + (sender === "assistant" ? 30_000 : 10_000);
      dirty = true;
    } catch {
      // A slow or not-yet-visible reply is retried on a later bounded idle sample.
    }
  }

  async function report(token) {
    const at = Date.now();
    if (token !== lease || !alive() || at - reportAt < timing.report ||
        (!dirty && at - reportAt < timing.list)) return;
    reportAt = at;
    const queues = {}, queueAt = {}, queueErrors = {};
    for (const [id, sample] of samples) {
      if (sample.at) {
        queues[id] = sample.queue;
        queueAt[id] = sample.at;
      }
      if (sample.errorAt) queueErrors[id] = sample.errorAt;
    }
    const accepted = await chrome.runtime.sendMessage({
      kind: "tp.webstate", pageId, lease: token,
      payload: { at, listAt, error, conversations, queues, queueAt, queueErrors,
        lastMessages: Object.fromEntries(messages) }
    });
    if (accepted?.ok) dirty = false;
  }

  function dueAt(now) {
    return conversations.slice(0, timing.watch).map(row => {
      let sample = samples.get(row.id);
      if (!sample) {
        sample = { checked: 0, version: 0, hotUntil: 0 };
        samples.set(row.id, sample);
      }
      if (row.updateTime && row.updateTime !== sample.version) {
        sample.version = row.updateTime;
        sample.hotUntil = now + timing.hotWindow;
      }
      return { row, sample };
    }).filter(({ sample }) => {
      const hot = TaskPulseState.queueBusy(sample.queue) === true || sample.hotUntil > now;
      return now - sample.checked >= (hot ? timing.hot : timing.idle);
    }).sort((a, b) => a.sample.checked - b.sample.checked).slice(0, timing.queueBudget);
  }

  async function tick() {
    if (collecting || !lease || !alive() || !web.conversationPage(location.href)) return;
    collecting = true;
    const token = lease;
    const deadline = Date.now() + timing.round;
    try {
      if (Date.now() >= nextListAt) {
        nextListAt = Date.now() + timing.list;
        await pullList(deadline);
        error = "";
      }
      if (!error) {
        for (const { row, sample } of dueAt(Date.now())) {
          if (token !== lease || deadline - Date.now() < 250) break;
          if (await pullQueue(row, sample, deadline) && token === lease &&
              TaskPulseState.queueBusy(sample.queue) === false) {
            await pullLastMessage(row, deadline);
          }
        }
      }
    } catch (failure) {
      if (error !== failure.message) dirty = true;
      error = failure.name === "AbortError" ? "会话列表请求超时" : String(failure.message).slice(0, 150);
    } finally {
      try { await report(token); } catch { /* An extension reload can invalidate this page. */ }
      collecting = false;
    }
  }

  function setRole(token) {
    if (token === lease) return;
    lease = token;
    if (timer !== null) clearInterval(timer);
    request?.abort();
    timer = null;
    if (token) {
      // A new lease refreshes immediately. A stable leader keeps the existing caches.
      nextListAt = 0;
      dirty = true;
      timer = setInterval(tick, timing.tick);
      void tick();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind === "tp.probe" && web.conversationPage(location.href)) reply({ pageId, lease });
    if (msg?.pageId !== pageId) return;
    if (msg.kind === "tp.role") {
      setRole(msg.lease || "");
      reply({ pageId });
    }
    if (msg.kind === "tp.nudge") {
      void tick();
      reply({ pageId });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void tick();
  });
  chrome.runtime.sendMessage({ kind: "tp.ready" }).catch(() => {});
})();
