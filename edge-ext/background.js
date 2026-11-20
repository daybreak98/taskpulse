// 只收集「你配置的那个站点」的标签页：标题、URL、所属标签组名。
// 数据只发往 127.0.0.1，不落盘、不外传。

try { importScripts("config.js"); } catch (_) { /* 没生成过配置就当作没配置 */ }

const CFG = self.TP_CONFIG || {};
const SCOPE = (CFG.scope || "").trim();          // 例如 https://agent.example.com/*
const ORIGIN = SCOPE.replace(/\/\*$/, "").replace(/\/+$/, "");
const BASE = "http://127.0.0.1:" + (CFG.port || 8899);
const ENDPOINT = BASE + "/tabs";
const ACTIVE_ENDPOINT = BASE + "/active";
const CMD_ENDPOINT = BASE + "/cmd";
const ACK_ENDPOINT = BASE + "/cmd/ack";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot() {
  if (!SCOPE) return [];
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ url: SCOPE }),
    chrome.tabGroups.query({})
  ]);
  const nameOf = new Map(groups.map((g) => [g.id, g.title || ""]));
  return tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "",
    url: t.url || "",
    groupId: typeof t.groupId === "number" ? t.groupId : -1,
    group: (typeof t.groupId === "number" && nameOf.get(t.groupId)) || ""
  }));
}

// 当前用户正在看哪个标签页（要求 Edge 窗口本身是聚焦的，切到别的 App 就不算）
async function activeInfo() {
  try {
    const w = await chrome.windows.getLastFocused({});
    let t = null;
    if (w && typeof w.id === "number") {
      const tabs = await chrome.tabs.query({ active: true, windowId: w.id });
      t = tabs && tabs[0];
    }
    return {
      url: (t && t.url) || "",
      tabId: (t && typeof t.id === "number") ? t.id : -1,
      focused: !!(w && w.focused)
    };
  } catch (_) {
    return { url: "", tabId: -1, focused: false };
  }
}

async function push() {
  if (!SCOPE) return;
  try {
    const [tabs, active] = await Promise.all([snapshot(), activeInfo()]);
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at: Date.now(), tabs, active })
    });
  } catch (_) {
    // TaskPulse 没在跑时静默失败
  }
}

// 用户切到某个目标站点标签页 → 通知 TaskPulse 把对应任务标记为已查看
async function notifyActive(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t || !t.url || !ORIGIN || !t.url.startsWith(ORIGIN + "/")) return;
    await fetch(ACTIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: t.url, at: Date.now() })
    });
  } catch (_) {}
}

// 按 conversationId 找到标签并切过去；找不到才新开
async function focusConversation(cid, url, tabId) {
  const re = new RegExp("[?&]conversationId=" + cid + "(?:[&#]|$)");
  let hit = null;
  // 优先用 TaskPulse 缓存的 tabId（单标签查询，比全量 query 快一个量级）
  if (typeof tabId === "number") {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.url && re.test(t.url)) hit = t;
    } catch (_) {}
  }
  if (!hit && SCOPE) {
    const tabs = await chrome.tabs.query({ url: SCOPE });
    hit = tabs.find((t) => t.url && re.test(t.url));
  }
  if (hit) {
    // 切标签与把窗口激活到前台并行发起，省掉一次串行等待
    const jobs = [chrome.tabs.update(hit.id, { active: true })];
    if (typeof hit.windowId === "number") {
      jobs.push(chrome.windows.update(hit.windowId, { focused: true }).catch(() => {}));
    }
    await Promise.all(jobs);
  } else if (url) {
    await chrome.tabs.create({ url, active: true });
  }
}

// 长轮询：TaskPulse 点提示条时，命令在这里被毫秒级接走
let listening = false;
async function listen() {
  if (listening) return;
  listening = true;
  while (true) {
    try {
      const r = await fetch(CMD_ENDPOINT, { cache: "no-store" });
      if (r.status === 200) {
        const cmd = await r.json();
        if (cmd && cmd.cmd === "focus" && cmd.cid) {
          await focusConversation(String(cmd.cid), cmd.url || "", cmd.tabId);
          if (cmd.id) {
            try {
              await fetch(ACK_ENDPOINT + "?id=" + encodeURIComponent(cmd.id), { method: "POST" });
            } catch (_) {}
          }
        }
      } else {
        await sleep(300);
      }
    } catch (_) {
      await sleep(1000);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
  push();
  listen();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
  push();
  listen();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tp-sync") {
    push();
    listen();   // service worker 被回收后在这里重新挂上长轮询
  }
});

// 每个窗口上一次的活跃标签：切走时也要把它补记成已读
const lastActive = new Map();

chrome.tabs.onActivated.addListener((info) => {
  const prev = lastActive.get(info.windowId);
  lastActive.set(info.windowId, info.tabId);
  // 切出也算已读：先补记被切走的那个标签页
  if (typeof prev === "number" && prev !== info.tabId) notifyActive(prev);
  notifyActive(info.tabId);
  push();
});

// 窗口失焦/回焦时同步「是否正在看」，避免在别的 App 里时把回复误判为已读
chrome.windows.onFocusChanged.addListener(() => push());

// 冷启动时先把各窗口的活跃标签记下来
(async () => {
  try {
    const wins = await chrome.windows.getAll({});
    for (const w of wins) {
      const tabs = await chrome.tabs.query({ active: true, windowId: w.id });
      if (tabs && tabs[0] && typeof tabs[0].id === "number") lastActive.set(w.id, tabs[0].id);
    }
  } catch (_) {}
})();

for (const ev of [
  chrome.tabs.onUpdated,
  chrome.tabs.onCreated,
  chrome.tabs.onRemoved,
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabGroups.onUpdated,
  chrome.tabGroups.onCreated,
  chrome.tabGroups.onRemoved
]) {
  if (ev && ev.addListener) ev.addListener(() => push());
}

chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
push();
listen();
