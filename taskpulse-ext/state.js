// WEB state shared by the worker and capsule. The timing and reply phases follow poller.py.
(() => {
  const { id, timing } = globalThis.TaskPulseWeb;
  const STUCK = 30 * 60_000;
  const SETTLE = 90_000;
  const HISTORY = 7 * 24 * 60 * 60_000;
  const DISPLAY_HISTORY = 24 * 60 * 60_000;
  // Keep delivery reliability independent from the display preference.
  const NOTICE_HISTORY = 48 * 60 * 60_000;
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

  // A reply may arrive before the list endpoint catches up. Its own
  // timestamp (or observation time for an undated verified reply) already
  // covers that activity. The later list watermark is not a second event.
  function displayUpdate(task) {
    return Math.max(task.update || 0, task.userActivityAt || 0,
      task.replyKey ? (task.replyAt || task.replyActivityAt || 0) : 0);
  }

  // Raw lastUserMessage is a collector watermark, not proof of new activity.
  function displayVersion(task) {
    return JSON.stringify([task.id, task.agentId, task.created || 0, displayUpdate(task),
      task.replyKey || "", task.runCycleAt || task.runAt || 0, task.userActivityAt || 0]);
  }

  function isDismissed(task) {
    if (task.dismissedVersion) {
      const current = displayVersion(task);
      if (task.dismissedVersion === current) return true;
      // Upgrade old display tickets without reopening an already covered
      // list watermark or changing any reply, run or user-activity identity.
      try {
        const old = JSON.parse(task.dismissedVersion);
        if (!Array.isArray(old) || old.length !== 7) return false;
        if (typeof old[6] === "string") {
          if (task.userActivityAt) return false;
          old[6] = 0;
        }
        const covered = Math.max(task.userActivityAt || 0,
          task.replyKey ? (task.replyAt || task.replyActivityAt || 0) : 0);
        if (old[3] <= covered && task.update <= covered) old[3] = covered;
        return JSON.stringify(old) === current;
      } catch { return false; }
    }
    // Migrate the old checkbox's persistent marker without hiding a new run.
    return Boolean(task.checkedRevision && task.checkedRevision === revision(task) &&
      !task.runAt && !task.awaitingReply && (!task.replyUpdate ||
        task.update <= Math.max(task.replyUpdate, task.replyAt || 0, task.replyActivityAt || 0)));
  }

  function lastActivity(task) {
    // Polling timestamps are not conversation activity.
    return Math.max(task.created || 0, task.update || 0, task.replyAt || 0,
      task.runCycleAt || task.runAt || 0, task.replyActivityAt || 0, task.userActivityAt || 0);
  }

  function recentActivity(task, now) {
    const activity = lastActivity(task);
    return activity > 0 && now - activity <= DISPLAY_HISTORY;
  }

  function recentNoticeActivity(task, now) {
    const activity = lastActivity(task);
    return activity > 0 && now - activity <= NOTICE_HISTORY;
  }

  function canDismiss(state, task, now) {
    if (!taskAccessible(state, task) || task.listedAt !== state.listAt ||
        !recentActivity(task, now) || isDismissed(task)) return false;
    const uncertain = !taskFresh(state, task, now) || task.messageUncertain;
    return Boolean(uncertain || (!task.runAt && !task.awaitingReply && task.status !== "running"));
  }

  function dismiss(task, now = Date.now()) {
    return { ...task, dismissedVersion: displayVersion(task),
      dismissedNoticeRevision: revision(task), dismissedAt: now };
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

  function authError(error) {
    return /^HTTP (401|403)(?:\b|$)/.test(error || "");
  }

  // A bounded list can omit an old task. Its prior title and queue state
  // are not proof that the current login still has access to that task.
  function evidenceFloor(state, task) {
    return Math.max(state.revalidateAfter || 0, task?.retained ? task.retainedSince || 0 : 0);
  }

  function taskAccessible(state, task) {
    return !!task && !state.authBlocked && !authError(state.error) && !task.accessDeniedAt &&
      (!task.retained || task.observedAt >= evidenceFloor(state, task));
  }

  function taskFresh(state, task, now) {
    return taskAccessible(state, task) && !state.sourceUnavailable && !state.error && state.at &&
      now - state.at <= timing.sourceStale && state.listAt && now - state.listAt <= timing.sourceStale &&
      task.listedAt === state.listAt && !task.listUncertain && !task.queueError && task.observedAt &&
      task.observedAt >= evidenceFloor(state, task) && now - task.observedAt <= timing.queueStale;
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

  function isNewReply(task, message) {
    return !!task && newReply(task, message, replyIdentity(task, message));
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
      !task.queueError && !task.listUncertain && !task.accessDeniedAt &&
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
      id(task.id) && id(task.agentId) && !known.has(task.id) && activeTask(task) && !task.accessDeniedAt &&
      time(task.realListedAt || task.listedAt) && now - (task.realListedAt || task.listedAt) <= HISTORY
    ).map(task => ({
      id: task.id, agentId: task.agentId, name: task.name, groupName: task.group,
      updateTime: task.update, createTime: task.created, retained: true
    }));
    return [...rows, ...retained];
  }

  function watchRows(rows, samples, tasks, now, opened = new Set(), hints = new Map()) {
    return reportRows(rows, tasks, now).filter((row, index) => {
      const sample = samples.get(row.id);
      const known = tasks?.[row.id];
      const task = known?.agentId === (id(row.agentId) ||
        String(globalThis.TaskPulseWeb.api.body.agentIdList[0])) ? known : null;
      const recent = recentActivity({ created: time(row.createTime), update: time(row.updateTime) }, now) ||
        Boolean(task && recentActivity(task, now));
      // The old 24-row discovery floor is retained, but it is no longer
      // a ceiling. All recent rows and explicit browser activity enter
      // the existing bounded scheduler; no extra list/API pagination.
      return row.retained || index < timing.watch || recent || opened.has(row.id) ||
        (hints.get(row.id) || 0) > now || queueBusy(sample?.queue) === true ||
        sample?.hotUntil > now || activeTask(task);
    });
  }

  function applyQueue(task, at, busy, message, messageError = false) {
    let started = task.runAt || 0;
    if (started && task.observedAt && at - task.observedAt > STUCK && busy) started = 0;
    task.observedAt = at;

    if (busy) {
      task.runCycleAt = task.runAt ? (task.runCycleAt || task.runAt) : at;
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
      if (message.sender === "other") {
        const stamp = time(message.atMessage);
        // A user message needs its own server timestamp, newer than both
        // known activity and the dismissal. Merely observing an ID later
        // does not prove that the user actually sent a new message.
        const floor = Math.max(task.created || 0, task.update || 0, task.replyAt || 0,
          task.replyActivityAt || 0, task.runCycleAt || task.runAt || 0,
          task.userActivityAt || 0, task.dismissedAt || 0);
        if (stamp > floor && stamp <= message.at + 5_000 &&
            (!message.messageId || message.messageId !== task.lastUserMessage)) task.userActivityAt = stamp;
        if (message.messageId) task.lastUserMessage = message.messageId;
      }
    }
    if (changed) {
      rememberAssistant(task, key, message);
      task.replyKey = key;
      task.replyUpdate = task.update;
      task.replyAt = time(message.atMessage);
      task.replyActivityAt = task.replyAt || at;
      // Verification belongs to this exact reply, not its predecessor.
      task.replyVerifiedAt = 0;
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
      state.authBlocked = Boolean(previous.authBlocked || authError(state.error));
      state.revalidateAfter = Math.max(previous.revalidateAfter || 0, at);
      return { state, replies: [] };
    }
    // A cached list cannot prove recovery from a later failure or a retired
    // collector. Keep its evidence fence even after a fresh list arrives.
    const recoveredList = !reportError && listAt > previous.listAt &&
      listAt >= (previous.revalidateAfter || 0);
    state.error = reportError || (!recoveredList ? previous.error : "") || "";
    state.authBlocked = Boolean(authError(state.error) || previous.authBlocked && !recoveredList);
    state.sourceUnavailable = Boolean(previous.sourceUnavailable && !recoveredList);
    if (state.error) state.revalidateAfter = Math.max(previous.revalidateAfter || 0, at);
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
      if (retained && (!old || !activeTask(old) || old.accessDeniedAt ||
          now - (old.realListedAt || old.listedAt) > HISTORY)) continue;
      if (old && update < old.update) {
        // Keep the previous version visible but unconfirmable on a regressed row.
        state.tasks[cid] = { ...old, listedAt: listAt, listUncertain: true };
        continue;
      }
      let task = {
        ...(old || { status: "seen", historyAt: baseline, acked: update > baseline ? Math.max(created, baseline) : update, observedAt: 0 }),
        id: cid, agentId, update, created, listedAt: listAt,
        realListedAt: retained ? (old.realListedAt || old.listedAt) : listAt,
        retained, retainedSince: retained ? (old.retained ? old.retainedSince || old.listedAt : listAt) : 0,
        listUncertain: false,
        name: text(row.name, 180) || "会话 " + cid, group: text(row.groupName, 80)
      };

      const sampleAt = time(report.queueAt?.[cid]);
      const busy = queueBusy(report.queues?.[cid]);
      const floor = evidenceFloor(state, task);
      const rawMessage = latestMessage(report, task, at);
      const message = rawMessage && rawMessage.at >= floor ? rawMessage : null;
      const errorAt = time(report.queueErrors?.[cid]);
      const accessErrorAt = time(report.accessErrors?.[cid]);
      if (accessErrorAt && accessErrorAt >= Math.max(sampleAt, message?.at || 0, task.accessDeniedAt || 0)) {
        task.accessDeniedAt = accessErrorAt;
      }
      const messageErrorAt = time(report.messageErrors?.[cid]);
      const messageError = !!messageErrorAt && messageErrorAt >= (task.messageObservedAt || 0) &&
        (!message || messageErrorAt >= message.at);
      const freshQueue = !state.error && !state.sourceUnavailable && busy !== null &&
        sampleAt >= floor && sampleAt > task.observedAt && sampleAt <= at && sampleAt > (task.accessDeniedAt || 0);
      if (freshQueue && !retained) delete task.accessDeniedAt;
      const freshMessage = !state.error && !state.sourceUnavailable && !task.accessDeniedAt &&
        busy === false && sampleAt >= floor && sampleAt === task.observedAt && !task.queueError &&
        message && message.at >= sampleAt && message.at > (task.messageObservedAt || 0);
      if (!task.accessDeniedAt && (freshQueue || freshMessage)) {
        applyQueue(task, sampleAt, busy, message, messageError);
        if (freshQueue) task.queueError = false;
      } else if (busy !== true && (messageError ||
          (task.update > Math.max(task.acked || 0, task.replyUpdate || 0, task.messageUpdate || 0) && !message))) {
        task.messageUncertain = true;
      }
      if (errorAt > task.observedAt) task.queueError = true;
      const confirmed = taskFresh(state, task, now);
      if (task.pending && verifiedReply(task) && confirmed && canAcknowledge(task)) {
        // Record the last accepted confirmation of this pending revision.
        // The reply's creation timestamp is not a revalidation timestamp.
        task.replyVerifiedAt = Math.max(task.replyVerifiedAt || 0, task.observedAt);
        if (cid === activeId && task.status === "attention") {
          // Auto-read must also apply to a reply that has already been notified.
          task = acknowledge(task);
        } else if (!isDismissed(task) && recentNoticeActivity(task, now) && task.notified !== task.replyKey) {
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

  function view(state, now, include = () => true) {
    const offline = !state.at || now - state.at > timing.sourceStale;
    const error = state.error || "";
    const stale = offline || !!error || !!state.sourceUnavailable || !!state.authBlocked ||
      !state.listAt || now - state.listAt > timing.sourceStale;
    const counts = { running: 0, attention: 0, stuck: 0 };
    const tasks = [];
    for (const task of Object.values(state.tasks)) {
      if (task.listedAt !== state.listAt || !taskAccessible(state, task) ||
          !recentActivity(task, now) || isDismissed(task) || !include(task)) continue;
      const uncertain = !taskFresh(state, task, now) || task.messageUncertain;
      // Keep DS's confirmed-unread presentation, but use confirmation
      // evidence rather than server creation time after a recovery fence.
      // Legacy snapshots use the previous conservative fallback until the
      // next valid confirmation. Never inherit evidence across a new reply.
      const replyEvidence = task.replyVerifiedAt ?? (task.replyAt || task.replyUpdate || 0);
      const unread = task.pending === true && !task.listUncertain &&
        (task.status === "attention" || task.status === "stuck") && verifiedReply(task) &&
        !task.runAt && !task.awaitingReply && replyEvidence > 0 &&
        replyEvidence >= evidenceFloor(state, task);
      // One classification for counters, groups, filtering and row tint.
      // Unconfirmed running/blocked executions stay visible as uncertain,
      // but are not counted as verified active states.
      const displayStatus = (unread || !uncertain) && Object.hasOwn(counts, task.status)
        ? task.status : "seen";
      if (Object.hasOwn(counts, displayStatus)) counts[displayStatus]++;
      tasks.push({ ...task, uncertain, displayStatus });
    }
    tasks.sort((a, b) => order[a.status] - order[b.status] || b.update - a.update);
    return { counts, tasks, stale, offline, error };
  }

  globalThis.TaskPulseState = { blank, absorb, view, revision, displayVersion, isDismissed, recentActivity, recentNoticeActivity, canDismiss, dismiss, acknowledge, mayDismissNotice, authError, taskAccessible, taskFresh, isNewReply, canAcknowledge, verifiedReply, queueBusy, watchRows, reportRows, stuckMs: STUCK };
})();
