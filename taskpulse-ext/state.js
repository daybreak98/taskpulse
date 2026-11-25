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
      readRevision: revision(task), pending: false, phaseAt: 0,
      status: task.status === "attention" || (task.status === "stuck" && !task.runAt) ? "seen" : task.status
    };
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
      // The API can timestamp two different messages in the same second.
      // A distinct, previously unseen server message ID identifies the next
      // reply even when list and message timestamps have not advanced.
      return Boolean(message.messageId && task.lastAssistant && at === task.replyAt &&
        at >= (task.acked || 0) && at > (task.historyAt || 0));
    }
    return task.update > Math.max(task.acked, task.created, task.replyUpdate || 0);
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
    return !!task && !task.runAt && !task.messageUncertain &&
      task.status !== "running" && (!task.pending || verifiedReply(task));
  }

  function watchRows(rows, samples, tasks, now) {
    // The recent window is a discovery budget, not an eviction policy for work
    // already in flight. Persisted state also protects work after a leader change.
    return rows.filter((row, index) => {
      const sample = samples.get(row.id);
      const task = tasks?.[row.id];
      return index < timing.watch || queueBusy(sample?.queue) === true ||
        sample?.hotUntil > now || Boolean(task && task.agentId === (id(row.agentId) ||
          String(globalThis.TaskPulseWeb.api.body.agentIdList[0])) &&
          (task.runAt || task.awaitingReply || task.pending || task.messageUncertain));
    });
  }

  function applyQueue(task, at, busy, message) {
    let started = task.runAt || 0;
    if (started && task.observedAt && at - task.observedAt > STUCK) started = 0;
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

    // A cached pre-run message is not evidence of what happened after the run.
    if (message && task.awaitingReply && message.at < (task.lastBusyAt || started)) message = null;
    const needsEvidence = task.awaitingReply || started || task.messageUncertain ||
      task.update > Math.max(task.acked || 0, task.replyUpdate || 0, task.messageUpdate || 0);
    if (!message && needsEvidence) {
      task.messageUncertain = true;
      if (started) {
        task.settleUntil ||= at + SETTLE;
        task.status = "running";
      }
      // Keep the last verified reply and its watermark; an idle queue is not
      // evidence that the message endpoint successfully returned a reply.
      return;
    }
    if (message) {
      task.messageUpdate = task.update;
      task.messageObservedAt = message.at;
      task.messageUncertain = false;
    }
    const key = replyIdentity(task, message);
    const changed = newReply(task, message, key);
    if (changed) {
      task.replyKeys = [...new Set([...(task.replyKeys || []), task.replyKey, key].filter(Boolean))].slice(-32);
      task.replyKey = key;
      task.replyUpdate = task.update;
      task.replyAt = time(message.atMessage);
      task.lastAssistant = message.messageId || "";
      task.phaseAt = at;
      task.pending = true;
      task.failed = Boolean(message.failed);
    } else if (key && (key === task.replyKey || message.messageId && message.messageId === task.lastAssistant)) {
      if (task.pending && message.failed) task.failed = true;
    } else if (!task.replyKey && task.update <= Math.max(task.acked || 0, task.historyAt || 0) &&
               message?.sender === "assistant" && time(message.atMessage) <= Math.max(task.acked || 0, task.historyAt || 0) &&
               (!started || time(message.atMessage))) {
      task.lastAssistant = message.messageId || task.lastAssistant;
    }
    if (started && !changed && !task.pending) {
      task.settleUntil ||= at + SETTLE;
      if (at < task.settleUntil) {
        task.status = "running";
        return;
      }
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

    const state = { ...previous, at, error: text(report.error, 150), tasks: { ...previous.tasks } };
    const listAt = time(report.listAt);
    if (!listAt || listAt > at || listAt < previous.listAt || !Array.isArray(report.conversations)) {
      return { state, replies: [] };
    }
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
      if (old && update < old.update) continue;
      let task = {
        ...(old || { status: "seen", historyAt: baseline, acked: update > baseline ? Math.max(created, baseline) : update, observedAt: 0 }),
        id: cid, agentId, update, created, listedAt: listAt,
        name: text(row.name, 180) || "会话 " + cid, group: text(row.groupName, 80)
      };

      const sampleAt = time(report.queueAt?.[cid]);
      const busy = queueBusy(report.queues?.[cid]);
      const message = latestMessage(report, task, at);
      const errorAt = time(report.queueErrors?.[cid]);
      const freshQueue = busy !== null && sampleAt > task.observedAt && sampleAt <= at;
      const freshMessage = busy === false && sampleAt === task.observedAt && !task.queueError &&
        message && message.at >= sampleAt && message.at > (task.messageObservedAt || 0);
      if (freshQueue || freshMessage) {
        applyQueue(task, sampleAt, busy, message);
        if (freshQueue) task.queueError = false;
      } else if (task.update > Math.max(task.acked || 0, task.replyUpdate || 0, task.messageUpdate || 0) &&
                 !message && busy !== true) {
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
      if (now - task.listedAt > HISTORY) delete state.tasks[task.id];
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
      const uncertain = stale || task.queueError || task.messageUncertain || !task.observedAt || now - task.observedAt > timing.queueStale;
      if (!uncertain && Object.hasOwn(counts, task.status)) counts[task.status]++;
      tasks.push({ ...task, uncertain });
    }
    tasks.sort((a, b) => order[a.status] - order[b.status] || b.update - a.update);
    return { counts, tasks, stale, offline, error };
  }

  globalThis.TaskPulseState = { blank, absorb, view, revision, acknowledge, canAcknowledge, verifiedReply, queueBusy, watchRows, stuckMs: STUCK };
})();
