// WEB state shared by the worker and capsule. The timing and reply phases follow poller.py.
(() => {
  const { id, timing } = globalThis.TaskPulseWeb;
  const STUCK = 30 * 60_000;
  const SETTLE = 90_000;
  const HISTORY = 7 * 24 * 60 * 60_000;
  const order = { attention: 0, stuck: 1, running: 2, seen: 3 };
  const time = value => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  };
  const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

  function blank() {
    return { at: 0, listAt: 0, baselineAt: 0, error: "", tasks: {} };
  }

  function revision(task) {
    return [task.id, task.agentId, task.replyUpdate || task.update, task.replyKey || "-"].join("/");
  }

  function acknowledge(task) {
    return {
      ...task, acked: Math.max(task.acked || 0, task.replyAt || task.replyUpdate || 0),
      readRevision: revision(task),
      readKeys: [...new Set([...(task.readKeys || []), ...(task.replyKeys || []), task.replyKey].filter(Boolean))].slice(-64),
      pending: false, phaseAt: 0,
      status: task.status === "attention" || (task.status === "stuck" && !task.runAt) ? "seen" : task.status
    };
  }

  function mayDismissNotice(result) {
    return result?.ok === true && result.clearNotice !== false;
  }

  function latestMessage(report, task, stamp) {
    const message = report.lastMessages?.[task.id];
    if (!message || time(message.updateTime) !== task.update ||
        !time(message.at) || time(message.at) > stamp ||
        time(report.messageErrors?.[task.id]) >= time(message.at) ||
        !["assistant", "other"].includes(message.sender)) return null;
    return message;
  }

  function replyIdentity(task, message) {
    if (message?.sender !== "assistant") return "";
    if (message.messageId) return "message." + encodeURIComponent(String(message.messageId).toWellFormed());
    const at = time(message.atMessage);
    return at ? "time." + at : "update." + task.update;
  }

  function newReply(task, message, key) {
    if (!key || key === task.replyKey || task.replyKeys?.includes(key) ||
        message.messageId && message.messageId === task.lastAssistant) return false;
    const at = time(message.atMessage);
    if (at) {
      if (at > Math.max(task.acked || 0, task.replyAt || 0, task.historyAt || 0)) return true;
      return Boolean(message.messageId && task.lastAssistant && at === task.replyAt &&
        at >= (task.acked || 0) && at > (task.historyAt || 0));
    }
    // A changed server ID from the latest-message endpoint is independent
    // evidence even if the list clock has not advanced. Require an observed
    // predecessor or a new list version; the first historical probe is silent.
    if (message.messageId && (task.lastAssistant || task.lastUserMessage) &&
        message.at > (task.messageObservedAt || 0) &&
        (task.replyKey || task.awaitingReply || task.update > Math.max(task.historyAt || 0, task.created || 0) ||
         task.lastUserMessage && task.messageUpdate > (task.historyAt || 0))) return true;
    return task.update > Math.max(task.acked || 0, task.created || 0, task.replyUpdate || 0, task.historyAt || 0);
  }

  function rememberAssistant(task, key, message, latest = true) {
    if (!key) return;
    task.replyKeys = [...new Set([...(task.replyKeys || []), task.replyKey, key].filter(Boolean))].slice(-32);
    if (latest && message.messageId) task.lastAssistant = message.messageId;
  }

  function queueBusy(queue, api = globalThis.TaskPulseWeb.api) {
    const raw = queue?.[api.state];
    if (raw === undefined || raw === null || raw === "") return null;
    const pending = queue[api.pending];
    return (Array.isArray(pending) ? pending.length > 0 : Boolean(pending)) || !api.idle.includes(raw);
  }

  function verifiedReply(task) {
    return /^(message|time|update)\./.test(task.replyKey || "");
  }

  function canAcknowledge(task) {
    return !!task && !task.runAt && !task.awaitingReply && !task.messageUncertain &&
      !task.queueError && !task.listUncertain &&
      task.status !== "running" && (!task.pending || verifiedReply(task));
  }

  function activeTask(task) {
    return Boolean(task && (task.runAt || task.awaitingReply || task.pending || task.messageUncertain));
  }

  // A bounded list is not proof that an already observed task was deleted.
  // Retain known active tasks for the existing seven-day history window and
  // let fresh per-ID queue/message evidence, not old list data, confirm them.
  function reportRows(rows, tasks, now) {
    const known = new Set(rows.map(row => row.id));
    const retained = Object.values(tasks || {}).filter(task =>
      id(task.id) && id(task.agentId) && !known.has(task.id) && activeTask(task) &&
      time(task.realListedAt || task.listedAt) && now - (task.realListedAt || task.listedAt) <= HISTORY
    ).map(task => ({
      id: task.id, agentId: task.agentId, name: task.name, groupName: task.group,
      updateTime: task.update, createTime: task.created, retained: true
    }));
    return [...rows, ...retained];
  }

  function watchRows(rows, samples, tasks, now) {
    return reportRows(rows, tasks, now).filter((row, index) => {
      const sample = samples.get(row.id);
      const task = tasks?.[row.id];
      return row.retained || index < timing.watch || queueBusy(sample?.queue) === true ||
        sample?.hotUntil > now || Boolean(task && task.agentId === (id(row.agentId) ||
          String(globalThis.TaskPulseWeb.api.body.agentIdList[0])) && activeTask(task));
    });
  }

  function applyQueue(task, at, busy, message, messageError = false) {
    let started = task.runAt || 0;
    if (started && task.observedAt && at - task.observedAt > STUCK && busy) started = 0;
    task.observedAt = at;

    if (busy) {
      task.runAt = started || at;
      task.awaitingReply = true;
      task.lastBusyAt = at;
      task.messageUncertain = false;
      task.settleUntil = 0;
      task.status = at - task.runAt >= STUCK ? "stuck" : "running";
      return;
    }

    // A cached pre-run message is not evidence about the current run.
    if (message && task.awaitingReply && message.at < (task.lastBusyAt || started)) message = null;
    const waiting = Boolean(task.awaitingReply || started);
    const needsEvidence = waiting || task.messageUncertain || messageError ||
      task.update > Math.max(task.acked || 0, task.replyUpdate || 0, task.messageUpdate || 0);
    if (!message && needsEvidence) {
      task.messageUncertain = true;
      if (waiting) {
        task.settleUntil ||= at + SETTLE;
        task.status = "running";
      }
      return;
    }
    const key = replyIdentity(task, message);
    // Evaluate against the previous observation BEFORE advancing its watermark.
    const changed = newReply(task, message, key);
    if (message) {
      task.messageUpdate = task.update;
      task.messageObservedAt = message.at;
      task.messageUncertain = false;
      if (message.sender === "other" && message.messageId) task.lastUserMessage = message.messageId;
    }
    if (changed) {
      rememberAssistant(task, key, message);
      task.replyKey = key;
      task.replyUpdate = task.update;
      task.replyAt = time(message.atMessage);
      task.phaseAt = at;
      task.pending = true;
      task.failed = Boolean(message.failed);
    } else if (key && (key === task.replyKey || message.messageId && message.messageId === task.lastAssistant)) {
      if (task.pending && message.failed) task.failed = true;
    } else if (key && !task.replyKey && task.update <= Math.max(task.acked || 0, task.historyAt || 0) &&
               time(message.atMessage) <= Math.max(task.acked || 0, task.historyAt || 0) &&
               (!started || time(message.atMessage) || !message.atMessage)) {
      rememberAssistant(task, key, message);
    } else if (key && message.messageId) {
      // A previously rejected (older) server ID remains rejected if a later
      // response omits its timestamp. Do not advance the current assistant.
      rememberAssistant(task, key, message, false);
    }

    // Previous unread A and current run B are independent. A successful read
    // of A (or a user message) cannot settle B. Keep monitoring after SETTLE,
    // but expose uncertainty instead of inventing a completed/seen state.
    if (waiting && !changed) {
      task.settleUntil ||= at + SETTLE;
      task.status = "running";
      task.awaitingReply = true;
      if (at >= task.settleUntil) task.messageUncertain = true;
      return;
    }

    task.runAt = 0;
    task.awaitingReply = false;
    task.settleUntil = 0;
    if (!task.pending) {
      task.status = "seen";
      task.phaseAt = 0;
      return;
    }
    task.status = task.failed || at - task.phaseAt >= STUCK ? "stuck" : "attention";
  }

  function absorb(previous, report, now, activeId = "") {
    const at = time(report?.at);
    if (!at || at > now + 5_000 || at <= previous.at) return { state: previous, replies: [] };

    const state = { ...previous, at, tasks: { ...previous.tasks } };
    const listAt = time(report.listAt);
    const reportError = text(report.error, 150);
    if (!listAt || listAt > at || listAt < previous.listAt || !Array.isArray(report.conversations)) {
      state.error = reportError || previous.error || "会话列表状态待确认";
      return { state, replies: [] };
    }
    // A cached successful list cannot prove recovery from a later failure.
    state.error = reportError || (listAt === previous.listAt ? previous.error : "") || "";
    const baseline = state.baselineAt ||= listAt;
    state.listAt = listAt;
    const replies = [];
    const seen = new Set();

    for (const row of report.conversations) {
      const cid = id(row?.id);
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const agentId = id(row.agentId) || String(globalThis.TaskPulseWeb.api.body.agentIdList[0]);
      const update = time(row.updateTime);
      const created = time(row.createTime);
      const old = state.tasks[cid]?.agentId === agentId ? state.tasks[cid] : null;
      const retained = row.retained === true;
      if (retained && (!old || !activeTask(old) || now - (old.realListedAt || old.listedAt) > HISTORY)) continue;
      if (old && update < old.update) {
        // Keep the previous version visible but unconfirmable on a regressed row.
        state.tasks[cid] = { ...old, listedAt: listAt, listUncertain: true };
        continue;
      }
      let task = {
        ...(old || { status: "seen", historyAt: baseline, acked: update > baseline ? Math.max(created, baseline) : update, observedAt: 0 }),
        id: cid, agentId, update, created, listedAt: listAt,
        realListedAt: retained ? (old.realListedAt || old.listedAt) : listAt,
        retained, listUncertain: false,
        name: text(row.name, 180) || "会话 " + cid, group: text(row.groupName, 80)
      };

      const sampleAt = time(report.queueAt?.[cid]);
      const busy = queueBusy(report.queues?.[cid]);
      const message = latestMessage(report, task, at);
      const errorAt = time(report.queueErrors?.[cid]);
      const messageErrorAt = time(report.messageErrors?.[cid]);
      const messageError = !!messageErrorAt && messageErrorAt >= (task.messageObservedAt || 0) &&
        (!message || messageErrorAt >= message.at);
      const freshQueue = busy !== null && sampleAt > task.observedAt && sampleAt <= at;
      const freshMessage = busy === false && sampleAt === task.observedAt && !task.queueError &&
        message && message.at >= sampleAt && message.at > (task.messageObservedAt || 0);
      if (freshQueue || freshMessage) {
        applyQueue(task, sampleAt, busy, message, messageError);
        if (freshQueue) task.queueError = false;
      } else if (busy !== true && (messageError ||
          (task.update > Math.max(task.acked || 0, task.replyUpdate || 0, task.messageUpdate || 0) && !message))) {
        task.messageUncertain = true;
      }
      if (errorAt > task.observedAt) task.queueError = true;
      const confirmed = !state.error && !task.queueError && task.observedAt &&
        now - listAt <= timing.sourceStale && now - task.observedAt <= timing.queueStale;
      if (task.pending && verifiedReply(task) && confirmed && canAcknowledge(task)) {
        if (cid === activeId && task.status === "attention") {
          // Auto-read must also apply to a reply that has already been notified.
          task = acknowledge(task);
        } else if (task.notified !== task.replyKey) {
          task.notified = task.replyKey;
          replies.push(task);
        }
      }
      state.tasks[cid] = task;
    }

    for (const task of Object.values(state.tasks)) {
      if (now - (task.realListedAt || task.listedAt) > HISTORY) delete state.tasks[task.id];
    }
    return { state, replies };
  }

  function view(state, now) {
    const offline = !state.at || now - state.at > timing.sourceStale;
    const error = state.error || "";
    const stale = offline || !!error || !state.listAt || now - state.listAt > timing.sourceStale;
    const counts = { running: 0, attention: 0, stuck: 0 };
    const tasks = [];
    for (const task of Object.values(state.tasks)) {
      if (task.listedAt !== state.listAt) continue;
      const uncertain = stale || task.listUncertain || task.queueError || task.messageUncertain || !task.observedAt || now - task.observedAt > timing.queueStale;
      if (!uncertain && Object.hasOwn(counts, task.status)) counts[task.status]++;
      tasks.push({ ...task, uncertain });
    }
    tasks.sort((a, b) => order[a.status] - order[b.status] || b.update - a.update);
    return { counts, tasks, stale, offline, error };
  }

  globalThis.TaskPulseState = { blank, absorb, view, revision, acknowledge, mayDismissNotice, canAcknowledge, verifiedReply, queueBusy, watchRows, reportRows, stuckMs: STUCK };
})();
