// Manifest V3 service worker. Collection stays in one DataAgent tab.
importScripts("config.js", "state.js");

const web = globalThis.TaskPulseWeb;
const rules = globalThis.TaskPulseState;
const ALARM = "tp-web-sync";
const REPLY_NOTICE = "tp-reply:";
const contentFiles = chrome.runtime.getManifest().content_scripts[0].js;
const opening = new Map();
const jumpTabs = new Map();

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

function activeConversation(tab, visit = false) {
  const id = web.conversationId(tab?.url);
  return opening.has(id) || visit && jumpTabs.get(tab?.id) === id ? "" : id;
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
    if (notice.retryAt > now) continue;
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

async function acknowledge(state, task, checked = false) {
  const revision = rules.revision(task);
  state.tasks[task.id] = rules.acknowledge(task);
  if (checked) state.tasks[task.id].checkedRevision = revision;
  const prefix = task.id + "/" + task.agentId + "/";
  for (const key of Object.keys(state.outbox || {})) {
    if (key.startsWith(prefix)) delete state.outbox[key];
  }
  await saveState(state);
  await Promise.allSettled([
    chrome.notifications.getAll().then(existing => Promise.allSettled(
      Object.keys(existing).filter(key => key.startsWith(REPLY_NOTICE + prefix)).map(key => chrome.notifications.clear(key))
    )),
    updateBadge(state)
  ]);
}

async function acceptReport(msg, sender) {
  const leader = await getLeader();
  if (!leader || leader.tabId !== sender.tab.id || leader.pageId !== msg.pageId || leader.lease !== msg.lease) {
    return { ok: false };
  }
  const state = await getState();
  const page = await foregroundPage();
  const { state: next, replies } = rules.absorb(state, msg.payload, Date.now(), activeConversation(page));
  if (next !== state) {
    next.outbox = { ...next.outbox };
    for (const task of replies) next.outbox[rules.revision(task)] = { name: task.name, retryAt: 0, at: next.at };
    for (const [revision, notice] of Object.entries(next.outbox)) {
      if (next.at - notice.at > 24 * 60 * 60_000) delete next.outbox[revision];
    }
    await saveState(next);
    const pageNotices = page && replies.length ? signal(page.id, {
      kind: "tp.replies",
      tasks: replies.slice(0, 3).reverse().map(task => ({
        id: task.id, name: task.name, revision: rules.revision(task), failed: task.failed
      }))
    }) : null;
    await Promise.allSettled([deliverNotices(next), pageNotices, updateBadge(next)]);
  }
  return { ok: true };
}

async function markVisited(tabId, windowId) {
  const tab = await foregroundPage();
  if (!tab || tabId !== undefined && tab.id !== tabId || windowId !== undefined && tab.windowId !== windowId) return;
  const id = activeConversation(tab, true);
  if (!id) return;
  const state = await getState();
  const task = state.tasks[id];
  if (state.error || !task?.pending || task.runAt || task.listedAt !== state.listAt ||
      task.queueError || Date.now() - task.observedAt > web.timing.queueStale) return;
  await acknowledge(state, task);
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
    jumpTabs.set(actual.id, id);
    const result = await focusTab(actual).catch(() => null);
    if (!result?.focused) continue;
    const arrived = await foregroundPage();
    if (arrived?.id === actual.id && web.conversationId(arrived.url) === id) return true;
  }
  const url = web.conversationUrl(id, agentId);
  if (!url) return false;
  const created = await chrome.tabs.create({ url, active: true });
  jumpTabs.set(created.id, id);
  if (!await raiseWindow(created) || !await waitForLanding(created.id, id)) return false;
  const arrived = await foregroundPage();
  return arrived?.id === created.id && web.conversationId(arrived.url) === id;
}

async function openTask(id, revision, allowSavedId = false) {
  if (!web.id(id) || typeof revision !== "string" || revision.split("/")[0] !== id) return { ok: false };
  if (opening.has(id)) return opening.get(id);

  const job = (async () => {
    const state = await getState();
    const task = state.tasks[id];
    if (!task && !allowSavedId) return { ok: false };
    const agentId = task?.agentId ?? web.id(revision.split("/")[1]);
    if (!await focusConversation(id, agentId)) return { ok: false };
    return serialize(async () => {
      const fresh = await getState();
      if (/HTTP (401|403)/.test(fresh.error)) return { ok: false };
      const current = fresh.tasks[id];
      if (current && rules.revision(current) === revision && !current.runAt) await acknowledge(fresh, current);
      return { ok: true };
    });
  })();
  opening.set(id, job);
  try {
    return await job;
  } finally {
    opening.delete(id);
  }
}

async function markChecked(id, revision, checked) {
  if (!web.id(id) || typeof checked !== "boolean") return { ok: false };
  const state = await getState();
  const task = state.tasks[id];
  if (!task || rules.revision(task) !== revision || task.runAt || task.status === "running") return { ok: false };
  if (checked) {
    await acknowledge(state, task, true);
  } else if (task.checkedRevision === revision) {
    delete task.checkedRevision;
    await saveState(state);
  }
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
  if (!reply) return false;
  reply.then(respond, error => { info(error); respond({ ok: false }); });
  return true;
});

chrome.notifications.onClicked.addListener(id => {
  if (!id.startsWith(REPLY_NOTICE)) return;
  const revision = id.slice(REPLY_NOTICE.length);
  void openTask(revision.split("/")[0], revision, true).then(result => {
    if (result.ok) return chrome.notifications.clear(id);
  }).catch(info);
});

function wake(install = false) {
  void serialize(async () => {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (install) await chrome.alarms.clear("tp-sync");
    await syncLeader({ install, nudge: true });
    const state = await getState();
    await Promise.allSettled([deliverNotices(state), updateBadge(state)]);
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => wake(true));
chrome.runtime.onStartup.addListener(() => wake());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) wake();
});

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.discarded !== undefined || change.frozen !== undefined || change.status === "complete") {
    if (isPage(tab)) {
      refreshLeader();
      const cid = web.conversationId(tab.url);
      if (change.url && jumpTabs.has(id) && jumpTabs.get(id) !== cid) jumpTabs.delete(id);
      if (tab.active && !jumpTabs.has(id) && !opening.has(cid) && (change.url || change.status === "complete")) {
        void serialize(() => markVisited(id, tab.windowId)).catch(() => {});
      }
    } else {
      if (change.url && tab.url !== "about:blank") jumpTabs.delete(id);
      void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
    }
  }
});
chrome.tabs.onRemoved.addListener(id => {
  jumpTabs.delete(id);
  void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const id of jumpTabs.keys()) {
    if (id !== tabId) {
      void chrome.tabs.get(id).then(tab => { if (tab.windowId === windowId && !tab.active) jumpTabs.delete(id); }).catch(() => {});
    }
  }
  if (!jumpTabs.has(tabId)) void serialize(() => markVisited(tabId, windowId)).catch(() => {});
});
chrome.windows.onFocusChanged.addListener(windowId => {
  void serialize(() => markVisited(undefined, windowId)).catch(() => {});
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
