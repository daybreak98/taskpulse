// 侧边栏面板：完全没有本机服务参与。
// 数据全部来自 background 落在 chrome.storage 里的快照，状态判定在这里做。

const CONV_PAGE = "https://dataagent.corp.kuaishou.com/ai/data-agent";
const STUCK_MS = 30 * 60 * 1000;

const state = {
  snap: null,
  tabs: [],
  seen: {},
  done: {},
  filter: null
};

const el = {
  list: document.getElementById("list"),
  status: document.getElementById("status"),
  cRunning: document.getElementById("c-running"),
  cAttention: document.getElementById("c-attention"),
  cStuck: document.getElementById("c-stuck")
};

// ---------- 读取 ----------

async function load() {
  const got = await chrome.storage.local.get(["tp-webstate", "tp-tabs", "tpSeen", "tpDone"]);
  state.snap = got["tp-webstate"] || null;
  state.tabs = (got["tp-tabs"] && got["tp-tabs"].tabs) || [];
  state.seen = got.tpSeen || {};
  state.done = got.tpDone || {};
  render();
}

async function markSeen(cid, updated) {
  state.seen[cid] = updated;
  await chrome.storage.local.set({ tpSeen: state.seen });
  render();
}

async function markDone(cid) {
  state.done[cid] = true;
  await chrome.storage.local.set({ tpDone: state.done });
  render();
}

// ---------- 判定 ----------

function isBusy(q) {
  if (!q) return null;
  const st = q.sessionState;
  if (st == null || st === "") return null;
  return Boolean(q.pending) || ["IDLE"].indexOf(st) < 0;
}

function tabOf(cid) {
  return state.tabs.find((t) => t.cid === String(cid)) || null;
}

function buildTasks() {
  const snap = state.snap;
  if (!snap) return [];
  const queues = snap.queues || {};
  const now = Date.now();
  const out = [];
  for (const c of snap.conversations || []) {
    const cid = String(c.id);
    if (state.done[cid]) continue;
    const q = queues[cid];
    const busy = isBusy(q);
    const updated = c.updateTime || 0;
    const tab = tabOf(cid);
    let status;
    if (busy === true) status = now - updated > STUCK_MS ? "stuck" : "running";
    else if (updated > (state.seen[cid] || 0)) status = "attention";
    else status = "seen";
    out.push({
      cid,
      name: c.name || `会话 ${cid}`,
      agentId: c.agentId,
      updated,
      status,
      tabId: tab ? tab.tabId : null,
      group: (tab && tab.group) || c.groupName || ""
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// ---------- 渲染 ----------

function age(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return Math.floor(d / 1000) + "s";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "m";
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h";
  return Math.floor(d / 86_400_000) + "d";
}

function render() {
  const tasks = buildTasks();
  const counts = { running: 0, attention: 0, stuck: 0 };
  for (const t of tasks) {
    if (t.status === "running") counts.running += 1;
    else if (t.status === "attention") counts.attention += 1;
    else if (t.status === "stuck") counts.stuck += 1;
  }
  el.cRunning.textContent = counts.running;
  el.cAttention.textContent = counts.attention;
  el.cStuck.textContent = counts.stuck;

  const snapAt = state.snap && state.snap.at;
  if (!snapAt) {
    setStatus("还没有数据：先打开一个 DataAgent 会话页", true);
  } else if (Date.now() - snapAt > 180_000) {
    setStatus("页面已 3 分钟没上报，显示上次快照", true);
  } else {
    setStatus(`更新于 ${age(snapAt)}前`);
  }

  const shown = state.filter ? tasks.filter((t) => t.status === state.filter) : tasks;
  el.list.textContent = "";

  if (!shown.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = state.filter ? "这一类现在是空的" : "没有正在跑的任务";
    el.list.appendChild(d);
    return;
  }

  // 按标签组名分组；没有标签的统一放最后
  const groups = new Map();
  for (const t of shown) {
    const k = t.group || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const names = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  for (const name of names) {
    const rows = groups.get(name);
    const box = document.createElement("div");
    box.className = "group";
    const head = document.createElement("button");
    head.className = "group-head";
    head.innerHTML = `<span class="name"></span><span>${rows.length}</span>`;
    head.querySelector(".name").textContent = name || "未分组";
    box.appendChild(head);
    for (const t of rows) box.appendChild(rowNode(t));
    el.list.appendChild(box);
  }
}

function setStatus(text, warn) {
  el.status.textContent = text;
  el.status.parentElement.classList.toggle("warn", !!warn);
}

function rowNode(t) {
  const row = document.createElement("button");
  row.className = "row " + t.status;
  row.title = t.cid + (t.tabId ? `（标签 ${t.tabId}）` : "（未打开）");

  const dot = document.createElement("span");
  dot.className = "dot";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = t.name;
  const ageEl = document.createElement("span");
  ageEl.className = "age";
  ageEl.textContent = t.updated ? age(t.updated) : "";
  const check = document.createElement("span");
  check.className = "check";
  check.textContent = "✓";
  check.title = "标记处理完毕";

  row.append(dot, name, ageEl, check);

  row.addEventListener("click", (e) => {
    if (e.target === check) {
      e.stopPropagation();
      markDone(t.cid);
      return;
    }
    openTask(t);
  });
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    markDone(t.cid);
  });
  return row;
}

// ---------- 动作 ----------

async function openTask(t) {
  // 先记已读：即便标签已经关了，用户也算看过了
  markSeen(t.cid, t.updated);
  if (t.tabId != null) {
    try {
      const tab = await chrome.tabs.get(t.tabId);
      await chrome.tabs.update(t.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch (_) {}
  }
  const url = `${CONV_PAGE}?agentId=${t.agentId ?? ""}&openHistory=true&conversationId=${t.cid}&formPage=web`;
  await chrome.tabs.create({ url });
}

// 计数按钮做过滤
for (const btn of document.querySelectorAll(".count")) {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.kind;
    state.filter = state.filter === kind ? null : kind;
    for (const b of document.querySelectorAll(".count")) {
      b.classList.toggle("on", b.dataset.kind === state.filter);
    }
    render();
  });
}

// ---------- 刷新 ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes["tp-webstate"] || changes["tp-tabs"]) load();
});

// 时间戳每秒都在变，光靠 storage 事件不会重绘
setInterval(render, 5000);

load();
