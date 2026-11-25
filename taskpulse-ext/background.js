// 纯扩展版 TaskPulse：没有本机进程、没有 Python、没有签名。
//
// 数据链路：
//   页面里的 web-bridge.js 用页面自己的 cookie 拉会话与队列
//     → 发给本 service worker
//     → 存进 chrome.storage.local
//     → 侧边栏 panel.html 读出来算状态、渲染
//
// 这里只做三件事：选一个页面负责采集、把数据落盘、给面板提供标签映射。

const SCOPE = "https://dataagent.corp.kuaishou.com/*";

// 配置内置：不依赖安装脚本生成，装上就能跑。
// 换环境时改这份对象即可（api 的字段名与平台一致）。
const CONFIG = {
  scope: SCOPE,
  api: {
    convPage: "https://dataagent.corp.kuaishou.com/ai/data-agent",
    prefix: "/rest/flow/api/v1",
    conv: "/conversations/list",
    queue: "/conversations/{cid}/queue",
    messages: "/conversations/{cid}/messages?pageNo=1&pageSize=1",
    state: "sessionState",
    pending: "pending",
    idle: ["IDLE"],
    body: {
      agentIdList: [515, 2528, 4033],
      isCurAgent: false,
      searchKey: "",
      ungroupedPageNo: 1,
      ungroupedPageSize: 60
    },
    marks: ["当前服务繁忙", "tpm limit"]
  }
};

const LEADER_KEY = "tp-leader-tab";
const SNAPSHOT_KEY = "tp-tabs";
const WEBSTATE_KEY = "tp-webstate";

// ---------- 标签快照：给面板做 conversationId → tabId 映射 ----------

function cidOf(url) {
  const m = /[?&]conversationId=(\d+)/.exec(url || "");
  return m ? m[1] : "";
}

async function snapshotTabs() {
  const tabs = await chrome.tabs.query({ url: SCOPE });
  const out = [];
  for (const t of tabs) {
    const cid = cidOf(t.url);
    let group = "";
    if (typeof t.groupId === "number" && t.groupId >= 0) {
      try {
        group = (await chrome.tabGroups.get(t.groupId)).title || "";
      } catch (_) {}
    }
    out.push({
      tabId: t.id,
      windowId: t.windowId,
      cid,
      title: t.title || "",
      url: t.url || "",
      group,
      active: !!t.active
    });
  }
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: { at: Date.now(), tabs: out } });
  return out;
}

// ---------- 选主：几十个标签页只让一个去采集 ----------

function isConversationTab(t) {
  return !!cidOf(t.url);
}

async function pickLeader() {
  const tabs = (await chrome.tabs.query({ url: SCOPE })).filter(isConversationTab);
  if (!tabs.length) return null;
  // 优先用户正在看的那一页；没有就取第一个
  return tabs.find((t) => t.active) || tabs[0];
}

let leaderTabId = null;

async function syncLeader(force = false) {
  const leader = await pickLeader();
  const next = leader ? leader.id : null;
  if (!force && next === leaderTabId) return;
  leaderTabId = next;
  await chrome.storage.local.set({ [LEADER_KEY]: next });
  const tabs = await chrome.tabs.query({ url: SCOPE });
  for (const t of tabs) {
    try {
      chrome.tabs.sendMessage(t.id, { kind: "tp-role", leader: t.id === next }, () => void 0);
    } catch (_) {}
  }
}

// 页面被浏览器节流时定时器会停摆，靠这里每 30 秒敲一下
async function nudge() {
  if (leaderTabId == null) return;
  try {
    chrome.tabs.sendMessage(leaderTabId, { kind: "tp-nudge" }, () => void 0);
  } catch (_) {}
}

// ---------- 消息 ----------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.kind) return;

  if (msg.kind === "get-config") {
    respond(CONFIG);
    return true;
  }

  if (msg.kind === "tp-role-ask") {
    respond({ leader: sender.tab && sender.tab.id === leaderTabId });
    return true;
  }

  if (msg.kind === "webstate") {
    chrome.storage.local.set({ [WEBSTATE_KEY]: msg.payload }, () => respond({ ok: true }));
    updateBadge(msg.payload);
    return true;
  }
  return false;
});

// ---------- 徽章：待我处理的数量 ----------

async function updateBadge(payload) {
  try {
    const { [WEBSTATE_KEY]: snap, tpSeen } = await chrome.storage.local.get([WEBSTATE_KEY, "tpSeen"]);
    const counts = countStates(snap || payload, tpSeen || {});
    const n = counts.attention + counts.stuck;
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#F6BD68" });
  } catch (_) {}
}

// 与面板共用的一套判定（保持简单版：只看忙不忙 + updateTime 是否新）
function countStates(snap, seen) {
  const convs = (snap && snap.conversations) || [];
  const queues = (snap && snap.queues) || {};
  const out = { running: 0, attention: 0, stuck: 0 };
  const now = Date.now();
  for (const c of convs) {
    const cid = String(c.id);
    const q = queues[cid];
    const st = q ? q[CONFIG.api.state] : null;
    const pending = q ? q[CONFIG.api.pending] : null;
    const busy = q ? (Boolean(pending) || CONFIG.api.idle.indexOf(st) < 0) : null;
    const updated = c.updateTime || 0;
    const acked = seen[cid] || 0;
    if (busy === true) {
      if (now - updated > 30 * 60 * 1000) out.stuck += 1;
      else out.running += 1;
    } else if (updated > acked) {
      out.attention += 1;
    }
  }
  return out;
}

// ---------- 生命周期 ----------

async function refreshAll() {
  await snapshotTabs();
  await syncLeader(true);
  await nudge();
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_) {}
  refreshAll();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
  refreshAll();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tp-sync") refreshAll();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && !info.status && !info.groupId) return;
  if (tab.url && tab.url.startsWith("https://dataagent.corp.kuaishou.com/")) refreshAll();
});

chrome.tabs.onRemoved.addListener(() => refreshAll());
chrome.tabGroups.onUpdated.addListener(() => refreshAll());
chrome.tabGroups.onRemoved.addListener(() => refreshAll());

// 点扩展图标时打开侧边栏（部分版本不支持 setPanelBehavior 的兜底）
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (_) {
    chrome.windows.create({ url: "panel.html", type: "popup", width: 380, height: 760 });
  }
});

refreshAll();
