// Manifest V3 service worker. Collection stays in one DataAgent tab.
importScripts("config.js", "state.js", "ui-rules.js", "surface-worker.js");

const web = globalThis.TaskPulseWeb;
const rules = globalThis.TaskPulseState;
const ALARM = "tp-web-sync";
const REPLY_NOTICE = "tp-reply:";
const deliveryReceipts = new Set();
const contentFiles = chrome.runtime.getManifest().content_scripts[0].js;
// One navigation job per exact reply; different revisions never share a result.
const opening = new Map();
let navigationLane = Promise.resolve();
const jumpTabs = new Map();
const JUMP_KEY = "tp-web-jump-tabs-v1";
const jumpReady = chrome.storage.session.get(JUMP_KEY).then(items => {
  for (const [tabId, saved] of Object.entries(items[JUMP_KEY] || {})) {
    const guard = typeof saved === "string" ? { cid: saved } : saved;
    if (Number.isInteger(Number(tabId)) && web.id(guard?.cid)) jumpTabs.set(Number(tabId), guard);
  }
}).catch(() => {});
let jumpLane = Promise.resolve();
let focusEpoch = 0;
function persistJumps() {
  const snapshot = Object.fromEntries(jumpTabs);
  const result = jumpLane.then(() => chrome.storage.session.set({ [JUMP_KEY]: snapshot }));
  jumpLane = result.catch(() => {});
  return result;
}
async function rememberJump(tabId, guard) {
  await jumpReady;
  jumpTabs.set(tabId, guard);
  await persistJumps();
}
async function forgetJump(tabId, protectOpening = false, expectedToken) {
  await jumpReady;
  const guard = jumpTabs.get(tabId);
  if (!guard || protectOpening && opening.has(guard.cid) ||
      expectedToken !== undefined && guard.token !== expectedToken) return false;
  jumpTabs.delete(tabId);
  await persistJumps().catch(() => {});
  return true;
}

// Failed or abandoned navigation must not leave a new guard on an inactive
// tab. If it may actually have landed, keep the guard until a genuine visit.
async function abandonJump(tabId, guard, previous) {
  const actual = await chrome.tabs.get(tabId).catch(() => null);
  if (actual?.active && web.conversationId(actual.url) === guard.cid) return;
  if (jumpTabs.get(tabId)?.token !== guard.token) return;
  if (previous) await rememberJump(tabId, previous);
  else await forgetJump(tabId, false, guard.token);
}

const info = error => console.warn("TaskPulse:", error?.message ?? error);
let lane = Promise.resolve();
function serialize(work) {
  const result = lane.then(work);
  lane = result.catch(info);
  return result;
}

async function getState() {
  return (await chrome.storage.local.get(web.keys.state))[web.keys.state] ?? rules.blank();
}

function saveState(state) {
  return chrome.storage.local.set({ [web.keys.state]: state });
}

async function getLeader() {
  return (await chrome.storage.session.get(web.keys.leader))[web.keys.leader];
}

const isPage = tab => web.conversationPage(tab?.url) !== null;
const isUsable = tab => !!tab?.url && tab.status === "complete" &&
  (!tab.pendingUrl || tab.pendingUrl === tab.url) && !tab.discarded && !tab.frozen;
const isReady = tab => isPage(tab) && isUsable(tab);
const pages = () => chrome.tabs.query({ url: web.match });

async function signal(tabId, message) {
  let timeout;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null),
      new Promise(resolve => { timeout = setTimeout(resolve, 750, null); })
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probe(tab) {
  const answer = await signal(tab.id, { kind: "tp.probe" });
  if (answer?.pageId) return answer;
  const actual = await chrome.tabs.get(tab.id).catch(() => null);
  if (!isReady(actual)) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: contentFiles });
    return await signal(tab.id, { kind: "tp.probe" });
  } catch {
    return null;
  }
}

async function markSourceUnavailable() {
  const state = await getState();
  if (!state.sourceUnavailable) {
    state.sourceUnavailable = true;
    state.revalidateAfter = Math.max(state.revalidateAfter || 0, Date.now());
    await saveState(state);
    await updateBadge(state);
  }
}

async function syncLeader({ install = false, nudge = false } = {}) {
  const old = await getLeader();
  const candidates = (await pages()).filter(isReady);
  if (install) {
    await Promise.allSettled(candidates.map(tab =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: contentFiles })
    ));
  }

  const current = candidates.find(tab => tab.id === old?.tabId);
  const state = await getState();
  const lastProgress = Math.max(old?.since || 0, Math.min(state.at || 0, state.listAt || 0));
  // A content script can answer a probe while its background timers have
  // stopped producing usable data. Prefer another ready page only once the
  // existing source-stale window is exceeded; healthy sources never churn.
  const stalled = Boolean(current && candidates.some(tab => tab.id !== current.id) &&
    Date.now() - lastProgress > web.timing.sourceStale);
  if (current && !stalled) {
    const answer = await probe(current);
    if (answer?.pageId === old.pageId) {
      if (answer.lease !== old.lease) {
        const restored = await signal(old.tabId, { kind: "tp.role", pageId: old.pageId, lease: old.lease });
        if (restored?.pageId === old.pageId) return;
      } else {
        if (nudge) await signal(old.tabId, { kind: "tp.nudge", pageId: old.pageId });
        return;
      }
    }
  }

  candidates.sort((a, b) =>
    (stalled ? Number(a.id === current.id) - Number(b.id === current.id) : 0) ||
    Number(b.active) - Number(a.active));
  // Fence cached evidence before granting any replacement lease.
  await markSourceUnavailable();
  for (const tab of candidates) {
    const answer = await probe(tab);
    if (!answer?.pageId) continue;
    const next = { tabId: tab.id, pageId: answer.pageId, lease: crypto.randomUUID(), since: Date.now() };
    await chrome.storage.session.set({ [web.keys.leader]: next });
    if (old) await signal(old.tabId, { kind: "tp.role", pageId: old.pageId, lease: "" });
    const accepted = await signal(tab.id, { kind: "tp.role", pageId: next.pageId, lease: next.lease });
    if (accepted?.pageId === next.pageId) return;
    // A timed-out role response may still have started a collector.
    await signal(tab.id, { kind: "tp.role", pageId: next.pageId, lease: "" });
  }
  await chrome.storage.session.remove(web.keys.leader);
  if (old) await signal(old.tabId, { kind: "tp.role", pageId: old.pageId, lease: "" });
}

let refreshTimer = null;
function refreshLeader() {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void serialize(syncLeader).catch(() => {});
  }, 80);
}

async function foregroundTab() {
  // Activation events caused by a valid navigation may arrive during an API
  // query. Retry once if the event epoch changed; never accept a stale snapshot.
  for (let attempt = 0; attempt < 2; attempt++) {
    const epoch = focusEpoch;
    const win = await chrome.windows.getLastFocused({}).catch(() => null);
    if (!win?.focused || !Number.isInteger(win.id) || win.id < 0) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!isUsable(tab) || tab.active !== true || tab.windowId !== win.id) return null;
    const actual = await chrome.tabs.get(tab.id).catch(() => null);
    const confirm = await chrome.windows.getLastFocused({}).catch(() => null);
    if (epoch !== focusEpoch) continue;
    if (!confirm?.focused || confirm.id !== win.id ||
        !isUsable(actual) || !actual.active || actual.windowId !== win.id || actual.url !== tab.url) return null;
    return actual;
  }
  return null;
}

async function foregroundPage() {
  const tab = await foregroundTab();
  return isReady(tab) ? tab : null;
}

// Hidden DataAgent pages can be throttled. During verified active work only,
// the MV3 worker asks the same collector to run its existing due-work queue.
// No second collector, no new permissions and no artificial keepalive.
let fastWakeTimer = null, fastWakeLeader = null, fastWakeUntil = 0;
let hiddenCollector = false, activityUntil = 0;
function stopFastWake() {
  if (fastWakeTimer !== null) clearTimeout(fastWakeTimer);
  fastWakeTimer = null;
  fastWakeLeader = null;
  fastWakeUntil = 0;
}
function armFastWake() {
  if (fastWakeTimer !== null || !fastWakeLeader || Date.now() >= fastWakeUntil) return;
  fastWakeTimer = setTimeout(async () => {
    fastWakeTimer = null;
    const expected = fastWakeLeader;
    try {
      const current = await getLeader();
      if (!expected || current?.lease !== expected.lease || Date.now() >= fastWakeUntil) {
        stopFastWake();
        return;
      }
      const answer = await signal(current.tabId, { kind: "tp.nudge", pageId: current.pageId });
      if (!answer?.pageId) { stopFastWake(); refreshLeader(); return; }
    } catch { stopFastWake(); return; }
    armFastWake();
  }, web.timing.hot);
}
function updateFastWake(leader, state, hidden) {
  hiddenCollector = hidden === true;
  const active = !state.error && !state.sourceUnavailable && Object.values(state.tasks).some(task =>
    !task.accessDeniedAt && (task.runAt || task.awaitingReply) &&
    (!task.settleUntil || Date.now() <= task.settleUntil));
  if (!hiddenCollector || (!active && activityUntil <= Date.now())) { stopFastWake(); return; }
  fastWakeLeader = leader;
  fastWakeUntil = active ? Math.min(Date.now() + web.timing.sourceStale,
    state.at + web.timing.sourceStale) : activityUntil;
  armFastWake();
}
async function relayActivity(msg, sender) {
  const actual = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (!isReady(actual)) return { ok: false };
  const leader = await getLeader();
  if (!leader) { refreshLeader(); return { ok: true }; }
  const cid = web.conversationId(actual.url);
  activityUntil = Date.now() + web.timing.hotWindow;
  if (leader.tabId !== sender.tab.id || msg.route === true)
    await signal(leader.tabId, { kind: "tp.nudge", pageId: leader.pageId, activity: true, cid });
  if (hiddenCollector) {
    fastWakeLeader = leader;
    fastWakeUntil = Math.max(fastWakeUntil, activityUntil);
    armFastWake();
  }
  return { ok: true };
}

async function collectorVisibility(msg, sender) {
  const leader = await getLeader();
  if (!leader || leader.tabId !== sender.tab.id || leader.pageId !== msg.pageId || leader.lease !== msg.lease)
    return { ok: false };
  const state = await getState();
  updateFastWake(leader, state, msg.hidden);
  return { ok: true };
}

function matchesConversation(tab, cid, agentId) {
  if (web.conversationId(tab?.url) !== cid) return false;
  const actualAgent = web.id(web.conversationPage(tab.url)?.searchParams.get("agentId"));
  return !actualAgent || !agentId || actualAgent === agentId;
}

function activeConversation(state, tab) {
  const cid = web.conversationId(tab?.url);
  if (!cid || opening.has(cid)) return "";
  const guard = jumpTabs.get(tab?.id);
  if (guard?.cid === cid) {
    // The read commit and its operation token share one durable state write.
    // After a worker restart, an exact completed jump need not stay protected.
    if (!guard.token || state.tasks[cid]?.jumpCommit !== guard.token) return "";
  }
  const task = state.tasks[cid];
  return matchesConversation(tab, cid, task?.agentId) ? cid : "";
}

function freshTask(state, task, now = Date.now()) {
  return rules.taskFresh(state, task, now);
}

function canAutoRead(state, task, manual = false) {
  return freshTask(state, task) && task.pending &&
    (task.status === "attention" || manual && task.status === "stuck") &&
    rules.verifiedReply(task) && rules.canAcknowledge(task);
}

async function readForeground(state, tabId, windowId, manual = false) {
  await jumpReady;
  const tab = await foregroundPage();
  if (!tab || tabId !== undefined && tab.id !== tabId || windowId !== undefined && tab.windowId !== windowId) return false;
  const task = state.tasks[activeConversation(state, tab)];
  if (!canAutoRead(state, task, manual)) return false;
  state.tasks[task.id] = rules.acknowledge(task);
  return true;
}

function noticeTask(state, revision) {
  const [id, agentId] = revision.split("/");
  const task = state.tasks[id];
  return task?.agentId === agentId && task.pending && rules.revision(task) === revision &&
    !rules.isDismissed(task) && rules.recentActivity(task, Date.now()) ? task : null;
}

function pruneOutbox(state) {
  let changed = false;
  for (const revision of Object.keys(state.outbox || {})) {
    if (!noticeTask(state, revision)) {
      delete state.outbox[revision];
      changed = true;
    }
  }
  return changed;
}

async function clearReadNotices(state) {
  const existing = await chrome.notifications.getAll();
  await Promise.allSettled(Object.keys(existing).filter(key => {
    if (!key.startsWith(REPLY_NOTICE)) return false;
    const revision = key.slice(REPLY_NOTICE.length);
    const [id, agentId, update, replyKey] = revision.split("/");
    const task = state.tasks[id];
    // Explicit login loss and unverified retained rows must not expose
    // prior account titles through system notifications. Preserve the
    // pending watermark/outbox; do not mark the task read.
    if (state.authBlocked || rules.authError(state.error)) return true;
    if (task && !rules.taskAccessible(state, task)) return true;
    if (!task || task.agentId !== agentId) return false;
    if (rules.isDismissed(task) && rules.revision(task) === revision ||
        !rules.recentActivity(task, Date.now())) return true;
    // Do not clear the newly pending version of a previously dismissed row.
    if (task.pending && rules.revision(task) === revision) return false;
    if (task.dismissedNoticeRevision === revision) return true;
    // Existing 2.1.1 storage may have a confirmed read watermark but no
    // readRevision yet. Clean up those old notifications on the first sync.
    const currentRevision = rules.revision(task);
    const readRevision = task.readRevision ||
      (!task.pending && rules.verifiedReply(task) &&
        task.acked >= (task.replyAt || task.replyUpdate || Infinity) ? currentRevision : "");
    if (!readRevision) return false;
    // Exact read version, older update versions, or all superseded notices
    // when the *current* version is read. Never clear a newer pending version.
    return revision === readRevision || task.readKeys?.includes(replyKey) ||
      Number(update) < Number(readRevision.split("/")[2]) ||
      (!task.pending && currentRevision === readRevision);
  }).map(key => chrome.notifications.clear(key)));
}

async function updateBadge(state) {
  const { counts } = rules.view(state, Date.now());
  const total = counts.attention + counts.stuck;
  await chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : "" });
}

async function persistForegroundRead(state) {
  // Do not spend browser focus queries on reports without any eligible reply.
  const eligible = Object.values(state.tasks).some(task => canAutoRead(state, task));
  const read = eligible && await readForeground(state);
  const pruned = pruneOutbox(state);
  if (read || pruned) await saveState(state);
}

async function deliverNotices(state) {
  const outbox = state.outbox;
  if (!outbox || !Object.keys(outbox).length) return;
  if (await chrome.notifications.getPermissionLevel() !== "granted") return;
  const existing = await chrome.notifications.getAll();
  for (const [revision, notice] of Object.entries(outbox)) {
    // Permission, browser state and prior deliveries all involve async calls.
    // Reconcile immediately before dispatch, not only at the start of sync.
    if (deliveryReceipts.has(revision)) {
      delete outbox[revision];
      await saveState(state);
      continue;
    }
    if (!Object.hasOwn(outbox, revision)) continue;
    const now = Date.now();
    const task = noticeTask(state, revision);
    if (!task || !freshTask(state, task, now) || !rules.canAcknowledge(task) || notice.retryAt > now) continue;
    const notificationId = REPLY_NOTICE + revision;
    try {
      if (!Object.hasOwn(existing, notificationId)) {
        // Persist each attempt before the external side effect. On restart,
        // getAll plus onClosed/onClicked evidence reconciles this same ID.
        notice.attemptAt = now;
        await saveState(state);
        await persistForegroundRead(state);
        if (!Object.hasOwn(outbox, revision)) continue;
        if (deliveryReceipts.has(revision)) {
          delete outbox[revision];
          await saveState(state);
          continue;
        }
        if (!freshTask(state, noticeTask(state, revision)) ||
            !rules.canAcknowledge(noticeTask(state, revision))) continue;
        await chrome.notifications.create(notificationId, {
          type: "basic", iconUrl: chrome.runtime.getURL("icon.png"),
          title: "TaskPulse · 有新回复", message: notice.name
        });
      }
      delete outbox[revision];
    } catch (error) {
      notice.retryAt = now + 5_000;
      info(error);
    }
    await saveState(state);
  }
}

async function syncNotices(state) {
  await persistForegroundRead(state);
  // All these operations run in the state lane. Reconcile again after the
  // notification API returns, then clean up notifications and badge together.
  try { await deliverNotices(state); } catch (error) { info(error); }
  await persistForegroundRead(state);
  await Promise.allSettled([clearReadNotices(state), updateBadge(state)]);
}

async function acknowledge(state, task, checked = false, jumpToken = "") {
  const revision = rules.revision(task);
  state.tasks[task.id] = rules.acknowledge(task);
  if (jumpToken) state.tasks[task.id].jumpCommit = jumpToken;
  if (checked) state.tasks[task.id] = { ...rules.dismiss(state.tasks[task.id]), checkedRevision: revision };
  pruneOutbox(state);
  await saveState(state);
  await syncNotices(state);
}

async function acceptReport(msg, sender) {
  const leader = await getLeader();
  if (!leader || leader.tabId !== sender.tab.id || leader.pageId !== msg.pageId || leader.lease !== msg.lease) {
    return { ok: false };
  }
  // The sender snapshot may predate a navigation or removal of its tab.
  const actual = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (!isReady(actual)) {
    await markSourceUnavailable();
    refreshLeader();
    return { ok: false };
  }
  const state = await getState();
  await jumpReady;
  // First absorb observations without guessing which page will remain focused.
  // Auto-read occurs only in the serialized foreground reconciliation.
  const { state: next, replies } = rules.absorb(state, msg.payload, Date.now());
  if (next !== state) {
    next.outbox = { ...next.outbox };
    for (const task of replies) next.outbox[rules.revision(task)] = { name: task.name, retryAt: 0, at: next.at };
    // One current pending notice per task is retained across long outages.
    // pruneOutbox removes read, replaced or expired-history tasks.
    pruneOutbox(next);
    await saveState(next);
    updateFastWake(leader, next, msg.payload.hidden);
    await syncNotices(next);
    const pendingReplies = replies.filter(task => {
      const current = noticeTask(next, rules.revision(task));
      return freshTask(next, current) && rules.canAcknowledge(current);
    });
    const currentPage = pendingReplies.length ? await foregroundTab() : null;
    if (currentPage && isPage(currentPage)) await signal(currentPage.id, {
      kind: "tp.replies",
      tasks: pendingReplies.slice(0, 3).reverse().map(task => ({
        id: task.id, name: task.name, revision: rules.revision(task), failed: task.failed
      }))
    });
    else if (currentPage) await surfaces.notify(currentPage, pendingReplies).catch(info);
  }
  return { ok: true };
}

async function markVisited(tabId, windowId) {
  const state = await getState();
  if (tabId !== undefined && (state.sourceUnavailable || !state.at ||
      Date.now() - Math.min(state.at || 0, state.listAt || 0) > web.timing.sourceStale)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (isReady(tab)) refreshLeader();
  }
  if (!await readForeground(state, tabId, windowId, true)) return;
  pruneOutbox(state);
  await saveState(state);
  await syncNotices(state);
}

async function raiseWindow(tab) {
  if (!Number.isInteger(tab.windowId)) return false;
  const window = await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
  return window?.focused === true;
}

async function focusTab(tab) {
  const current = await chrome.tabs.update(tab.id, { active: true });
  return { tab: current, focused: await raiseWindow(current) };
}

function waitForLanding(tabId, id) {
  return new Promise(resolve => {
    let settled = false;
    const finish = tab => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      resolve(tab);
    };
    const check = tab => {
      if (!tab) return finish(null);
      if (tab.status !== "complete" || tab.pendingUrl && tab.pendingUrl !== tab.url ||
          !tab.url || tab.url === "about:blank") return;
      finish(isReady(tab) && web.conversationId(tab.url) === id ? tab : null);
    };
    const updated = changedId => {
      if (changedId === tabId && !settled) {
        // Browser event payloads can be delayed. Re-read the actual tab
        // rather than treating a stale redirect snapshot as final landing.
        void chrome.tabs.get(tabId).then(check, () => finish(null));
      }
    };
    const removed = changedId => { if (changedId === tabId) finish(null); };
    const timer = setTimeout(() => finish(null), 10_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    void chrome.tabs.get(tabId).then(check, () => finish(null));
  });
}

async function focusConversation(cid, agentId, revision) {
  const newGuard = () => ({ cid, revision, token: crypto.randomUUID(), at: Date.now() });
  for (const candidate of await pages()) {
    if (!matchesConversation(candidate, cid, agentId)) continue;
    const actual = await chrome.tabs.get(candidate.id).catch(() => null);
    if (!isReady(actual) || !matchesConversation(actual, cid, agentId)) continue;
    const previous = jumpTabs.get(actual.id), guard = newGuard();
    await rememberJump(actual.id, guard);
    const result = await focusTab(actual).catch(() => null);
    const arrived = result?.focused ? await foregroundPage() : null;
    if (arrived?.id === actual.id && matchesConversation(arrived, cid, agentId)) {
      return { tabId: actual.id, guard, previous, agentId };
    }
    await abandonJump(actual.id, guard, previous);
  }
  const url = web.conversationUrl(cid, agentId);
  if (!url) return null;
  // Never activate a newly created tab before its guard is durable.
  const created = await chrome.tabs.create({ url, active: false });
  const guard = newGuard();
  await rememberJump(created.id, guard);
  const result = await focusTab(created).catch(() => null);
  const landed = result?.focused && await waitForLanding(created.id, cid);
  const arrived = landed ? await foregroundPage() : null;
  if (arrived?.id === created.id && matchesConversation(arrived, cid, agentId)) {
    return { tabId: created.id, guard, previous: null, agentId };
  }
  await abandonJump(created.id, guard, null);
  return null;
}

async function openTask(id, revision, allowSavedId = false, intent = "row") {
  if (!web.id(id) || typeof revision !== "string" || revision.split("/")[0] !== id) return { ok: false };
  const fromNotice = allowSavedId || intent === "notice";
  const jobKey = revision + (fromNotice ? "/notice" : "/row");
  const jobs = opening.get(id) || new Map();
  if (jobs.has(jobKey)) return jobs.get(jobKey);
  opening.set(id, jobs);

  const job = navigationLane.then(async () => {
    await jumpReady;
    const state = await getState();
    const task = state.tasks[id];
    if (state.authBlocked || rules.authError(state.error) ||
        task && !rules.taskAccessible(state, task) || !task && !allowSavedId) return { ok: false };
    const agentId = web.id(revision.split("/")[1]) || task?.agentId;
    const landing = await focusConversation(id, agentId, revision);
    if (!landing) return { ok: false };
    const { tabId, guard, previous } = landing;
    return serialize(async () => {
      const fresh = await getState();
      const current = fresh.tasks[id];
      // Landing happened outside the state lane. Revalidate immediately
      // before committing a read; focus or route may have changed meanwhile.
      const actual = await foregroundPage();
      if (actual?.id !== tabId || !matchesConversation(actual, id, agentId) ||
          jumpTabs.get(tabId)?.token !== guard.token || fresh.authBlocked || rules.authError(fresh.error) ||
          current && !rules.taskAccessible(fresh, current)) {
        await abandonJump(tabId, guard, previous);
        return { ok: false, clearNotice: false };
      }
      if (current && rules.revision(current) === revision) {
        const confirmed = freshTask(fresh, current) && rules.canAcknowledge(current);
        if (current.pending && confirmed) {
          // Current-version read: release protection only after a durable
          // acknowledgment carrying this exact operation token.
          await acknowledge(fresh, current, false, guard.token);
          await forgetJump(tabId, false, guard.token);
          return { ok: true, clearNotice: true };
        }
        if (!fromNotice) {
          // A direct row visit is intentional even while a run is incomplete.
          // Permit later verified foreground replies without acknowledging
          // any unconfirmed data now.
          fresh.tasks[id] = { ...current, jumpCommit: guard.token };
          await saveState(fresh);
          await forgetJump(tabId, false, guard.token);
          return { ok: true, clearNotice: !current.pending };
        }
        // A replayed notice for an already read revision is still an old
        // notice, not a normal row visit. Keep its landing guard.
        return { ok: true, clearNotice: !current.pending };
      }
      // Obsolete or unknown ticket: navigate, but keep the guard and dismiss
      // only its own notification. A genuine later visit can release it.
      return { ok: true, clearNotice: true };
    });
  });
  jobs.set(jobKey, job);
  navigationLane = job.catch(() => {});
  try {
    return await job;
  } finally {
    jobs.delete(jobKey);
    if (!jobs.size) opening.delete(id);
  }
}

async function markChecked(id, revision, checked) {
  if (!web.id(id) || typeof checked !== "boolean") return { ok: false };
  const state = await getState();
  const task = state.tasks[id];
  if (!task || rules.revision(task) !== revision) return { ok: false };
  if (checked) {
    if (!freshTask(state, task) || !rules.canAcknowledge(task)) return { ok: false };
    await acknowledge(state, task, true);
  } else if (task.checkedRevision === revision) {
    delete task.checkedRevision;
    delete task.dismissedVersion;
    delete task.dismissedNoticeRevision;
    await saveState(state);
  }
  return { ok: true };
}

async function dismissTask(id, version) {
  if (!web.id(id) || typeof version !== "string" || version.length > 4096) return { ok: false };
  const state = await getState();
  const task = state.tasks[id], now = Date.now();
  if (!task || rules.displayVersion(task) !== version) return { ok: false };
  if (rules.isDismissed(task)) return { ok: true };
  if (!rules.canDismiss(state, task, now)) return { ok: false };
  // Verified replies may be acknowledged. An uncertain row is only
  // dismissed from the presentation, without advancing any read watermark.
  const confirmed = freshTask(state, task, now) && rules.canAcknowledge(task);
  state.tasks[id] = rules.dismiss(confirmed ? rules.acknowledge(task) : task);
  pruneOutbox(state);
  await saveState(state);
  await syncNotices(state);
  return { ok: true };
}

async function userVisit(id, sender, visitAt) {
  await jumpReady;
  const guard = jumpTabs.get(sender.tab.id);
  if (!web.id(id) || opening.has(id) || guard?.cid !== id || visitAt < (guard.at || 0)) return { ok: false };
  const tab = await foregroundPage();
  if (tab?.id !== sender.tab.id || !matchesConversation(tab, id) || opening.has(id) ||
      jumpTabs.get(tab.id) !== guard) return { ok: false };
  if (!await forgetJump(tab.id, true, guard.token)) return { ok: false };
  await markVisited(tab.id, tab.windowId);
  return { ok: true };
}

function senderIsPage(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && web.conversationPage(sender.url ?? sender.tab.url) !== null;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  let reply;
  const page = senderIsPage(sender);
  if (msg.kind === "tp.surface.register" && surfaces.topSender(sender)) reply = surfaces.register(sender);
  else if (surfaces.candidate(sender)) {
    if (msg.kind === "tp.surface.attach") reply = surfaces.attach(sender, msg.token);
    else if (msg.kind === "tp.surface.toasts") reply = surfaces.toastData(sender, msg.token);
    else if (["tp.open", "tp.check", "tp.dismiss", "tp.settings"].includes(msg.kind)) {
      reply = surfaces.validate(sender, msg.token).then(allowed => {
        if (!allowed) return { ok: false };
        if (msg.kind === "tp.open") return openTask(msg.id, msg.revision, false, msg.intent);
        if (msg.kind === "tp.check") return serialize(() => markChecked(msg.id, msg.revision, msg.checked));
        if (msg.kind === "tp.dismiss") return serialize(() => dismissTask(msg.id, msg.version));
        return chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
      });
    }
  }
  if (!page) {
    if (!reply) return false;
    reply.then(respond, error => { info(error); respond({ ok: false }); });
    return true;
  }
  if (msg.kind === "tp.ready") {
    refreshLeader();
    respond({ ok: true });
    return false;
  }
  if (msg.kind === "tp.webstate") reply = serialize(() => acceptReport(msg, sender));
  if (msg.kind === "tp.activity") reply = relayActivity(msg, sender);
  if (msg.kind === "tp.visibility") reply = collectorVisibility(msg, sender);
  if (msg.kind === "tp.settings") reply = chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
  if (msg.kind === "tp.open") reply = openTask(msg.id, msg.revision, false, msg.intent);
  if (msg.kind === "tp.check") reply = serialize(() => markChecked(msg.id, msg.revision, msg.checked));
  if (msg.kind === "tp.dismiss") reply = serialize(() => dismissTask(msg.id, msg.version));
  if (msg.kind === "tp.visit" && !opening.has(msg.id)) {
    const visitAt = Number(msg.at) || Date.now();
    reply = serialize(() => userVisit(msg.id, sender, visitAt));
  }
  if (!reply) return false;
  reply.then(respond, error => { info(error); respond({ ok: false }); });
  return true;
});

// A closed/clicked notification is proof that this deterministic ID existed.
// Record it in the durable outbox, even when create()'s worker died before
// saving its result. Do not acknowledge or clear the task itself.
function recordDelivery(id) {
  if (!id.startsWith(REPLY_NOTICE)) return Promise.resolve();
  const revision = id.slice(REPLY_NOTICE.length);
  // The receipt must be visible to an already running delivery before its
  // serialized durable removal reaches the front of the state lane.
  deliveryReceipts.add(revision);
  return serialize(async () => {
    const state = await getState();
    if (Object.hasOwn(state.outbox || {}, revision)) {
      delete state.outbox[revision];
      await saveState(state);
    }
    deliveryReceipts.delete(revision);
  });
}
chrome.notifications.onClosed?.addListener(id => {
  void recordDelivery(id).catch(info);
});
chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith(REPLY_NOTICE)) return;
  const revision = id.slice(REPLY_NOTICE.length);
  // Start the navigation immediately, so opening protects this conversation
  // even if recording the delivery has to wait for the state lane.
  const navigation = openTask(revision.split("/")[0], revision, true);
  void recordDelivery(id).catch(info);
  void navigation.then(result => {
    if (rules.mayDismissNotice(result)) return chrome.notifications.clear(id);
  }).catch(info);
});

function wake(install = false) {
  void serialize(async () => {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (install) await chrome.alarms.clear("tp-sync");
    await syncLeader({ install, nudge: true });
    const state = await getState();
    await syncNotices(state);
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => { wake(true); surfaces.install(); });
chrome.runtime.onStartup.addListener(() => { wake(); surfaces.install(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) wake();
});

chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.groupId !== undefined || change.url || change.status === "complete") surfaces.scheduleGroups();
  if (!(change.url || change.discarded !== undefined || change.frozen !== undefined || change.status === "complete")) return;
  focusEpoch++;
  void (async () => {
    await jumpReady;
    // onUpdated snapshots can arrive after a newer route already landed.
    // Only the actual current tab may release a versioned landing guard.
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) return;
    const cid = web.conversationId(tab.url);
    if (tab.active && (change.url || change.status === "complete" ||
        change.discarded === false || change.frozen === false)) {
      if (isPage(tab) || change.url) void signal(tab.id, { kind: "tp.route" }).catch(info);
      if (!isPage(tab)) surfaces.activate(id);
    }
    if ((change.url || change.status === "complete") && jumpTabs.has(id) &&
        jumpTabs.get(id)?.cid !== cid && tab.status === "complete" && tab.url !== "about:blank" &&
        (!tab.pendingUrl || tab.pendingUrl === tab.url)) await forgetJump(id, true);
    if (isPage(tab)) {
      refreshLeader();
      if (change.url && tab.active) void relayActivity({ route: true }, { tab }).catch(() => {});
      if (tab.active && !jumpTabs.has(id) && !opening.has(cid) && (change.url || change.status === "complete")) {
        await serialize(() => markVisited(id, tab.windowId));
      }
    } else if ((await getLeader())?.tabId === id) refreshLeader();
  })().catch(info);
});
chrome.tabs.onRemoved.addListener(id => {
  focusEpoch++;
  void forgetJump(id);
  void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  focusEpoch++;
  surfaces.activate(tabId);
  void (async () => {
    await jumpReady;
    // A genuine switch away releases the previous tab's versioned protection.
    for (const id of [...jumpTabs.keys()]) {
      if (id === tabId) continue;
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab || tab.windowId === windowId && !tab.active) await forgetJump(id, true);
    }
    await serialize(() => markVisited(tabId, windowId));
  })().catch(info);
});
chrome.windows.onFocusChanged.addListener(windowId => {
  focusEpoch++;
  const duringJump = opening.size > 0;
  void (async () => {
    await jumpReady;
    if (!duringJump && !opening.size) {
      const win = await chrome.windows.getLastFocused({}).catch(() => null);
      // Both blur and positive focus events can be delayed. Confirm the
      // reported window still matches the real foreground before releasing.
      const eventStillCurrent = win && (windowId >= 0 ? win.focused && win.id === windowId : !win.focused);
      if (eventStillCurrent) {
        for (const id of [...jumpTabs.keys()]) {
          const tab = await chrome.tabs.get(id).catch(() => null);
          if (!tab || tab.windowId !== windowId) await forgetJump(id, true);
        }
      }
    }
    await serialize(() => markVisited(undefined, windowId));
  })().catch(info);
});

chrome.action.onClicked.addListener(tab => {
  // Browser-protected pages cannot host content scripts. Opening a native
  // side panel must occur directly inside the user's toolbar gesture.
  if (!isPage(tab) && chrome.sidePanel?.open && Number.isInteger(tab.windowId)) {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(info);
    return;
  }
  void (async () => {
    if (!isPage(tab) && await surfaces.toolbar(tab)) return;
    const candidates = isReady(tab) ? [tab] : await pages();
    const target = candidates.find(isReady) ?? (isPage(tab) ? tab : candidates.find(isPage));
    if (!target) {
      await chrome.tabs.create({ url: web.page, active: true });
      return;
    }
    if (target.id !== tab.id) await focusTab(target);
    const shown = await signal(target.id, { kind: "tp.show" });
    if (!shown && await probe(target)) {
      await signal(target.id, { kind: "tp.show" });
    }
  })().catch(info);
});

// Instantiate last: keep the original listener order for navigation and tests.
const surfaces = globalThis.TaskPulseSurfaceWorker.create({ web, rules, signal, getState });
