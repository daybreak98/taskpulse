// Manifest V3 service worker. Collection stays in one DataAgent tab.
importScripts("config.js", "state.js");

const web = globalThis.TaskPulseWeb;
const rules = globalThis.TaskPulseState;
const ALARM = "tp-web-sync";
const REPLY_NOTICE = "tp-reply:";
const contentFiles = chrome.runtime.getManifest().content_scripts[0].js;
// One navigation job per exact reply; different revisions never share a result.
const opening = new Map();
let navigationLane = Promise.resolve();
const jumpTabs = new Map();
const JUMP_KEY = "tp-web-jump-tabs-v1";
const jumpReady = chrome.storage.session.get(JUMP_KEY).then(items => {
  for (const [tabId, cid] of Object.entries(items[JUMP_KEY] || {})) {
    if (Number.isInteger(Number(tabId)) && web.id(cid)) jumpTabs.set(Number(tabId), cid);
  }
}).catch(() => {});
let jumpLane = Promise.resolve();
function persistJumps() {
  const snapshot = Object.fromEntries(jumpTabs);
  const result = jumpLane.then(() => chrome.storage.session.set({ [JUMP_KEY]: snapshot }));
  jumpLane = result.catch(() => {});
  return result;
}
async function rememberJump(tabId, cid) {
  await jumpReady;
  jumpTabs.set(tabId, cid);
  await persistJumps();
}
async function forgetJump(tabId) {
  await jumpReady;
  if (jumpTabs.delete(tabId)) await persistJumps().catch(() => {});
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
const isReady = tab => isPage(tab) && tab.status === "complete" && (!tab.pendingUrl || tab.pendingUrl === tab.url) && !tab.discarded && !tab.frozen;
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

async function syncLeader({ install = false, nudge = false } = {}) {
  const old = await getLeader();
  const candidates = (await pages()).filter(isReady);
  if (install) {
    await Promise.allSettled(candidates.map(tab =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: contentFiles })
    ));
  }

  const current = candidates.find(tab => tab.id === old?.tabId);
  if (current) {
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

  candidates.sort((a, b) => Number(b.active) - Number(a.active));
  for (const tab of candidates) {
    const answer = await probe(tab);
    if (!answer?.pageId) continue;
    const next = { tabId: tab.id, pageId: answer.pageId, lease: crypto.randomUUID() };
    await chrome.storage.session.set({ [web.keys.leader]: next });
    if (old) await signal(old.tabId, { kind: "tp.role", pageId: old.pageId, lease: "" });
    const accepted = await signal(tab.id, { kind: "tp.role", pageId: next.pageId, lease: next.lease });
    if (accepted?.pageId === next.pageId) return;
  }
  await chrome.storage.session.remove(web.keys.leader);
}

let refreshTimer = null;
function refreshLeader() {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void serialize(syncLeader).catch(() => {});
  }, 80);
}

async function foregroundPage() {
  const win = await chrome.windows.getLastFocused({}).catch(() => null);
  if (!win?.focused || !Number.isInteger(win.id) || win.id < 0) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return isReady(tab) ? tab : null;
}

function activeConversation(tab) {
  const id = web.conversationId(tab?.url);
  // A notification landing is a versioned action, not an unversioned visit.
  // Keep this protection after navigation completes (including worker restarts).
  return opening.has(id) || jumpTabs.get(tab?.id) === id ? "" : id;
}

function freshTask(state, task, now = Date.now()) {
  return !state.error && state.at && now - state.at <= web.timing.sourceStale &&
    state.listAt && now - state.listAt <= web.timing.sourceStale &&
    task && task.listedAt === state.listAt && !task.queueError && task.observedAt &&
    now - task.observedAt <= web.timing.queueStale;
}

function canAutoRead(state, task) {
  return freshTask(state, task) && task.pending && task.status === "attention" &&
    rules.verifiedReply(task) && rules.canAcknowledge(task);
}

async function readForeground(state, tabId, windowId) {
  await jumpReady;
  const tab = await foregroundPage();
  if (!tab || tabId !== undefined && tab.id !== tabId || windowId !== undefined && tab.windowId !== windowId) return false;
  const task = state.tasks[activeConversation(tab)];
  if (!canAutoRead(state, task)) return false;
  state.tasks[task.id] = rules.acknowledge(task);
  return true;
}

function noticeTask(state, revision) {
  const [id, agentId] = revision.split("/");
  const task = state.tasks[id];
  return task?.agentId === agentId && task.pending && rules.revision(task) === revision ? task : null;
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
    const [id, agentId, update] = revision.split("/");
    const task = state.tasks[id];
    if (!task?.readRevision || task.agentId !== agentId ||
        task.pending && rules.revision(task) === revision) return false;
    // Exact read version, older update versions, or all superseded notices
    // when the *current* version is read. Never clear a newer pending version.
    return revision === task.readRevision ||
      Number(update) < Number(task.readRevision.split("/")[2]) ||
      (!task.pending && rules.revision(task) === task.readRevision);
  }).map(key => chrome.notifications.clear(key)));
}

async function updateBadge(state) {
  const { counts } = rules.view(state, Date.now());
  const total = counts.attention + counts.stuck;
  await chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : "" });
}

async function deliverNotices(state) {
  const outbox = state.outbox;
  if (!outbox || !Object.keys(outbox).length) return;
  const now = Date.now();
  if (await chrome.notifications.getPermissionLevel() !== "granted") return;
  const existing = await chrome.notifications.getAll();
  let changed = false;
  for (const [revision, notice] of Object.entries(outbox)) {
    const task = noticeTask(state, revision);
    if (!task || !freshTask(state, task, now) || !rules.canAcknowledge(task) || notice.retryAt > now) continue;
    const notificationId = REPLY_NOTICE + revision;
    try {
      if (!Object.hasOwn(existing, notificationId)) {
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
    changed = true;
  }
  if (changed) await saveState(state);
}

async function syncNotices(state) {
  // Re-check real foreground before replaying an outbox (also on alarm/wake).
  // Persist read state and outbox removal before any browser-side cleanup.
  const read = await readForeground(state);
  const pruned = pruneOutbox(state);
  if (read || pruned) await saveState(state);
  await Promise.allSettled([clearReadNotices(state), deliverNotices(state), updateBadge(state)]);
}

async function acknowledge(state, task, checked = false) {
  const revision = rules.revision(task);
  state.tasks[task.id] = rules.acknowledge(task);
  if (checked) state.tasks[task.id].checkedRevision = revision;
  pruneOutbox(state);
  await saveState(state);
  await syncNotices(state);
}

async function acceptReport(msg, sender) {
  const leader = await getLeader();
  if (!leader || leader.tabId !== sender.tab.id || leader.pageId !== msg.pageId || leader.lease !== msg.lease) {
    return { ok: false };
  }
  const state = await getState();
  await jumpReady;
  const page = await foregroundPage();
  const { state: next, replies } = rules.absorb(state, msg.payload, Date.now(), activeConversation(page));
  if (next !== state) {
    next.outbox = { ...next.outbox };
    for (const task of replies) next.outbox[rules.revision(task)] = { name: task.name, retryAt: 0, at: next.at };
    for (const [revision, notice] of Object.entries(next.outbox)) {
      if (next.at - notice.at > 24 * 60 * 60_000) delete next.outbox[revision];
    }
    pruneOutbox(next);
    await saveState(next);
    await syncNotices(next);
    const currentPage = await foregroundPage();
    const pendingReplies = replies.filter(task => noticeTask(next, rules.revision(task)));
    if (currentPage && pendingReplies.length) await signal(currentPage.id, {
      kind: "tp.replies",
      tasks: pendingReplies.slice(0, 3).reverse().map(task => ({
        id: task.id, name: task.name, revision: rules.revision(task), failed: task.failed
      }))
    });
  }
  return { ok: true };
}

async function markVisited(tabId, windowId) {
  const state = await getState();
  if (!await readForeground(state, tabId, windowId)) return;
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
    const finish = tab => {
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
    const updated = (changedId, _change, tab) => { if (changedId === tabId) check(tab); };
    const removed = changedId => { if (changedId === tabId) finish(null); };
    const timer = setTimeout(() => finish(null), 10_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    void chrome.tabs.get(tabId).then(check, () => finish(null));
  });
}

async function focusConversation(id, agentId) {
  for (const candidate of await pages()) {
    if (web.conversationId(candidate.url) !== id) continue;
    const actual = await chrome.tabs.get(candidate.id).catch(() => null);
    if (!isReady(actual) || web.conversationId(actual.url) !== id) continue;
    await rememberJump(actual.id, id);
    const result = await focusTab(actual).catch(() => null);
    if (!result?.focused) continue;
    const arrived = await foregroundPage();
    if (arrived?.id === actual.id && web.conversationId(arrived.url) === id) return true;
  }
  const url = web.conversationUrl(id, agentId);
  if (!url) return false;
  const created = await chrome.tabs.create({ url, active: true });
  await rememberJump(created.id, id);
  if (!await raiseWindow(created) || !await waitForLanding(created.id, id)) return false;
  const arrived = await foregroundPage();
  return arrived?.id === created.id && web.conversationId(arrived.url) === id;
}

async function openTask(id, revision, allowSavedId = false) {
  if (!web.id(id) || typeof revision !== "string" || revision.split("/")[0] !== id) return { ok: false };
  const jobs = opening.get(id) || new Map();
  if (jobs.has(revision)) return jobs.get(revision);
  opening.set(id, jobs);

  const job = navigationLane.then(async () => {
    await jumpReady;
    const state = await getState();
    const task = state.tasks[id];
    if (!task && !allowSavedId) return { ok: false };
    const agentId = web.id(revision.split("/")[1]) || task?.agentId;
    if (!await focusConversation(id, agentId)) return { ok: false };
    return serialize(async () => {
      const fresh = await getState();
      if (/HTTP (401|403)/.test(fresh.error)) return { ok: false };
      const current = fresh.tasks[id];
      if (current && rules.revision(current) === revision) {
        if (current.pending && !rules.canAcknowledge(current)) {
          return { ok: true, clearNotice: false };
        }
        if (rules.canAcknowledge(current)) await acknowledge(fresh, current);
      }
      // An obsolete ticket may navigate and dismiss only its own notification.
      return { ok: true, clearNotice: true };
    });
  });
  jobs.set(revision, job);
  navigationLane = job.catch(() => {});
  try {
    return await job;
  } finally {
    jobs.delete(revision);
    if (!jobs.size) opening.delete(id);
  }
}

async function markChecked(id, revision, checked) {
  if (!web.id(id) || typeof checked !== "boolean") return { ok: false };
  const state = await getState();
  const task = state.tasks[id];
  if (!task || rules.revision(task) !== revision || !rules.canAcknowledge(task)) return { ok: false };
  if (checked) {
    await acknowledge(state, task, true);
  } else if (task.checkedRevision === revision) {
    delete task.checkedRevision;
    await saveState(state);
  }
  return { ok: true };
}

async function userVisit(id, sender) {
  await jumpReady;
  if (!web.id(id) || opening.has(id) || jumpTabs.get(sender.tab.id) !== id) return { ok: false };
  const tab = await foregroundPage();
  if (tab?.id !== sender.tab.id || web.conversationId(tab.url) !== id || opening.has(id)) return { ok: false };
  await forgetJump(tab.id);
  await markVisited(tab.id, tab.windowId);
  return { ok: true };
}

function senderIsPage(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && web.conversationPage(sender.url ?? sender.tab.url) !== null;
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !senderIsPage(sender)) return false;
  let reply;
  if (msg.kind === "tp.ready") {
    refreshLeader();
    respond({ ok: true });
    return false;
  }
  if (msg.kind === "tp.webstate") reply = serialize(() => acceptReport(msg, sender));
  if (msg.kind === "tp.open") reply = openTask(msg.id, msg.revision);
  if (msg.kind === "tp.check") reply = serialize(() => markChecked(msg.id, msg.revision, msg.checked));
  if (msg.kind === "tp.visit" && !opening.has(msg.id)) reply = serialize(() => userVisit(msg.id, sender));
  if (!reply) return false;
  reply.then(respond, error => { info(error); respond({ ok: false }); });
  return true;
});

chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith(REPLY_NOTICE)) return;
  const revision = id.slice(REPLY_NOTICE.length);
  void openTask(revision.split("/")[0], revision, true).then(result => {
    if (result.ok && result.clearNotice !== false) return chrome.notifications.clear(id);
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

chrome.runtime.onInstalled.addListener(() => wake(true));
chrome.runtime.onStartup.addListener(() => wake());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) wake();
});

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (!(change.url || change.discarded !== undefined || change.frozen !== undefined || change.status === "complete")) return;
  void (async () => {
    await jumpReady;
    if (isPage(tab)) {
      refreshLeader();
      const cid = web.conversationId(tab.url);
      if (change.url && jumpTabs.has(id) && jumpTabs.get(id) !== cid) await forgetJump(id);
      if (tab.active && !jumpTabs.has(id) && !opening.has(cid) && (change.url || change.status === "complete")) {
        await serialize(() => markVisited(id, tab.windowId));
      }
    } else {
      if (change.url && tab.url !== "about:blank") await forgetJump(id);
      if ((await getLeader())?.tabId === id) refreshLeader();
    }
  })().catch(info);
});
chrome.tabs.onRemoved.addListener(id => {
  void forgetJump(id);
  void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void (async () => {
    await jumpReady;
    // A genuine switch away releases the previous tab's versioned protection.
    for (const id of [...jumpTabs.keys()]) {
      if (id === tabId) continue;
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab || tab.windowId === windowId && !tab.active) await forgetJump(id);
    }
    await serialize(() => markVisited(tabId, windowId));
  })().catch(info);
});
chrome.windows.onFocusChanged.addListener(windowId => {
  const duringJump = opening.size > 0;
  void (async () => {
    await jumpReady;
    if (!duringJump && !opening.size) {
      const win = await chrome.windows.getLastFocused({}).catch(() => null);
      // Ignore delayed/temporary blur events when the window is actually focused.
      if (windowId >= 0 || !win?.focused) {
        for (const id of [...jumpTabs.keys()]) {
          const tab = await chrome.tabs.get(id).catch(() => null);
          if (!tab || tab.windowId !== windowId) await forgetJump(id);
        }
      }
    }
    await serialize(() => markVisited(undefined, windowId));
  })().catch(info);
});

chrome.action.onClicked.addListener(tab => {
  void (async () => {
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
