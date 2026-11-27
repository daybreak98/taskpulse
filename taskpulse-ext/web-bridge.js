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
  let trackedTasks = {};
  let opened = new Set();
  const readOpened = value => new Set(Array.isArray(value) ? value.map(web.id).filter(Boolean) : []);
  // Storage changes are event-driven; no extra polling or DataAgent request.
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[web.keys.opened]) return;
    opened = readOpened(changes[web.keys.opened].newValue);
  });
  let leaseGeneration = 0;
  let cacheGeneration = -1;
  let urgent = false;
  let activityUntil = 0;
  let lastHintAt = 0;
  const hints = new Map();
  let roundTimerDelay = 0;
  let lastUrl = location.href;
  const requestTimes = [];
  let pressureUntil = 0, pressureLevel = 0, pressureAt = 0, failureStreak = 0;
  const native = globalThis.TaskPulseNative?.observe(web);
  function budgetAvailable(now = Date.now(), slots = 1) {
    if (now < pressureUntil) return false;
    while (requestTimes.length && now - requestTimes[0] >= timing.budgetWindow) requestTimes.shift();
    return requestTimes.length + slots <= timing.requestBurst;
  }

  function retryAfter(response, now) {
    const raw = response?.headers?.get?.("Retry-After");
    if (!raw?.trim()) return 0;
    const value = raw.trim(), seconds = Number(value);
    const until = /^\d+(\.\d+)?$/.test(value) && Number.isFinite(seconds) ?
      now + Math.ceil(seconds * 1000) : Date.parse(value);
    return Number.isSafeInteger(until) && until > now ? until : 0;
  }

  async function pauseAll(response) {
    const at = Date.now();
    if (at - pressureAt > 10 * 60_000) pressureLevel = 0;
    const delay = Math.min(timing.pressureMax, timing.pressureBase * 2 ** pressureLevel);
    pressureLevel = Math.min(pressureLevel + 1, 4);
    pressureAt = at;
    pressureUntil = Math.max(pressureUntil, retryAfter(response, at),
      at + delay + Math.floor(Math.random() * delay * .2));
    failureStreak = 0;
    dirty = urgent = true;
    // Save the shared pause immediately, independently of report throttling.
    // The worker validates the current lease before accepting it.
    try {
      const result = await chrome.runtime.sendMessage({ kind: "tp.pressure", pageId, lease,
        at, until: pressureUntil, level: pressureLevel });
      if (result?.ok && Number.isSafeInteger(result.until))
        pressureUntil = Math.max(pressureUntil, result.until);
    } catch { /* Local pause still applies if the worker is unavailable. */ }
  }

  async function fetchInfo(path, deadline, init = {}) {
    const remaining = deadline - Date.now();
    const token = lease, generation = leaseGeneration;
    if (remaining <= 0 || !token || !budgetAvailable()) throw new Error("已暂停采集");
    requestTimes.push(Date.now());
    const url = new URL(path, location.origin);
    const finishOwn = native?.startOwn(url.href);
    const controller = new AbortController();
    request = controller;
    let timedOut = false, received = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(remaining, timing.request));
    try {
      const response = await fetch(url, {
        ...init, credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: controller.signal
      });
      received = true;
      if (token !== lease || generation !== leaseGeneration) throw new Error("采集租约已变更");
      if (!response.ok) {
        // Explicit throttling is global; an isolated 503 may only affect
        // one conversation. Consecutive 5xx failures also stop the source.
        if (response.status === 429 || response.status === 503 && retryAfter(response, Date.now())) {
          clearTimeout(timeout);
          await pauseAll(response);
        } else if (response.status >= 500 && ++failureStreak >= 2) {
          clearTimeout(timeout);
          await pauseAll(response);
        }
        else if (response.status < 500) failureStreak = 0;
        throw Object.assign(new Error("HTTP " + response.status), { httpStatus: response.status });
      }
      const data = await response.json();
      if (token !== lease || generation !== leaseGeneration) throw new Error("采集租约已变更");
      if (!data?.data || typeof data.data !== "object" || data.success === false || data.error_msg) {
        // Endpoint-level errors only; do not confuse reply text with an
        // overloaded status endpoint.
        if (typeof data?.error_msg === "string" &&
            /服务繁忙|请求过于频繁|too many requests|rate limit|tpm limit/i.test(data.error_msg)) {
          clearTimeout(timeout);
          await pauseAll(response);
        }
        throw new Error("DataAgent 返回无效数据");
      }
      failureStreak = 0;
      return data.data;
    } catch (failure) {
      if (token === lease && generation === leaseGeneration &&
          (timedOut || !received && failure?.name === "TypeError") && ++failureStreak >= 2) await pauseAll();
      throw failure;
    } finally {
      finishOwn?.();
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
    const oldRows = new Map(conversations.map(row => [row.id, row.updateTime]));
    conversations = [...found.values()].sort((a, b) => (b.updateTime || 0) - (a.updateTime || 0));
    listAt = Date.now();
    for (const row of conversations) {
      if (oldRows.has(row.id) && oldRows.get(row.id) !== row.updateTime ||
          !oldRows.has(row.id) && Number(row.updateTime) > listAt - timing.hotWindow) {
        hints.set(row.id, listAt + timing.hotWindow);
      }
    }
    dirty = true;
    const watched = new Set(TaskPulseState.watchRows(conversations, samples, trackedTasks, Date.now(), opened, hints).map(row => row.id));
    for (const map of [samples, messages, probes]) {
      for (const id of map.keys()) if (!watched.has(id)) map.delete(id);
    }
  }

  function accessDenied(failure, row) {
    return failure?.httpStatus === 401 || failure?.httpStatus === 403 ||
      row.retained && failure?.httpStatus === 404;
  }

  async function pullQueue(row, sample, deadline) {
    sample.checked = Date.now();
    const before = TaskPulseState.queueBusy(sample.queue);
    const hadError = !!sample.errorAt;
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
      sample.deniedAt = 0;
      const busy = TaskPulseState.queueBusy(sample.queue);
      if (busy) {
        sample.awaiting = true;
        sample.settleSince = 0;
      } else if (before === true) {
        sample.awaiting = true;
        sample.settleSince = sample.at;
      }
      if (before !== busy && (busy || before === true) || hadError) urgent = true;
    } catch (failure) {
      sample.errorAt = Date.now();
      if (!hadError) urgent = true;
      if (accessDenied(failure, row)) sample.deniedAt = sample.errorAt;
      return false;
    } finally {
      dirty = true;
    }
    return true;
  }

  function isHot(row, sample, now) {
    const task = trackedTasks[row.id];
    if (task?.accessDeniedAt && row.retained) return false;
    if (TaskPulseState.queueBusy(sample?.queue) === true) return true;
    const waiting = sample?.awaiting || task?.runAt || task?.awaitingReply;
    const recentWait = waiting && (!sample?.settleSince || now - sample.settleSince < timing.settleSlow);
    return Boolean(recentWait || (sample?.hotUntil || 0) > now || (hints.get(row.id) || 0) > now);
  }

  function fastWork(now) {
    return activityUntil > now || conversations.some(row => isHot(row, samples.get(row.id), now)) ||
      Object.values(trackedTasks).some(task => !task.accessDeniedAt && (task.runAt || task.awaitingReply) &&
        (!samples.get(task.id)?.settleSince || now - samples.get(task.id).settleSince < timing.settleSlow));
  }

  async function pullLastMessage(row, sample, deadline) {
    const updateTime = Number(row.updateTime) || 0;
    if (!updateTime || deadline - Date.now() < 250 || !budgetAvailable()) return;
    const previous = probes.get(row.id);
    const sameVersion = previous?.updateTime === updateTime;
    const stamp = Date.now();
    const task = trackedTasks[row.id];
    const waiting = Boolean(sample.awaiting || task?.awaitingReply || task?.runAt);
    if (waiting && !sample.settleSince) sample.settleSince = stamp;
    const elapsed = sample.settleSince ? stamp - sample.settleSince : 0;
    const delay = waiting ? elapsed < timing.settleFast ? timing.hot :
      elapsed < timing.settleSlow ? 5_000 : 15_000 : isHot(row, sample, stamp) ? timing.hot : 30_000;
    // A prior successful historical response may have installed a 30s
    // cooldown. An active task's completion fence always takes priority.
    const due = previous?.errorAt ? previous.nextAt :
      Math.min(previous?.nextAt || 0, (previous?.lastAt || 0) + delay);
    if (sameVersion && stamp < due) return;
    const failures = sameVersion ? previous.failures : 0;
    const probe = { updateTime, failures: failures + 1, deniedAt: previous?.deniedAt || 0,
      nextAt: Date.now() + Math.min(60_000, 10_000 * (2 ** Math.min(failures, 3))) };
    probes.set(row.id, probe);
    try {
      const data = await fetchInfo(api.prefix + api.messages.replace("{cid}", row.id), deadline);
      const latest = Array.isArray(data.list) && data.list[0];
      if (typeof latest?.sender !== "string") throw new Error("消息结构无效");
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
      const prior = messages.get(row.id);
      const changed = !prior || prior.messageId !== message.messageId ||
        prior.atMessage !== message.atMessage || prior.sender !== message.sender || prior.failed !== message.failed;
      const verifiedNew = TaskPulseState.isNewReply(task && { ...task, update: updateTime }, message);
      messages.set(row.id, message);
      if (verifiedNew) {
        sample.awaiting = false;
        sample.settleSince = 0;
        sample.hotUntil = Date.now() + timing.hotWindow;
        urgent = true;
      } else if (waiting && changed) urgent = true;
      probe.lastAt = message.at;
      probe.failures = 0;
      probe.errorAt = 0;
      probe.deniedAt = 0;
      probe.nextAt = Date.now() + (waiting && !verifiedNew ? delay :
        isHot(row, sample, Date.now()) ? timing.hot : sender === "assistant" ? 30_000 : 10_000);
      dirty = true;
    } catch (failure) {
      // Never reuse an older success as confirmation after a failed probe.
      messages.delete(row.id);
      probe.errorAt = Date.now();
      if (accessDenied(failure, row)) probe.deniedAt = probe.errorAt;
      dirty = true;
      // Keep retrying this version with the existing bounded backoff.
    }
  }

  async function report(token, generation) {
    const at = Date.now();
    const minInterval = urgent ? timing.urgentReport : timing.report;
    if (token !== lease || generation !== leaseGeneration || !alive() || at <= reportAt ||
        at - reportAt < minInterval || (!dirty && at - reportAt < timing.list)) return;
    reportAt = at;
    const queues = {}, queueAt = {}, queueErrors = {}, accessErrors = {};
    for (const [id, sample] of samples) {
      if (sample.at) {
        queues[id] = sample.queue;
        queueAt[id] = sample.at;
      }
      if (sample.errorAt) queueErrors[id] = sample.errorAt;
      if (sample.deniedAt) accessErrors[id] = sample.deniedAt;
    }
    for (const [id, probe] of probes) {
      if (probe.deniedAt) accessErrors[id] = Math.max(accessErrors[id] || 0, probe.deniedAt);
    }
    const accepted = await chrome.runtime.sendMessage({
      kind: "tp.webstate", pageId, lease: token,
      payload: { at, listAt, error, hidden: Boolean(document.hidden),
        conversations: TaskPulseState.reportRows(conversations, trackedTasks, at),
        queues, queueAt, queueErrors, accessErrors,
        lastMessages: Object.fromEntries(messages),
        messageErrors: Object.fromEntries([...probes].filter(([, probe]) => probe.errorAt).map(([id, probe]) => [id, probe.errorAt])) }
    });
    if (accepted?.ok && generation === leaseGeneration) { dirty = false; urgent = false; }
  }

  // Only a confirmed, unchanged, unopened and already-seen conversation
  // may use the long audit cadence. Preserve 60s for opened/unread/uncertain
  // rows and the existing fast paths for activity. Never extend freshness.
  function cold(row, sample) {
    const task = trackedTasks[row.id], probe = probes.get(row.id);
    return !row.retained && !opened.has(row.id) && !!task &&
      task.status === "seen" && !task.pending && !task.runAt && !task.awaitingReply &&
      !task.messageUncertain && !task.queueError && !task.listUncertain && !task.accessDeniedAt &&
      !sample.errorAt && !sample.awaiting && TaskPulseState.queueBusy(sample.queue) === false &&
      !!probe?.lastAt && probe.lastAt >= sample.at && !probe.errorAt &&
      Number(probe.updateTime) === Number(row.updateTime) &&
      Number(task.messageUpdate) === Number(row.updateTime) &&
      Number(task.update) === Number(row.updateTime) &&
      Number(task.agentId) === Number(row.agentId || api.body.agentIdList[0]);
  }

  function dueAt(now) {
    return TaskPulseState.watchRows(conversations, samples, trackedTasks, now, opened, hints).map(row => {
      let sample = samples.get(row.id);
      if (!sample) {
        sample = { checked: 0, firstDue: now, version: row.updateTime, hotUntil: 0 };
        samples.set(row.id, sample);
      } else if (row.updateTime && row.updateTime !== sample.version) {
        sample.version = row.updateTime;
        sample.hotUntil = now + timing.hotWindow;
      }
      return { row, sample };
    }).filter(({ row, sample }) => {
      const task = trackedTasks[row.id];
      const hot = isHot(row, sample, now);
      // An absent row with a failing endpoint may have been removed. Do not
      // continuously spend the hot budget on it while waiting for recovery.
      const probe = probes.get(row.id);
      // Retry a failed message request at its existing backoff deadline even
      // when the conversation has otherwise fallen out of the hot set.
      if (!row.retained && probe?.errorAt && now >= probe.nextAt && now - sample.checked >= timing.hot) return true;
      const interval = row.retained && sample.errorAt ? timing.idle :
        hot ? (sample.settleSince && now - sample.settleSince >= timing.settleFast && sample.awaiting ? 5_000 : timing.hot) :
        task?.messageUncertain || sample.awaiting || task?.awaitingReply ? 15_000 :
        cold(row, sample) ? timing.coldIdle : timing.idle;
      return now - sample.checked >= interval;
    }).sort((a, b) => {
      const priority = ({ row, sample }) => isHot(row, sample, now) ? 2 : opened.has(row.id) ? 1 : 0;
      const oldest = item => item.sample.checked || item.sample.firstDue;
      const overdue = item => now - oldest(item) >=
        (cold(item.row, item.sample) && !isHot(item.row, item.sample, now) ? timing.coldIdle + timing.idle : timing.idle * 2) ? 1 : 0;
      // Even a saturated hot/open set cannot indefinitely starve a cold row.
      // Once overdue, oldest service wins before normal priority.
      return overdue(b) - overdue(a) ||
        (overdue(a) && overdue(b) ? oldest(a) - oldest(b) : 0) ||
        priority(b) - priority(a) || a.sample.checked - b.sample.checked;
    }).slice(0, timing.queueBudget);
  }

  async function tick() {
    if (collecting || !lease || !alive() || !web.conversationPage(location.href)) return;
    collecting = true;
    const token = lease, generation = leaseGeneration;
    const deadline = Date.now() + timing.round;
    try {
      // A revoked/reacquired collector must not relabel old cached samples
      // with its new lease. An in-flight prior tick finishes before this reset.
      if (cacheGeneration !== generation) {
        cacheGeneration = generation;
        samples.clear();
        messages.clear();
        probes.clear();
        conversations = [];
        listAt = 0;
        nextListAt = 0;
        reportAt = 0;
        error = "";
        dirty = true;
        urgent = false;
        hints.clear();
        // Read browser membership once per collector lease; changes thereafter
        // arrive through storage events. Do not overwrite a newer event.
        const before = opened;
        const savedOpened = await chrome.storage.local.get(web.keys.opened).catch(() => null);
        if (opened === before && savedOpened) opened = readOpened(savedOpened[web.keys.opened]);
      }
      // Read the durable monitoring set on every round, including after a
      // collector handoff. Old active/uncertain tasks retain their queue slots.
      const saved = await chrome.storage.local.get(web.keys.state).catch(() => null);
      if (saved) {
        const durable = saved[web.keys.state];
        trackedTasks = durable?.tasks || {};
        if (durable?.pressureUntil > pressureUntil) pressureUntil = durable.pressureUntil;
        if (durable?.pressureAt >= pressureAt) {
          pressureAt = durable.pressureAt;
          pressureLevel = Math.min(4, Math.max(0, durable.pressureLevel || 0));
        }
      }
      if (token !== lease || generation !== leaseGeneration) return;
      const stamp = Date.now();
      if (stamp < pressureUntil) return;
      for (const [cid, until] of hints) if (until <= stamp) hints.delete(cid);
      const listInterval = fastWork(stamp) && !error ? timing.activeList : timing.list;
      const dueList = error ? nextListAt : listAt ? Math.min(nextListAt, listAt + listInterval) : nextListAt;
      if (stamp >= dueList && budgetAvailable(stamp)) {
        // Retry failed lists at the existing slow cadence.
        nextListAt = stamp + listInterval;
        await pullList(deadline);
        error = "";
      }
      if (!error) {
        const due = dueAt(Date.now());
        for (let index = 0; index < due.length; index++) {
          const { row, sample } = due[index];
          if (token !== lease || generation !== leaseGeneration || deadline - Date.now() < 250 || !budgetAvailable()) break;
          // Any queue can turn idle. Reserve the accompanying message slot
          // before beginning, including first discovery; otherwise a row
          // aligned with the periodic list could miss every message audit.
          if (!budgetAvailable(Date.now(), 2)) break;
          const wasBusy = TaskPulseState.queueBusy(sample.queue) === true;
          if (await pullQueue(row, sample, deadline) && token === lease && generation === leaseGeneration &&
              TaskPulseState.queueBusy(sample.queue) === false) {
            if (wasBusy && probes.has(row.id)) probes.get(row.id).nextAt = 0;
            await pullLastMessage(row, sample, deadline);
          }
          // A verified hot-task change must not wait behind slow cold rows.
          // The first list still publishes a coherent initial snapshot.
          if (urgent && reportAt && index + 1 < due.length && Date.now() - reportAt >= timing.urgentReport)
            await report(token, generation);
        }
      }
    } catch (failure) {
      if (error !== failure.message) { dirty = true; urgent = true; }
      error = failure.name === "AbortError" ? "会话列表请求超时" : String(failure.message).slice(0, 150);
      // Do not carry old authenticated queue/message observations across a
      // failed list request. Recovery still uses the same normal poll budget.
      samples.clear();
      messages.clear();
      probes.clear();
      nextListAt = Date.now() + timing.list;
    } finally {
      try { await report(token, generation); } catch { /* An extension reload can invalidate this page. */ }
      collecting = false;
      if (token === lease && generation === leaseGeneration && token) configureTimer();
    }
  }

  function configureTimer() {
    const now = Date.now();
    const delay = now < pressureUntil ? Math.min(timing.list, Math.max(timing.idleTick, pressureUntil - now)) :
      fastWork(now) && !error ? timing.tick : timing.idleTick;
    if (timer !== null && roundTimerDelay === delay) return;
    if (timer !== null) clearInterval(timer);
    roundTimerDelay = delay;
    timer = setInterval(tick, delay);
  }

  function hint(cid) {
    const stamp = Date.now();
    activityUntil = stamp + timing.hotWindow;
    if (web.id(cid)) hints.set(cid, activityUntil);
    if (lease) {
      configureTimer();
      void tick();
    }
  }

  function pageActivity(event) {
    if (event && !event.isTrusted || document.hidden || !web.conversationPage(location.href)) return;
    const stamp = Date.now();
    if (stamp - lastHintAt < 3_000 && location.href === lastUrl) return;
    lastHintAt = stamp;
    lastUrl = location.href;
    const cid = web.conversationId(location.href);
    hint(cid);
    // No user input or message content is collected. A non-leader tab
    // only forwards the conversation ID to the single active collector.
    chrome.runtime.sendMessage({ kind: "tp.activity", cid }).catch(() => {});
  }

  function setRole(token) {
    if (token === lease) return;
    lease = token;
    leaseGeneration++;
    if (timer !== null) clearInterval(timer);
    request?.abort();
    timer = null;
    if (token) {
      // A new lease refreshes immediately. A stable leader keeps the existing caches.
      nextListAt = 0;
      dirty = true;
      configureTimer();
      void tick();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind === "tp.probe" && web.conversationPage(location.href))
      reply({ pageId, lease, nativeObservation: native?.snapshot() });
    if (msg?.pageId !== pageId) return;
    if (msg.kind === "tp.role") {
      setRole(msg.lease || "");
      reply({ pageId });
    }
    if (msg.kind === "tp.nudge") {
      if (msg.activity) hint(msg.cid);
      else void tick();
      reply({ pageId });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (lease) chrome.runtime.sendMessage({ kind: "tp.visibility", pageId, lease, hidden: Boolean(document.hidden) }).catch(() => {});
    if (!document.hidden) pageActivity();
  });
  document.addEventListener("pointerdown", pageActivity, { capture: true, passive: true });
  document.addEventListener("keydown", pageActivity, { capture: true, passive: true });
  globalThis.addEventListener?.("popstate", pageActivity);
  chrome.runtime.sendMessage({ kind: "tp.ready" }).catch(() => {});
})();
