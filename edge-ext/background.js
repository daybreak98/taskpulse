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
const WEBSTATE_ENDPOINT = BASE + "/webstate";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上报里带上「我是哪个浏览器」：初装引导要据此判断「用户刚装的那个浏览器连上没有」。
// 只看 UA，不涉及任何页面内容。
const BROWSER = (() => {
  const ua = (self.navigator && self.navigator.userAgent) || "";
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Chrome/")) return "chrome";
  return "unknown";
})();

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
    // web 段是排障用的自检：装上报里就能看出「为什么浏览器内取数没起来」
    let registered = [];
    try {
      registered = (await chrome.scripting.getRegisteredContentScripts({ ids: ["tp-web-bridge"] }))
        .map((s) => s.matches.join(","));
    } catch (_) {}
    const web = {
      hasApi: !!API_CFG,
      scripting: !!chrome.scripting,
      pages: tabs.length,
      registered: registered,
    };
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at: Date.now(), browser: BROWSER, tabs, active, web })
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
    // 后台窗口里的程序化切标签不该算「用户在看」→ 带上窗口是否聚焦
    let focused = false;
    try {
      const w = await chrome.windows.get(t.windowId);
      focused = !!(w && w.focused);
    } catch (_) {}
    await fetch(ACTIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: t.url, focused, at: Date.now() })
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
    nudgeWebBridge();
  }
});

// 页面在后台时浏览器会把 setInterval 节流到分钟级，页面内取数就跟着停摆。
// 由后台主动去敲一下（executeScript 不受页面定时器节流限制），只敲最前面几个，
// 免得几十个标签页一起打接口。
async function nudgeWebBridge() {
  if (!SCOPE || !API_CFG || !chrome.scripting) return;
  try {
    const tabs = await chrome.tabs.query({ url: SCOPE });
    // 只敲一个页面就够（各页数据相同），失败再换下一个
    for (const t of tabs.slice(0, 2)) {
      if (typeof t.id !== "number") continue;
      const r = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => { if (window.__tpWebBridgeTick) window.__tpWebBridgeTick(); }
      }).catch(() => null);
      if (r) break;
    }
  } catch (_) {}
}

// 只在上报「切到」这个标签时记已读。
// 曾经这里还会补记「被切走的那个标签」，但它会把用户没看的会话误标已读：
// 从 TaskPulse 点任务跳转时，扩展切走的上一个标签会被当成「看过了」，
// 于是另一个待处理任务的计数凭空消失。切到某标签的那次上报已经覆盖了
// 「看了再切走」的场景（进入即已读），补记是冗余且有害的。
chrome.tabs.onActivated.addListener((info) => {
  notifyActive(info.tabId);
  push();
});

// 窗口失焦/回焦时同步「是否正在看」，避免在别的 App 里时把回复误判为已读
chrome.windows.onFocusChanged.addListener(() => push());

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

// ── 数据来源二：在开着的 DataAgent 页面里用 cookie 取数 ──────────────
// 由 config.js 的 scope 决定注入哪些页面，manifest 里不写死域名。
const API_CFG = CFG.api || null;

async function ensureWebBridge() {
  if (!SCOPE || !chrome.scripting) return;
  try {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: ["tp-web-bridge"] });
    if (old.length) await chrome.scripting.unregisterContentScripts({ ids: ["tp-web-bridge"] });
  } catch (_) {}
  try {
    await chrome.scripting.registerContentScripts([{
      id: "tp-web-bridge",
      matches: [SCOPE],
      js: ["web-bridge.js"],
      runAt: "document_idle",
      persistAcrossSessions: true
    }]);
  } catch (_) {
    // 页面已打开时需要手动刷新一次才会注入
  }
}

async function injectIntoOpenTabs() {
  if (!SCOPE || !chrome.scripting) return;
  try {
    const tabs = await chrome.tabs.query({ url: SCOPE });
    for (const t of tabs) {
      if (typeof t.id !== "number") continue;
      // 已开着的页面收不到新注册的 content script，这里补一次；页面内自己会去重
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["web-bridge.js"] })
        .catch(() => void 0);
    }
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg) return;
  if (msg.kind === "get-config") {
    respond(API_CFG ? { api: API_CFG } : null);
    return;
  }
  if (msg.kind === "webstate" && msg.payload) {
    fetch(WEBSTATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload)
    }).then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
    return true;
  }
});

ensureWebBridge().then(injectIntoOpenTabs);
