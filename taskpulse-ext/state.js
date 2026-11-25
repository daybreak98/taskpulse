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
    return [task.id, task.agentId, task.update, task.replyKey || "-"].join("/");
  }

  function acknowledge(task) {
    return {
      ...task, acked: task.update, pending: false, phaseAt: 0,
      status: task.status === "attention" || (task.status === "stuck" && !task.runAt) ? "seen" : task.status
    };
  }

  function latestMessage(report, task, stamp) {
    const message = report.lastMessages?.[task.id];
    if (!message || time(message.updateTime) !== task.update ||
        !time(message.at) || time(message.at) > stamp) return null;
    return message;
  }

  function assistantEvidence(task, message) {
    const at = time(message?.atMessage);
    return message?.sender === "assistant" &&
      (!at || (at > task.acked && at >= task.update - 5_000));
  }

  function queueBusy(queue, api = globalThis.TaskPulseWeb.api) {
    const raw = queue?.[api.state];
    if (raw === undefined || raw === null || raw === "") return null;
    const pending = queue[api.pending];
    return (Array.isArray(pending) ? pending.length > 0 : Boolean(pending)) || !api.idle.includes(raw);
  }

  function applyQueue(task, at, busy, message) {
    let started = task.runAt || 0;
    if (started && task.observedAt && at - task.observedAt > STUCK) started = 0;
    task.observedAt = at;

    if (busy) {
      if (!started) {
        task.phaseAt = at;
        task.awaitList = false;
        task.failed = false;
      }
      task.runAt = started || at;
      task.idleAt = 0;
      task.settleUntil = 0;
      task.pending = false;
      task.status = at - task.phaseAt >= STUCK ? "stuck" : "running";
      return;
    }

    const assistant = assistantEvidence(task, message);
    const newAssistant = assistant && (!message.messageId || message.messageId !== task.lastAssistant);
    const newer = task.update > task.acked && task.update > task.created;
    let key = "";
    if (started) {
      task.idleAt ||= at;
      const longRun = task.idleAt - started >= 20_000;
      if ((newer || longRun) && (!message || newAssistant)) key = "run." + started;
      if (!key) {
        task.settleUntil ||= at + SETTLE;
        if (at < task.settleUntil) {
          task.status = "running";
          return;
        }
      }
    } else if (task.replyKey && (task.update <= task.completedAt || task.update === task.replyUpdate || task.awaitList)) {
      if (task.pending) key = task.replyKey;
      // A list update can arrive after we inferred the same reply from the run.
      if (task.awaitList && newer && (assistant || task.notified === task.replyKey)) {
        task.awaitList = false;
        if (!task.pending) task.acked = task.update;
      }
    } else if (newer && newAssistant) {
      key = "update." + task.update;
    }

    task.runAt = 0;
    task.idleAt = 0;
    task.settleUntil = 0;
    if (!key) {
      task.status = "seen";
      task.pending = false;
      task.phaseAt = 0;
      return;
    }

    if (started) {
      task.completedAt = at;
      task.awaitList = !newer;
    }
    if (!task.pending || task.replyKey !== key) {
      task.phaseAt = at;
      task.failed = false;
    }
    task.replyKey = key;
    task.replyUpdate = task.update;
    task.pending = true;
    if (assistant) task.failed = Boolean(message.failed);
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
        ...(old || { status: "seen", acked: created >= baseline ? 0 : update, observedAt: 0 }),
        id: cid, agentId, update, created, listedAt: listAt,
        name: text(row.name, 180) || "会话 " + cid, group: text(row.groupName, 80)
      };

      const sampleAt = time(report.queueAt?.[cid]);
      const busy = queueBusy(report.queues?.[cid]);
      const message = latestMessage(report, task, at);
      if (busy !== null && sampleAt > task.observedAt && sampleAt <= at) {
        applyQueue(task, sampleAt, busy, message);
        // A new assistant message can arrive before the list timestamp catches up.
        // While a run is settling, the current list version is still historical.
        if (busy === false && message?.sender === "assistant" && task.status === "seen" &&
            update <= task.acked && time(message.atMessage) <= task.acked) {
          task.lastAssistant = message.messageId || task.lastAssistant;
        }
      }
      task.queueError = time(report.queueErrors?.[cid]) > task.observedAt;
      const confirmed = !state.error && !task.queueError &&
        now - listAt <= timing.sourceStale && now - task.observedAt <= timing.queueStale;
      if (task.pending && confirmed && task.notified !== task.replyKey) {
        if (cid === activeId && task.status === "attention") {
          task = acknowledge(task);
          task.lastAssistant = message?.messageId || task.lastAssistant;
        } else if (update > task.acked && assistantEvidence(task, message) &&
                   (!message.messageId || message.messageId !== task.lastAssistant) &&
                   !task.runAt && busy === false) {
          task.notified = task.replyKey;
          task.lastAssistant = message.messageId || task.lastAssistant;
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
      const uncertain = stale || task.queueError || !task.observedAt || now - task.observedAt > timing.queueStale;
      if (!uncertain && Object.hasOwn(counts, task.status)) counts[task.status]++;
      tasks.push({ ...task, uncertain });
    }
    tasks.sort((a, b) => order[a.status] - order[b.status] || b.update - a.update);
    return { counts, tasks, stale, offline, error };
  }

  globalThis.TaskPulseState = { blank, absorb, view, revision, acknowledge, queueBusy, stuckMs: STUCK };
})();
