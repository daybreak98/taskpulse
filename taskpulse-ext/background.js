// Manifest V3 service worker. Collection stays in one DataAgent tab.
importScripts("config.js", "state.js");

const web = globalThis.TaskPulseWeb;
const rules = globalThis.TaskPulseState;
const ALARM = "tp-web-sync";
const REPLY_NOTICE = "tp-reply:";
const contentFiles = chrome.runtime.getManifest().content_scripts[0].js;
const opening = new Map();

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
const isReady = tab => isPage(tab) && tab.status === "complete" && !tab.discarded && !tab.frozen;
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
    const answer = await signal(current.id, { kind: "tp.probe" });
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
    const answer = await signal(tab.id, { kind: "tp.probe" });
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

async function activeConversation() {
  const win = await chrome.windows.getLastFocused({}).catch(() => null);
  if (!win?.focused || !Number.isInteger(win.id) || win.id < 0) return "";
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  const id = web.conversationId(tab?.url);
  return opening.has(id) ? "" : id;
}

async function updateBadge(state) {
  const { counts } = rules.view(state, Date.now());
  const total = counts.attention + counts.stuck;
  await chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : "" });
}

async function sendNotices(tasks) {
  if (!tasks.length || await chrome.notifications.getPermissionLevel() !== "granted") return;
  for (const task of tasks) {
    await chrome.notifications.create(REPLY_NOTICE + rules.revision(task), {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title: "TaskPulse · 有新回复",
      message: task.name
    }).catch(info);
  }
}

async function acceptReport(msg, sender) {
  const leader = await getLeader();
  if (!leader || leader.tabId !== sender.tab.id || leader.pageId !== msg.pageId || leader.lease !== msg.lease) {
    return { ok: false };
  }
  const state = await getState();
  const active = await activeConversation();
  const { state: next, replies } = rules.absorb(state, msg.payload, Date.now(), active);
  if (next !== state) {
    // Record reply identities before emitting OS notifications so a worker restart cannot replay them.
    await saveState(next);
    await Promise.allSettled([sendNotices(replies), updateBadge(next)]);
  }
  return { ok: true };
}

async function markVisited() {
  const id = await activeConversation();
  if (!id) return;
  const state = await getState();
  const task = state.tasks[id];
  if (!task?.pending || task.status !== "attention" || opening.has(id) ||
      Date.now() - task.observedAt > web.timing.queueStale) return;
  state.tasks[id] = rules.acknowledge(task);
  await saveState(state);
  await updateBadge(state);
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

async function focusConversation(id, agentId) {
  // Re-read the tab before using it. A stored ID can now point to a different conversation.
  for (const candidate of await pages()) {
    if (web.conversationId(candidate.url) !== id) continue;
    const actual = await chrome.tabs.get(candidate.id).catch(() => null);
    if (web.conversationId(actual?.url) !== id) continue;
    const result = await focusTab(actual).catch(() => null);
    if (web.conversationId(result?.tab.url) === id) return { opened: true, seen: result.focused };
  }
  const url = web.conversationUrl(id, agentId);
  if (!url) return { opened: false };
  const created = await chrome.tabs.create({ url, active: true });
  const focused = await raiseWindow(created);
  return { opened: true, seen: focused && web.conversationId(created.url) === id };
}

async function openTask(id, revision, allowSavedId = false) {
  if (!web.id(id) || typeof revision !== "string" || revision.split("/")[0] !== id) return { ok: false };
  if (opening.has(id)) return opening.get(id);

  const job = (async () => {
    const state = await getState();
    const task = state.tasks[id];
    if (!task && !allowSavedId) return { ok: false };
    const agentId = task?.agentId ?? web.id(revision.split("/")[1]);
    const result = await focusConversation(id, agentId);
    if (result.seen) {
      await serialize(async () => {
        const fresh = await getState();
        const current = fresh.tasks[id];
        if (!current || rules.revision(current) !== revision) return;
        fresh.tasks[id] = rules.acknowledge(current);
        await saveState(fresh);
        await updateBadge(fresh);
      });
    }
    return { ok: result.opened };
  })();
  opening.set(id, job);
  try {
    return await job;
  } finally {
    opening.delete(id);
  }
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
    await updateBadge(await getState());
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
      if (tab.active && (change.url || change.status === "complete")) void serialize(markVisited).catch(() => {});
    } else {
      void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
    }
  }
});
chrome.tabs.onRemoved.addListener(id => {
  void getLeader().then(leader => { if (leader?.tabId === id) refreshLeader(); }).catch(info);
});
chrome.tabs.onActivated.addListener(() => { void serialize(markVisited).catch(() => {}); });
chrome.windows.onFocusChanged.addListener(() => { void serialize(markVisited).catch(() => {}); });

chrome.action.onClicked.addListener(tab => {
  void (async () => {
    const target = isPage(tab) ? tab : (await pages()).filter(isPage)[0];
    if (!target) {
      await chrome.tabs.create({ url: web.page, active: true });
      return;
    }
    if (target.id !== tab.id) await focusTab(target);
    const shown = await signal(target.id, { kind: "tp.show" });
    if (!shown && isReady(target)) {
      await chrome.scripting.executeScript({ target: { tabId: target.id }, files: contentFiles });
      await signal(target.id, { kind: "tp.show" });
    }
  })().catch(info);
});
