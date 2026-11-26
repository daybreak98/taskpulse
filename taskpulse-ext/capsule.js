(async () => {
  const web = globalThis.TaskPulseWeb, rules = globalThis.TaskPulseState, ui = globalThis.TaskPulseUI;
  const hostId = "taskpulse-web-capsule";
  const native = !!web.conversationPage(location.href);
  const side = !native && location.href === chrome.runtime.getURL("sidepanel.html");
  const [frameMode, token] = !native && !side ? location.hash.slice(1).split("/") : [];
  const frame = !native && !side && ["panel", "toast"].includes(frameMode);
  const toastOnly = frame && frameMode === "toast";
  if ((!native && !side && !frame) || !ui || globalThis.taskPulseCapsule?.alive()) return;

  document.getElementById(hostId)?.remove();
  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }
  globalThis.taskPulseCapsule = { alive };
  let attached = null;
  if (frame || side) {
    attached = await chrome.runtime.sendMessage({ kind: "tp.surface.attach", token }).catch(() => null);
    if (!attached?.ok) return;
  }
  const post = message => { if (frame) parent.postMessage(message, attached.origin); };
  const request = (kind, fields = {}) => chrome.runtime.sendMessage({ kind, ...fields, ...(frame ? { token } : {}) });

  const names = { running: "运行中", attention: "待处理", stuck: "疑似卡住", seen: "已查看", done: "已处理" };
  const kinds = ["running", "attention", "stuck"];
  const severity = { stuck: 3, attention: 2, running: 1, seen: 0, done: 0 };
  const pinKey = "tp-web-pinned";
  const host = document.createElement("div");
  host.id = hostId;
  host.dataset.surface = native ? "native" : side ? "side" : frameMode;
  host.style.setProperty("--pill-long", ui.pill.long + "px");
  host.style.setProperty("--pill-short", ui.pill.short + "px");
  const root = host.attachShadow({ mode: "open" });

  function counter(layout) {
    return `<div class="capsule ${layout}" role="group" aria-label="任务状态">${kinds.map(kind =>
      `<button class="number" type="button" data-filter="${kind}" aria-controls="tp-conversations"><span>–</span></button>`
    ).join("")}</div>`;
  }

  root.innerHTML = `
    <aside class="window" hidden aria-label="TaskPulse">
      ${counter("compact")}
      <section class="panel" id="tp-conversations" aria-label="会话列表" hidden>
        <header class="header">
          ${counter("horizontal")}
          <button type="button" class="header-blank" aria-label="拖动面板或双击切换全部分组" title="拖动 · 双击切换分组"></button>
          <div class="source group-mode" role="group" aria-label="分组方式">
            <button type="button" data-mode="dataagent" aria-label="DataAgent 分组" title="DataAgent 内部分组">DA</button>
            <button type="button" data-mode="tab" aria-label="浏览器标签组" title="Chrome / Edge 原生标签组">TAB</button>
          </div>
          <button type="button" class="pin" aria-label="固定展开" aria-pressed="false"></button>
          <button type="button" class="close" aria-label="收起 TaskPulse" title="收起 TaskPulse"></button>
        </header>
        <p class="note" role="status" hidden></p>
        <div class="groups"></div>
        <footer class="footer"><span>WEB</span><button type="button" class="settings" aria-label="显示设置">显示设置</button></footer>
      </section>
    </aside>
    <div class="toast-stack" aria-live="polite" hidden></div>`;

  const box = root.querySelector(".window");
  const compact = root.querySelector(".compact");
  const panel = root.querySelector(".panel");
  const header = root.querySelector(".header"), footer = root.querySelector(".footer");
  const pin = root.querySelector(".pin");
  const note = root.querySelector(".note");
  const list = root.querySelector(".groups");
  const stack = root.querySelector(".toast-stack");
  const buttons = [...root.querySelectorAll("[data-filter]")];
  const choices = new Map();
  const toasts = [];
  const textMeasure = document.createElement("canvas").getContext("2d");
  let state = rules.blank();
  let groups = [];
  let rowViews = [];
  let groupViews = [];
  let filter = "";
  let lastRows = "";
  let actionError = "";
  let expanded = side;
  let pinned = false;
  let hovered = false;
  let hoverTimer = null;
  let panelClock = null;
  let position, groupMode = "dataagent", tabGroups = {};
  let viewport = { width: innerWidth, height: innerHeight }, frameGeometryReady = !frame;
  let lastSize = "", drag = null, dragFrame = 0, suppressClickUntil = 0, gestureSerial = 0;
  let styled = false, prefsChanged = new Set(), toastLoaded = !toastOnly;
  const groupButtons = [...root.querySelectorAll("[data-mode]")];

  document.documentElement.append(host);
  fetch(chrome.runtime.getURL("capsule.css")).then(response => {
    if (!response.ok) throw new Error("无法读取胶囊样式");
    return response.text();
  }).then(css => {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    root.adoptedStyleSheets = [style];
    styled = true;
    box.hidden = toastOnly;
    stack.hidden = frame && !toastOnly || side;
    render();
    if (frame) {
      post({ type: "tp-frame-ready" });
      layoutSurface();
      if (toastOnly) void refreshToasts();
    }
  }).catch(error => console.warn("TaskPulse:", error.message));

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  const oneLine = name => String(name ?? "").replace(/\s+/gu, " ").trim();

  function fitText(node, title) {
    const width = node.clientWidth;
    if (!width || !textMeasure || node.dataset.width === String(width)) return;
    node.dataset.width = String(width);
    const css = getComputedStyle(node);
    textMeasure.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    if (textMeasure.measureText(title).width <= width) {
      node.textContent = title;
      return;
    }
    const chars = Array.from(title);
    let low = 1;
    let high = chars.length - 1;
    let best = "…";
    while (low <= high) {
      const keep = Math.floor((low + high) / 2);
      const end = Math.floor(keep * .30);
      const candidate = chars.slice(0, keep - end).join("") + "…" + (end ? chars.slice(-end).join("") : "");
      if (textMeasure.measureText(candidate).width <= width) {
        best = candidate;
        low = keep + 1;
      } else {
        high = keep - 1;
      }
    }
    node.textContent = best;
  }

  function explain(view) {
    if (actionError) return actionError;
    if (!state.at) return "等待首次采样…";
    if (state.authBlocked || rules.authError(view.error)) return "请登录 DataAgent 后继续";
    if (view.error) return "取数暂时失败，显示上次快照";
    if (view.stale) return "取数暂未更新，显示上次快照";
    const uncertain = view.tasks.filter(task => task.uncertain).length;
    return uncertain ? uncertain + " 个会话状态待确认" : "";
  }

  const checkedTask = task => !!task.checkedRevision && rules.canAcknowledge(task) && task.checkedRevision === rules.revision(task);
  const isLive = (task, kind) => !checkedTask(task) && task.status === kind && !task.uncertain;

  function taskStatus(task) {
    return checkedTask(task) ? "done" : task.status;
  }
  function progress(task, now) {
    if (checkedTask(task)) return 1;
    const phase = task.runAt || task.phaseAt;
    const until = task.uncertain ? task.observedAt : now;
    return phase ? Math.max(0, Math.min(1, (until - phase) / rules.stuckMs)) : 0;
  }
  function timeLabel(task, now) {
    if (checkedTask(task)) return "已读";
    if (task.uncertain) return "待确认";
    if (task.status === "stuck" && task.failed) return "限流";
    if (task.status === "running" || task.status === "stuck") {
      const since = task.runAt || task.phaseAt;
      const seconds = since ? Math.max(0, Math.floor((now - since) / 1_000)) : 0;
      return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    }
    return Math.max(0, Math.floor((now - (task.update || now)) / 60_000)) + "m";
  }

  function setExpanded(value) {
    if (toastOnly) return;
    expanded = side || value;
    if (!value) actionError = "";
    clearTimeout(hoverTimer);
    render();
  }

  function closePanel(focus = false) {
    if (pinned) savePin(false);
    setExpanded(false);
    if (focus) compact.querySelector("button").focus({ preventScroll: true });
  }

  function savePin(value) {
    pinned = value;
    void chrome.storage.local.set({ [pinKey]: value }).catch(() => {});
  }

  async function command(kind, task, fields = {}) {
    const { id } = task;
    const revision = task.revision || rules.revision(task);
    try {
      const result = await request(kind, { id, revision, ...fields });
      if (result?.ok) return result;
    } catch { /* A worker restart or tab navigation can invalidate a pending action. */ }
    actionError = kind === "tp.open" ? "暂时无法打开此会话，请重试" : "任务状态已变化，请重试";
    if (kind === "tp.open" && !expanded) setExpanded(true);
    else render();
    return false;
  }

  function taskRow(task) {
    const done = checkedTask(task);
    const tint = done ? "done" : task.uncertain || (filter && !isLive(task, filter)) ? "seen" : task.status;
    const row = element("div", "row " + tint);
    const plate = element("i", "row-plate");
    const link = element("button", "task-open");
    link.type = "button";
    link.dataset.cid = task.id;
    const title = oneLine(task.name);
    link.title = title;
    link.setAttribute("aria-label", title + "，" + (task.uncertain && !done ? "状态待确认" : names[taskStatus(task)]));
    const name = element("span", "task-name", title);
    const time = element("span", "task-time");
    time.setAttribute("aria-hidden", "true");
    link.append(element("i", "task-dot"), name, time);
    link.addEventListener("click", async () => {
      if (await command("tp.open", task, { intent: "row" }) && !pinned) setExpanded(false);
    });

    const check = element("button", "task-check");
    check.type = "button";
    check.dataset.check = task.id;
    check.setAttribute("aria-pressed", String(done));
    const checkLabel = done ? "取消本轮处理标记" : "标记本轮已处理";
    check.setAttribute("aria-label", checkLabel + " · " + title);
    check.title = checkLabel;
    check.disabled = !done && (task.uncertain || !rules.canAcknowledge(task));
    check.addEventListener("click", async () => {
      await command("tp.check", task, { checked: !done });
    });
    row.append(plate, link, check);
    rowViews.push({ task, plate, name, time, title });
    return row;
  }

  function makeGroups(tasks) {
    const buckets = new Map();
    for (const task of [...tasks].sort((a, b) =>
      severity[taskStatus(b)] - severity[taskStatus(a)] || b.update - a.update)) {
      const identity = ui.groupFor(task, groupMode, tabGroups);
      if (!buckets.has(identity.key)) buckets.set(identity.key, { ...identity, tasks: [], active: 0, worst: "seen", matched: [] });
      const group = buckets.get(identity.key);
      group.tasks.push(task);
      if (task.uncertain || !severity[taskStatus(task)]) continue;
      group.active++;
      if (severity[task.status] > severity[group.worst]) group.worst = task.status;
      if (filter && isLive(task, filter)) group.matched.push(task);
    }
    return [...buckets.values()].sort((a, b) => severity[b.worst] - severity[a.worst] || a.name.localeCompare(b.name));
  }

  const isOpen = group => choices.get(group.key) ??
    (filter ? group.matched.length > 0 : severity[group.worst] > 1);

  function groupRow(group) {
    const open = isOpen(group);
    const badge = filter ? group.matched.length : group.active;
    const box = element("section", "group " + (filter || group.worst) + (badge ? "" : " quiet"));
    const button = element("button", "group-head");
    button.type = "button";
    button.dataset.group = group.key;
    if (group.color) {
      button.classList.add("tab-group");
      button.style.setProperty("--group-color", group.color);
    }
    button.title = group.name;
    button.setAttribute("aria-expanded", String(open));
    const chars = Array.from(group.name);
    const title = chars.length > 10 ? chars.slice(0, 10).join("") + "…" : group.name;
    const meta = (filter ? group.matched.length + "/" : "") + group.tasks.length + " 个会话";
    const line = element("i", "group-line");
    button.append(element("i", "chevron"), element("span", "group-name", title),
      element("span", "group-count", meta), element("span", "group-open", String(badge)), line);
    button.addEventListener("click", () => { choices.set(group.key, !open); render(); });
    box.append(button);
    groupViews.push({ group, line });
    if (open) {
      const tasks = filter && group.matched.length ? group.matched : group.tasks;
      for (const task of tasks) box.append(taskRow(task));
    }
    return box;
  }

  function drawRows(tasks, unavailable) {
    const key = JSON.stringify([filter, groupMode, [...choices], unavailable, tasks.map(task => [
      rules.revision(task), ui.groupFor(task, groupMode, tabGroups), task.name, task.status, task.uncertain,
      task.checkedRevision, task.uncertain ? task.observedAt : 0, task.runAt, task.phaseAt, task.failed, task.messageUncertain
    ])]);
    if (key === lastRows) return;
    lastRows = key;
    const focused = root.activeElement?.dataset;
    const priorScroll = list.scrollTop;
    rowViews = [];
    groupViews = [];
    groups = makeGroups(tasks);
    const content = document.createDocumentFragment();
    if (groupMode === "dataagent" && groups.length === 1 && groups[0].name === "未分组") {
      for (const task of groups[0].tasks) content.append(taskRow(task));
    } else {
      for (const group of groups) content.append(groupRow(group));
    }
    if (!groups.length && !unavailable) {
      content.append(element("p", "empty", filter ? "没有" + names[filter] + "的任务" : "没有正在跑的任务"));
    }
    list.replaceChildren(content);
    list.scrollTop = priorScroll;
    if (focused) {
      const target = [...list.querySelectorAll("button")].find(button =>
        (focused.cid && focused.cid === button.dataset.cid) ||
        (focused.check && focused.check === button.dataset.check) ||
        (focused.group && focused.group === button.dataset.group));
      target?.focus({ preventScroll: true });
    }
  }

  function updateTimes(now, resized = false) {
    for (const { group, line } of groupViews) {
      const fraction = group.tasks.reduce((sum, task) => sum + progress(task, now), 0) / group.tasks.length;
      line.style.setProperty("--progress", (fraction * 100).toFixed(1) + "%");
    }
    for (const { task, plate, name, time, title } of rowViews) {
      const label = timeLabel(task, now);
      const widthChanged = time.textContent.length !== label.length;
      if (time.textContent !== label) time.textContent = label;
      plate.style.setProperty("--progress", ((checkedTask(task) ? 0 : progress(task, now)) * 100).toFixed(1) + "%");
      if (widthChanged || resized || !name.dataset.width) fitText(name, title);
    }
  }

  function layoutSurface() {
    if (!styled || host.hidden) return;
    if (toastOnly) {
      if (!toastLoaded) return;
      const height = toasts.length ? 64 + (toasts.length - 1) * 44 : 0;
      const key = "toast/" + height;
      if (key !== lastSize) { lastSize = key; post({ type: "tp-frame-size", height }); }
      return;
    }
    if (side || !frameGeometryReady) return;
    const w = frame ? viewport.width : innerWidth, h = frame ? viewport.height : innerHeight;
    // Measure natural row height, not the previously constrained scroll area.
    // This lets the panel shrink on filter changes and prevents resize loops.
    const naturalListHeight = 10 + [...list.children].reduce((sum, node, index) =>
      sum + node.offsetHeight + (index && node.classList.contains("group") ? 4 : 0), 0);
    const panelHeight = expanded ? header.offsetHeight + footer.offsetHeight + note.offsetHeight + naturalListHeight : 0;
    const layout = ui.glassLayout(position, w, h, expanded, panelHeight);
    compact.classList.toggle("dock-horizontal", layout.horizontal);
    const setRect = (node, r) => {
      if (r) Object.assign(node.style, { left: r.left + "px", top: r.top + "px",
        width: r.width + "px", height: r.height + "px" });
    };
    setRect(compact, layout.capsule);
    setRect(panel, layout.panel);
    Object.assign(box.style, { left: (frame ? 0 : layout.left) + "px", top: (frame ? 0 : layout.top) + "px",
      right: "auto", width: layout.width + "px", height: layout.height + "px" });
    if (frame) {
      const key = JSON.stringify([layout.width, layout.height, expanded, panelHeight]);
      if (key !== lastSize) { lastSize = key; post({ type: "tp-frame-size", expanded, panelHeight }); }
    }
  }

  function render() {
    host.hidden = native && !web.conversationPage(location.href);
    if (toastOnly) { layoutSurface(); return; }
    if (document.hidden || host.hidden) {
      if (panelClock !== null) { clearInterval(panelClock); panelClock = null; }
      return;
    }
    const now = Date.now();
    const view = rules.view(state, now);
    const warning = explain(view);
    compact.classList.toggle("alerting", Boolean(warning));
    for (const button of buttons) {
      const kind = button.dataset.filter;
      const count = view.counts[kind];
      const value = view.stale ? "–" : String(count);
      button.firstElementChild.textContent = value;
      button.setAttribute("aria-pressed", String(filter === kind));
      button.setAttribute("aria-expanded", String(expanded));
      button.classList.toggle("zero", !count || view.stale);
      button.classList.toggle("dimmed", Boolean(filter && filter !== kind));
      button.title = names[kind] + " · " + (view.stale ? "待更新" : value);
      button.setAttribute("aria-label", button.title);
    }
    compact.hidden = side || expanded;
    panel.hidden = !expanded;
    for (const button of groupButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === groupMode));
    pin.setAttribute("aria-pressed", String(pinned));
    pin.title = pinned ? "已固定展开（点击取消）" : "固定展开";
    const clockWanted = expanded && !document.hidden && !host.hidden;
    if (!clockWanted && panelClock !== null) {
      clearInterval(panelClock);
      panelClock = null;
    } else if (clockWanted && panelClock === null) {
      panelClock = setInterval(() => updateTimes(Date.now()), 1_000);
    }
    if (!expanded) { layoutSurface(); return; }
    const age = state.at ? now - state.at : 0;
    const panelNote = warning || (age > 12_000 ? "数据 " + Math.round(age / 1000) + " 秒前" : "");
    note.textContent = panelNote;
    note.hidden = !panelNote;
    drawRows(view.tasks, view.stale);
    updateTimes(now);
    layoutSurface();
  }

  for (const button of buttons) {
    button.addEventListener("click", event => {
      const kind = button.dataset.filter;
      filter = filter === kind ? "" : kind;
      choices.clear();
      actionError = "";
      setExpanded(true);
      if (event.detail === 0) root.querySelector(`.horizontal [data-filter="${kind}"]`).focus({ preventScroll: true });
    });
  }
  const blank = root.querySelector(".header-blank");
  function toggleGroups() {
    const allClosed = groups.some(isOpen);
    for (const group of groups) choices.set(group.key, !allClosed);
    render();
  }
  blank.addEventListener("dblclick", event => { if (Date.now() >= suppressClickUntil) toggleGroups(); });
  blank.addEventListener("click", event => { if (event.detail === 0) toggleGroups(); });
  for (const button of groupButtons) button.addEventListener("click", () => {
    groupMode = button.dataset.mode === "tab" ? "tab" : "dataagent";
    choices.clear(); lastRows = "";
    void chrome.storage.local.set({ [ui.keys.grouping]: groupMode }).catch(() => {});
    render();
  });
  root.querySelector(".settings").addEventListener("click", () => { void request("tp.settings").catch(() => {}); });
  pin.addEventListener("click", () => { savePin(!pinned); render(); });
  root.querySelector(".close").addEventListener("click", event => closePanel(event.detail === 0));
  box.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch" || drag || toastOnly || side) return;
    hovered = true;
    clearTimeout(hoverTimer);
    if (!expanded && !event.buttons) hoverTimer = setTimeout(() => setExpanded(true), 120);
  });
  box.addEventListener("pointerleave", () => {
    hovered = false;
    clearTimeout(hoverTimer);
    if (!drag && !side && !pinned && expanded && !root.activeElement?.matches(":focus-visible")) {
      hoverTimer = setTimeout(() => setExpanded(false), 150);
    }
  });
  // The cross-origin iframe moves during a drag. Chromium may transfer
  // pointer events to its parent when its clipped hit region changes. Start
  // the parent gesture on pointerdown, so it can continue the same drag.
  box.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    // A new deliberate click is not the synthetic click from a prior drag.
    suppressClickUntil = 0;
    if (side || toastOnly || drag || !event.target.closest(".compact,.horizontal,.header-blank")) return;
    clearTimeout(hoverTimer);
    drag = { pointer: event.pointerId, gesture: ++gestureSerial, x: event.screenX, y: event.screenY,
      start: ui.normalized(position), dx: 0, dy: 0, moved: false, target: event.target };
    if (frame) post({ type: "tp-frame-drag-start", gesture: drag.gesture, x: drag.x, y: drag.y });
    try { event.target.setPointerCapture(event.pointerId); } catch {}
  });
  function applyDrag(done = false) {
    if (!drag) return;
    if (frame) {
      post({ type: "tp-frame-drag", gesture: drag.gesture,
        x: drag.x + drag.dx, y: drag.y + drag.dy, done });
    } else if (drag.moved) {
      position = ui.move(drag.start, drag.dx, drag.dy, innerWidth, innerHeight);
      layoutSurface();
      if (done) void chrome.storage.local.set({ [ui.keys.position]: position }).catch(() => {});
    }
  }
  function measureDrag(event) {
    drag.dx = event.screenX - drag.x; drag.dy = event.screenY - drag.y;
    drag.moved ||= Math.hypot(drag.dx, drag.dy) >= 5;
  }
  function clearDrag(moved = false) {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (moved || drag?.moved) suppressClickUntil = Date.now() + 350;
    const previous = drag;
    drag = null;
    try {
      if (previous?.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
    } catch {}
  }
  box.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    measureDrag(event);
    if (!drag.moved) return;
    event.preventDefault();
    if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; applyDrag(); });
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (event.type === "pointerup") measureDrag(event);
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    applyDrag(true);
    clearDrag();
  }
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);
  root.addEventListener("click", event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && expanded) {
      event.stopPropagation();
      closePanel(true);
    }
  });

  function layoutToasts() {
    toasts.forEach(({ button }, index) => {
      button.style.setProperty("--index", index);
      button.style.zIndex = toasts.length - index;
    });
    layoutSurface();
  }

  function removeToast(revision) {
    const index = toasts.findIndex(item => item.revision === revision);
    if (index < 0) return;
    const [item] = toasts.splice(index, 1);
    clearTimeout(item.timer);
    item.button.remove();
    layoutToasts();
  }

  function showToast(task, duration = 15_000) {
    if (!web.id(task?.id) || !task.revision || toasts.some(item => item.revision === task.revision)) return;
    const title = oneLine(task.name);
    const button = element("button", "toast" + (task.failed ? " stuck" : ""));
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", "Agent 回话了 · " + title);
    const body = element("span", "toast-body", title);
    button.append(element("span", "toast-title", "Agent 回话了"), body);
    button.addEventListener("click", async () => {
      const result = await command("tp.open", task, { intent: "notice" });
      if (rules.mayDismissNotice(result)) {
        button.setAttribute("data-dismissing", "");
        setTimeout(() => removeToast(task.revision), 110);
      }
    });
    toasts.unshift({ id: task.id, revision: task.revision, button, timer: setTimeout(() => removeToast(task.revision), Math.max(100, duration)) });
    if (toasts.length > 3) removeToast(toasts.at(-1).revision);
    stack.prepend(button);
    layoutToasts();
    fitText(body, title);
  }

  const toastSeen = new Set();
  let toastRequest = 0;
  async function refreshToasts() {
    if (!toastOnly) return;
    const generation = ++toastRequest;
    const result = await request("tp.surface.toasts").catch(() => null);
    if (generation !== toastRequest) return;
    toastLoaded = true;
    for (const task of [...(result?.tasks || [])].reverse()) {
      if (toastSeen.has(task.revision)) continue;
      toastSeen.add(task.revision);
      showToast(task, result.remaining);
    }
    layoutSurface();
  }

  let stateChanged = false;
  let pinChanged = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[web.keys.state]) {
      stateChanged = true;
      state = changes[web.keys.state].newValue ?? rules.blank();
      for (const toast of [...toasts]) {
        const task = state.tasks[toast.id];
        if (!task?.pending || !rules.taskAccessible(state, task) || rules.revision(task) !== toast.revision) removeToast(toast.revision);
      }
    }
    if (changes[pinKey]) {
      pinChanged = true;
      pinned = changes[pinKey].newValue === true;
      if (pinned || !hovered) expanded = side || pinned;
    }
    if (changes[ui.keys.position] || changes[ui.keys.grouping] || changes[ui.keys.tabGroups]) {
      for (const key of [ui.keys.position, ui.keys.grouping, ui.keys.tabGroups]) if (changes[key]) prefsChanged.add(key);
      if (changes[ui.keys.position] && !drag && !frame) position = changes[ui.keys.position].newValue;
      if (changes[ui.keys.grouping]) {
        groupMode = changes[ui.keys.grouping].newValue === "tab" ? "tab" : "dataagent";
        choices.clear(); lastRows = "";
      }
      if (changes[ui.keys.tabGroups]) tabGroups = changes[ui.keys.tabGroups].newValue || {};
    }
    if (changes[web.keys.state] || changes[pinKey] || changes[ui.keys.position] ||
        changes[ui.keys.grouping] || changes[ui.keys.tabGroups]) render();
  });
  chrome.storage.local.get([web.keys.state, pinKey, ui.keys.position, ui.keys.grouping, ui.keys.tabGroups]).then(items => {
    if (!stateChanged) state = items[web.keys.state] ?? rules.blank();
    if (!pinChanged) {
      pinned = items[pinKey] === true;
      if (pinned) expanded = true;
    }
    if (!frame && !prefsChanged.has(ui.keys.position)) position = items[ui.keys.position];
    if (!prefsChanged.has(ui.keys.grouping)) groupMode = items[ui.keys.grouping] === "tab" ? "tab" : "dataagent";
    if (!prefsChanged.has(ui.keys.tabGroups)) tabGroups = items[ui.keys.tabGroups] || {};
    render();
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (native && msg?.kind === "tp.route") {
      render();
      reply({ ok: true });
      return false;
    }
    if (native && msg?.kind === "tp.show") {
      if (expanded) closePanel();
      else setExpanded(true);
      reply({ ok: true });
    }
    if (native && msg?.kind === "tp.replies" && !document.hidden && web.conversationPage(location.href)) {
      // Storage changes and worker messages can be delivered in either order.
      // Revalidate the exact reply before displaying a delayed toast.
      void chrome.storage.local.get(web.keys.state).then(items => {
        if (document.hidden || !web.conversationPage(location.href)) return reply({ ok: false });
        const saved = items[web.keys.state] ?? rules.blank();
        for (const task of msg.tasks ?? []) {
          const current = saved.tasks[task.id];
          if (current?.pending && rules.taskFresh(saved, current, Date.now()) && rules.canAcknowledge(current) &&
              rules.revision(current) === task.revision) showToast(task);
        }
        reply({ ok: true });
      }).catch(() => reply({ ok: false }));
      return true;
    }
  });
  // A real interaction with the DataAgent page (not the capsule) is an
  // independent visit after an old notification landed on this conversation.
  let lastVisitAt = 0;
  function userVisit(event) {
    if (!event.isTrusted || document.hidden || !document.hasFocus() ||
        event.composedPath().includes(host) || Date.now() - lastVisitAt < 2_000) return;
    const id = web.conversationId(location.href);
    if (!id) return;
    lastVisitAt = Date.now();
    void chrome.runtime.sendMessage({ kind: "tp.visit", id, at: Date.now() }).catch(() => {});
  }
  if (native) {
    document.addEventListener("pointerdown", userVisit, true);
    document.addEventListener("keydown", userVisit, true);
  }
  if (frame) window.addEventListener("message", event => {
    if (event.source !== parent || event.origin !== attached.origin) return;
    if (event.data?.type === "tp-host-drag-ended" && drag?.gesture === event.data.gesture)
      clearDrag(event.data.moved === true);
    if (event.data?.type === "tp-host-open" && !toastOnly) setExpanded(!expanded);
    if (event.data?.type === "tp-host-refresh" && toastOnly) void refreshToasts();
    if (event.data?.type === "tp-host-viewport" && !toastOnly) {
      viewport = { width: Math.max(44, Math.min(10000, Number(event.data.width) || 240)),
        height: Math.max(84, Math.min(10000, Number(event.data.height) || 600)) };
      position = ui.normalized(event.data.position);
      frameGeometryReady = true;
      layoutSurface();
    }
  });
  document.addEventListener("visibilitychange", () => { if (alive()) render(); });
  window.addEventListener("resize", () => { if (expanded) updateTimes(Date.now(), true); layoutSurface(); });
  if (!toastOnly && !side) {
    const observer = new ResizeObserver(layoutSurface);
    observer.observe(list);
    observer.observe(note);
  }
  const clock = toastOnly ? null : setInterval(() => {
    if (!alive()) {
      clearInterval(clock);
      clearInterval(panelClock);
      host.remove();
    } else if (!document.hidden) render();
  }, 15_000);
})().catch(error => console.warn("TaskPulse:", error?.message || error));
