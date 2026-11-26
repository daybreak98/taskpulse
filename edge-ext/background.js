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

// 本机服务的身份头：poller 只认 X-TP-Token，没带或不一致一律 401。
// 密钥由 install.command 生成并写进 config.js，所以扩展装上即可用；
// 读不到就按空串发（表现为 401），而不是干脆不发——那样更难看出是缺密钥。
const TOKEN = String(CFG.token || "");
const authHeaders = (extra) => Object.assign({ "X-TP-Token": TOKEN }, extra || {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上报里带上「我是哪个浏览器」：初装引导要据此判断「用户刚装的那个浏览器连上没有」。
// 只看 UA，不涉及任何页面内容。
const BROWSER = (() => {
  const ua = (self.navigator && self.navigator.userAgent) || "";
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Chrome/")) return "chrome";
  return "unknown";
})();

let collectorPromise = null;
let modeActionScope = "";
function collectorId() {
  if (!collectorPromise) {
    collectorPromise = (async () => {
      const key = "tp-desktop-collector";
      const saved = await chrome.storage.local.get(key);
      if (typeof saved[key] === "string" && saved[key].startsWith(BROWSER + "-")) return saved[key];
      const id = BROWSER + "-" + crypto.randomUUID();
      await chrome.storage.local.set({ [key]: id });
      return id;
    })().catch(() => { collectorPromise = null; return ""; });
  }
  return collectorPromise;
}

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
      url: t?.status === "complete" && !t.discarded && !t.frozen && (!t.pendingUrl || t.pendingUrl === t.url) ? t.url || "" : "",
      tabId: (t && typeof t.id === "number") ? t.id : -1,
      focused: !!(w && w.focused)
    };
  } catch (_) {
    return { url: "", tabId: -1, focused: false };
  }
}

let pushSeq = 0;
async function push() {
  if (!SCOPE) return;
  const seq = ++pushSeq;
  const observedAt = Date.now();
  const actionScope = modeActionScope;
  try {
    const collector = await collectorId();
    if (!collector) return;
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
    if (seq !== pushSeq) return;
    await fetch(ENDPOINT, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ at: observedAt, action_scope: actionScope, browser: BROWSER, collector, tabs, active, web })
    });
  } catch (_) {
    // TaskPulse 没在跑时静默失败
  }
}

// 用户切到某个目标站点标签页 → 通知 TaskPulse 把对应任务标记为已查看
async function notifyActive(tabId, explicit = false, observedAt = Date.now()) {
  const actionScope = modeActionScope;
  try {
    const collector = await collectorId();
    const t = await chrome.tabs.get(tabId);
    if (!collector || !t || !t.active || t.status !== "complete" ||
        t.pendingUrl && t.pendingUrl !== t.url || !isConversationTab(t.url)) return;
    const w = await chrome.windows.get(t.windowId);
    const actual = await chrome.tabs.get(tabId);
    if (!w?.focused || !actual?.active || actual.url !== t.url || actual.status !== "complete" ||
        actual.pendingUrl && actual.pendingUrl !== actual.url) return;
    await fetch(ACTIVE_ENDPOINT, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ url: t.url, focused: true, at: observedAt, collector,
        action_scope: actionScope, explicit })
    });
  } catch (_) {}
}

// 按 conversationId 找到标签并切过去；找不到才新开
// 批量关闭会话标签：TaskPulse 已经按「没在工作 / 多久没更新」筛好了名单，
// 这里只负责关，并在关之前核对 URL——用户可能在两次上报之间又切了别的会话。
const CONV_PAGE = String((CFG.api && CFG.api.convPage) || "").replace(/\/+$/, "");

// 只认会话页：同域下还有登录页、分享页等，只判断 URL 里有没有 conversationId
// 不够严，批量关标签时可能误伤
function isConversationTab(url) {
  if (!url) return false;
  if (!CONV_PAGE) return true;        // 没配置前缀时保持旧行为
  if (!url.startsWith(CONV_PAGE)) return false;
  // 边界：前缀后必须结束、或紧跟 ? / # / /，
  // 否则 /ai/data-agent-history 这种也会被当成对话页
  const rest = url.slice(CONV_PAGE.length);
  return rest === "" || rest[0] === "?" || rest[0] === "#" || rest[0] === "/";
}

async function closeTabsFor(map, expires) {
  if (!!expires && Date.now() > expires) return 0;
  let closed = 0;
  for (const cid of Object.keys(map || {})) {
    const wanted = map[cid];
    let hit = null;
    const re = new RegExp("[?&]conversationId=" + cid + "(?:[&#]|$)");
    if (typeof wanted === "number") {
      try {
        const t = await chrome.tabs.get(wanted);
        if (t && isConversationTab(t.url) && re.test(t.url)) hit = t;
      } catch (_) {}
    }
    if (!hit && SCOPE) {
      try {
        const tabs = await chrome.tabs.query({ url: SCOPE });
        hit = tabs.find((t) => isConversationTab(t.url) && re.test(t.url));
      } catch (_) {}
    }
    if (!hit) continue;
    try {
      await chrome.tabs.remove(hit.id);
      closed += 1;
    } catch (_) {}
  }
  return closed;
}

function matchesConversation(url, cid, targetUrl = "") {
  if (!isConversationTab(url) || !/^\d+$/.test(cid)) return false;
  try {
    const actual = new URL(url).searchParams;
    const values = actual.getAll("conversationId");
    const agent = targetUrl ? new URL(targetUrl).searchParams.getAll("agentId") : [];
    return values.length === 1 && values[0] === cid &&
      (!agent.length || JSON.stringify(actual.getAll("agentId")) === JSON.stringify(agent));
  } catch (_) { return false; }
}

async function arrived(tabId, cid, targetUrl) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || !t.active || t.status !== "complete" || t.pendingUrl && t.pendingUrl !== t.url ||
      !matchesConversation(t.url, cid, targetUrl)) return false;
  const w = await chrome.windows.get(t.windowId).catch(() => null);
  const after = await chrome.tabs.get(tabId).catch(() => null);
  return !!w?.focused && !!after?.active && after.status === "complete" &&
    (!after.pendingUrl || after.pendingUrl === after.url) && matchesConversation(after.url, cid, targetUrl);
}

async function waitForArrival(tabId, cid, targetUrl) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await arrived(tabId, cid, targetUrl)) return true;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete" && t.url && t.url !== "about:blank" &&
        !matchesConversation(t.url, cid, targetUrl) && !matchesConversation(t.pendingUrl, cid, targetUrl)) return false;
    await sleep(100);
  }
  return false;
}

async function focusConversation(cid, url, tabId, expires, allowCreate = true) {
  if (!matchesConversation(url, cid, url)) return "not_started";
  const matches = t => t && (matchesConversation(t.url, cid, url) || matchesConversation(t.pendingUrl, cid, url));
  let hit = null;
  if (typeof tabId === "number") {
    try {
      const t = await chrome.tabs.get(tabId);
      if (matches(t)) hit = t;
    } catch (_) {}
  }
  if (!hit && SCOPE) {
    const tabs = await chrome.tabs.query({ url: SCOPE });
    hit = tabs.find(matches);
    if (!hit) hit = (await chrome.tabs.query({})).find(matches);
  }
  if (expires && Date.now() > expires) return "expired";
  if (hit) {
    const current = await chrome.tabs.get(hit.id).catch(() => null);
    if (!matches(current) || expires && Date.now() > expires) return "not_started";
    await chrome.tabs.update(hit.id, { active: true });
    if (typeof hit.windowId === "number") await chrome.windows.update(hit.windowId, { focused: true });
    return await waitForArrival(hit.id, cid, url) ? "focused" : "unconfirmed";
  }
  if (!allowCreate) return "not_started";
  const created = await chrome.tabs.create({ url, active: true });
  if (typeof created.windowId === "number") await chrome.windows.update(created.windowId, { focused: true });
  return await waitForArrival(created.id, cid, url) ? "created" : "unconfirmed";
}

// 长轮询：TaskPulse 点提示条时，命令在这里被毫秒级接走
let listening = false;
async function listen() {
  if (listening) return;
  listening = true;
  while (true) {
    try {
      const collector = await collectorId();
      if (!collector) { await sleep(1000); continue; }
      const r = await fetch(CMD_ENDPOINT + "?collector=" + encodeURIComponent(collector), {
        cache: "no-store", headers: authHeaders(), signal: AbortSignal.timeout(15000)
      });
      if (r.status === 200) {
        const cmd = await r.json();
        if (cmd && cmd.cmd === "closeTabs") {
          let n = 0;
          try {
            n = await closeTabsFor(cmd.tabIds || {}, cmd.expires);
          } catch (_) {}
          if (cmd.id) {
            try {
              await fetch(ACK_ENDPOINT + "?id=" + encodeURIComponent(cmd.id)
                          + "&result=closed&n=" + n,
                { method: "POST", headers: authHeaders() });
            } catch (_) {}
          }
        }
        if (cmd && cmd.cmd === "focus" && cmd.cid) {
          let how = "unknown";
          try {
            if (cmd.scope) {
              const mode = await fetch(BASE + "/mode", { cache: "no-store", headers: authHeaders(), signal: AbortSignal.timeout(3000) });
              const current = mode.ok ? await mode.json() : {};
              if (current.action_scope !== cmd.scope || cmd.collector !== collector) how = "not_started";
              else how = await focusConversation(String(cmd.cid), cmd.url || "", cmd.tabId, cmd.expires, cmd.allowCreate !== false);
            } else {
              how = await focusConversation(String(cmd.cid), cmd.url || "", cmd.tabId, cmd.expires);
            }
          } catch (_) {}
          if (cmd.id) {
            try {
              await fetch(ACK_ENDPOINT + "?id=" + encodeURIComponent(cmd.id)
                          + "&result=" + encodeURIComponent(how) + "&collector=" + encodeURIComponent(collector),
                { method: "POST", headers: authHeaders() });
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
  refreshSource().then(ensureLeader).catch(() => void 0);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("tp-sync", { periodInMinutes: 0.5 });
  push();
  listen();
  refreshSource().then(ensureLeader).catch(() => void 0);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tp-sync") {
    push();
    listen();   // service worker 被回收后在这里重新挂上长轮询
    // 顺手对账：leader 可能已被关掉/弃用，来源也可能刚被切成 api
    refreshSource()
      .then(ensureLeader)
      .then(nudgeWebBridge)
      .catch(() => void 0);
  }
});

// 页面在后台时浏览器会把 setInterval 节流到分钟级，页面内取数就跟着停摆。
// 由后台主动去敲一下（executeScript 不受页面定时器节流限制）。
// 各页数据完全相同，所以只敲 leader；否则一次唤醒就把几十个页面同时叫起来。
async function nudgeWebBridge() {
  if (!SCOPE || !API_CFG || !chrome.scripting) return;
  if (pausedByApi || leaderId === -1) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: leaderId },
      func: () => { if (window.__tpWebBridgeTick) window.__tpWebBridgeTick(); }
    });
  } catch (_) {}
}

// alarm 的最小周期在未打包扩展里也就 30 秒，页面被节流时数据会拖到半分钟以上。
// 用自排队的 setTimeout 补到 15 秒；长轮询本身就占着 service worker，
// 不会因为空闲被回收，alarm 只作为「被回收后叫醒」的兜底。
const NUDGE_MS = 5000;
function scheduleNudge() {
  setTimeout(async () => {
    try { await refreshSource(); await ensureLeader(); await nudgeWebBridge(); } catch (_) {}
    scheduleNudge();
  }, NUDGE_MS);
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

// 采集页只在「这一页不能干活了」时换人：关掉、被浏览器丢弃、页面刚加载完。
// 用户切标签不算——粘性换主会让每切一次都重新拉一遍会话列表。
chrome.tabs.onRemoved.addListener(() => ensureLeader());
chrome.tabs.onCreated.addListener(() => ensureLeader());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (!info) return;
  if (info.discarded !== undefined || info.frozen !== undefined || info.status === "complete" || info.url) ensureLeader();
});

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

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return;
  if (msg.kind === "get-config") {
    respond(API_CFG ? { api: API_CFG } : null);
    return;
  }
  if (msg.kind === "tp-user-visit" && sender?.frameId === 0 && Number.isInteger(sender?.tab?.id)) {
    void notifyActive(sender.tab.id, true, Number(msg.at) || 0);
    respond({ ok: true });
    return;
  }
  if (msg.kind === "tp-role-ask") {
    const tabId = sender?.tab?.id;
    const leader = typeof tabId === "number" && tabId === leaderId && sender?.frameId === 0 &&
      isConversationTab(sender.url) && !pausedByApi && !!modeGeneration && typeof msg.pageId === "string";
    if (leader) {
      if (leaderPageId && leaderPageId !== msg.pageId) roleLease = crypto.randomUUID();
      leaderPageId = msg.pageId;
      roleSent = roleKey();
    }
    respond({ leader, generation: modeGeneration, lease: roleLease });
    if (!leaderReady || leaderId === -1) ensureLeader();
    return;
  }
  if (msg.kind === "webstate" && msg.payload) {
    if (pausedByApi || sender?.tab?.id !== leaderId || sender?.frameId !== 0 || !isConversationTab(sender.url) ||
        msg.pageId !== leaderPageId || msg.lease !== roleLease || msg.payload.generation !== modeGeneration) {
      respond({ ok: false });
      return;
    }
    const lease = roleLease;
    void (async () => {
      const collector = await collectorId();
      if (!collector || lease !== roleLease || pausedByApi) return respond({ ok: false });
      const r = await fetch(WEBSTATE_ENDPOINT, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...msg.payload, browser: BROWSER, collector })
      });
      const result = await r.json();
      if (result.ignored === "old generation" || result.ignored === "other collector") {
        void refreshSource().catch(() => {});
      }
      respond({ ok: r.ok && !result.ignored });
    })().catch(() => respond({ ok: false }));
    return true;
  }
});

// ── 采集权：只让一个页面负责采集 ─────────────────────────────────
// 用户常开几十个 DataAgent 标签页，各页都跑 setInterval，等于把同一份数据拉几十遍；
// 这里选出一页当 leader，其余页面不开定时器，页面被换下时立刻停手。
const LEADER_KEY = "tp-leader-tab";
let leaderId = -1;        // 当前负责采集的标签页
let leaderReady = false;  // 是否已从 storage.session 读回上次的选主结果
let pausedByApi = true;
let modeGeneration = "";
let roleLease = crypto.randomUUID();
let leaderPageId = "";
let roleSent = null;
let roleSending = null;
const roleKey = () => roleLease + ":" + modeGeneration + ":" + String(!pausedByApi);
let electing = null;      // 在途的选主，避免事件成串时重复选
let electAgain = false;

async function postRole(tabId, leader) {
  const key = roleKey();
  const lease = roleLease;
  const generation = modeGeneration;
  try {
    const result = await chrome.tabs.sendMessage(tabId, { kind: "tp-role", leader, generation, lease }, { frameId: 0 });
    if (tabId === leaderId && key === roleKey() && typeof result?.pageId === "string") {
      leaderPageId = result.pageId;
      roleSent = key;
    }
  } catch (_) {}
}

function persistLeader(id) {
  try {
    const p = chrome.storage.session.set({ [LEADER_KEY]: id });
    if (p && p.catch) p.catch(() => void 0);
  } catch (_) {}
}

async function restoreLeader() {
  leaderReady = true;
  try {
    const got = await chrome.storage.session.get(LEADER_KEY);
    const v = got && got[LEADER_KEY];
    // service worker 随时会被回收：读回来才不至于每次唤醒都重新选主、重新拉列表
    if (typeof v === "number") leaderId = v;
  } catch (_) {}
}

function syncRole() {
  if (leaderId === -1) return;
  const key = roleKey();
  if (roleSent === key || roleSending === key) return;
  roleSending = key;
  void postRole(leaderId, !pausedByApi && !!modeGeneration).finally(() => {
    if (roleSending === key) roleSending = null;
  });
}

function applyLeader(next) {
  if (next === leaderId) {
    syncRole();   // 页面可能刚注入、还没收到过角色，这里补一句
    return;
  }
  const prev = leaderId;
  leaderId = next;
  roleLease = crypto.randomUUID();
  leaderPageId = "";
  roleSent = null;
  persistLeader(next);
  if (prev !== -1) void postRole(prev, false);
  syncRole();
}

async function pickLeader(tabs) {
  // discarded 的页面里没有 content script 在跑，敲了也不动；
  // status 不到 complete 的还在加载，dom 都还没稳，同样采不到东西
  const usable = tabs.filter((t) =>
    typeof t.id === "number" && !t.discarded && !t.frozen && t.status === "complete" && isConversationTab(t.url));
  if (!usable.length) return -1;

  let focusedWin = -1;
  try {
    const w = await chrome.windows.getLastFocused({});
    if (w && w.focused && typeof w.id === "number") focusedWin = w.id;
  } catch (_) {}
  // 用户正看着的那一页数据最新，优先给它
  const hot = usable.find((t) => t.active && t.windowId === focusedWin);
  if (hot) return hot.id;

  // 老版本 Edge 不给 lastAccessed，这时退化成「标签顺序靠前的先选」，宁可稳定也别空转
  let best = -1;
  let bestAt = -1;
  for (const t of usable) {
    const at = typeof t.lastAccessed === "number" ? t.lastAccessed : 0;
    if (at > bestAt) {
      bestAt = at;
      best = t.id;
    }
  }
  return best;
}

async function doEnsureLeader() {
  if (!SCOPE) return;
  if (!leaderReady) await restoreLeader();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SCOPE });
  } catch (_) {}
  const alive = new Map();
  for (const t of tabs) if (typeof t.id === "number") alive.set(t.id, t);

  let next = -1;
  if (leaderId !== -1) {
    const cur = alive.get(leaderId);
    // 粘性：leader 还活着就不要换，否则用户每切一次标签都要重新拉一遍会话列表
    if (cur && !cur.discarded && !cur.frozen && cur.status === "complete" && isConversationTab(cur.url)) next = leaderId;
  }
  if (next === -1) next = await pickLeader(tabs);
  applyLeader(next);
}

function ensureLeader() {
  // 关标签、切 url、加载完成会在同一瞬间连着来，合并成一次选主
  if (electing) {
    electAgain = true;   // 在途那次查的是旧快照，这次变化得再对一遍账
    return electing;
  }
  electing = (async () => {
    try {
      await doEnsureLeader();
    } catch (_) {}
    electing = null;
    if (electAgain) {
      electAgain = false;
      ensureLeader();
    }
  })();
  return electing;
}

// api 模式下页面采到的数据没人用，继续拉只是白发请求；所以定时看一眼来源，
// 切到 api 就收走 leader 的采集权，切回 web 再发还。
let modeRequest = 0;
async function refreshSource() {
  if (!API_CFG) return;
  const request = ++modeRequest;
  let data, collector;
  try {
    collector = await collectorId();
    const r = await fetch(BASE + "/mode", { cache: "no-store", headers: authHeaders(), signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    data = await r.json();
  } catch (_) { return; }
  if (request !== modeRequest || !collector || !["api", "web"].includes(data?.source) ||
      typeof data.generation !== "string") return;
  modeActionScope = typeof data.action_scope === "string" ? data.action_scope : "";
  const paused = data.source !== "web" || !!data.collector && data.collector !== collector;
  if (paused !== pausedByApi || modeGeneration !== data.generation) {
    pausedByApi = paused;
    modeGeneration = data.generation;
    roleLease = crypto.randomUUID();
    leaderPageId = "";
    roleSent = null;
  }
  syncRole();
}

ensureWebBridge().then(injectIntoOpenTabs).then(scheduleNudge);
refreshSource().then(ensureLeader).catch(() => void 0);
