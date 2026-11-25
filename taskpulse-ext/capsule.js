(() => {
  const web = globalThis.TaskPulseWeb;
  const rules = globalThis.TaskPulseState;
  const hostId = "taskpulse-web-capsule";
  if (!web.conversationPage(location.href) || globalThis.taskPulseCapsule?.alive()) return;

  document.getElementById(hostId)?.remove();
  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }
  globalThis.taskPulseCapsule = { alive };

  const names = { running: "运行中", attention: "待处理", stuck: "疑似卡住", seen: "已查看", done: "已处理" };
  const kinds = ["running", "attention", "stuck"];
  const severity = { stuck: 3, attention: 2, running: 1, seen: 0, done: 0 };
  const pinKey = "tp-web-pinned";
  const host = document.createElement("div");
  host.id = hostId;
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
          <button type="button" class="header-blank" aria-label="切换全部分组"></button>
          <span class="source" title="取数来源：浏览器 WEB">WEB</span>
          <button type="button" class="pin" aria-label="固定展开" aria-pressed="false"></button>
          <button type="button" class="close" aria-label="收起 TaskPulse" title="收起 TaskPulse"></button>
        </header>
        <p class="note" role="status" hidden></p>
        <div class="groups"></div>
      </section>
    </aside>
    <div class="toast-stack" aria-live="polite" hidden></div>`;

  const box = root.querySelector(".window");
  const compact = root.querySelector(".compact");
  const panel = root.querySelector(".panel");
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
  let expanded = false;
  let pinned = false;
  let hovered = false;
  let hoverTimer = null;
  let panelClock = null;

  document.documentElement.append(host);
  fetch(chrome.runtime.getURL("capsule.css")).then(response => {
    if (!response.ok) throw new Error("无法读取胶囊样式");
    return response.text();
  }).then(css => {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    root.adoptedStyleSheets = [style];
    box.hidden = false;
    stack.hidden = false;
    render();
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
    if (/HTTP (401|403)/.test(view.error)) return "请登录 DataAgent 后继续";
    if (view.error) return "取数暂时失败，显示上次快照";
    if (view.stale) return "取数暂未更新，显示上次快照";
    const uncertain = view.tasks.filter(task => task.uncertain).length;
    return uncertain ? uncertain + " 个会话状态待确认" : "";
  }

  const checkedTask = task => !!task.checkedRevision && !task.runAt && task.checkedRevision === rules.revision(task);
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
    expanded = value;
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
      const result = await chrome.runtime.sendMessage({ kind, id, revision, ...fields });
      if (result?.ok) return true;
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
      if (await command("tp.open", task) && !pinned) setExpanded(false);
    });

    const check = element("button", "task-check");
    check.type = "button";
    check.dataset.check = task.id;
    check.setAttribute("aria-pressed", String(done));
    const checkLabel = done ? "取消本轮处理标记" : "标记本轮已处理";
    check.setAttribute("aria-label", checkLabel + " · " + title);
    check.title = checkLabel;
    check.disabled = !done && Boolean(task.runAt || task.status === "running");
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
      const name = oneLine(task.group) || "未分组";
      if (!buckets.has(name)) buckets.set(name, { name, tasks: [], active: 0, worst: "seen", matched: [] });
      const group = buckets.get(name);
      group.tasks.push(task);
      if (task.uncertain || !severity[taskStatus(task)]) continue;
      group.active++;
      if (severity[task.status] > severity[group.worst]) group.worst = task.status;
      if (filter && isLive(task, filter)) group.matched.push(task);
    }
    return [...buckets.values()].sort((a, b) => severity[b.worst] - severity[a.worst] || a.name.localeCompare(b.name));
  }

  const isOpen = group => choices.get(group.name) ??
    (filter ? group.matched.length > 0 : severity[group.worst] > 1);

  function groupRow(group) {
    const open = isOpen(group);
    const badge = filter ? group.matched.length : group.active;
    const box = element("section", "group " + (filter || group.worst) + (badge ? "" : " quiet"));
    const button = element("button", "group-head");
    button.type = "button";
    button.dataset.group = group.name;
    button.title = group.name;
    button.setAttribute("aria-expanded", String(open));
    const chars = Array.from(group.name);
    const title = chars.length > 10 ? chars.slice(0, 10).join("") + "…" : group.name;
    const meta = (filter ? group.matched.length + "/" : "") + group.tasks.length + " 个会话";
    const line = element("i", "group-line");
    button.append(element("i", "chevron"), element("span", "group-name", title),
      element("span", "group-count", meta), element("span", "group-open", String(badge)), line);
    button.addEventListener("click", () => { choices.set(group.name, !open); render(); });
    box.append(button);
    groupViews.push({ group, line });
    if (open) {
      const tasks = filter && group.matched.length ? group.matched : group.tasks;
      for (const task of tasks) box.append(taskRow(task));
    }
    return box;
  }

  function drawRows(tasks, unavailable) {
    const key = JSON.stringify([filter, [...choices], unavailable, tasks.map(task => [
      rules.revision(task), task.group, task.name, task.status, task.uncertain,
      task.checkedRevision, task.uncertain ? task.observedAt : 0, task.runAt, task.phaseAt, task.failed
    ])]);
    if (key === lastRows) return;
    lastRows = key;
    const focused = root.activeElement?.dataset;
    const priorScroll = list.scrollTop;
    rowViews = [];
    groupViews = [];
    groups = makeGroups(tasks);
    const content = document.createDocumentFragment();
    if (groups.length === 1 && groups[0].name === "未分组") {
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

  function render() {
    host.hidden = !web.conversationPage(location.href);
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
    compact.hidden = expanded;
    panel.hidden = !expanded;
    pin.setAttribute("aria-pressed", String(pinned));
    pin.title = pinned ? "已固定展开（点击取消）" : "固定展开";
    const clockWanted = expanded && !document.hidden && !host.hidden;
    if (!clockWanted && panelClock !== null) {
      clearInterval(panelClock);
      panelClock = null;
    } else if (clockWanted && panelClock === null) {
      panelClock = setInterval(() => updateTimes(Date.now()), 1_000);
    }
    if (!expanded) return;
    note.textContent = warning;
    note.hidden = !warning;
    drawRows(view.tasks, view.stale);
    updateTimes(now);
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
    for (const group of groups) choices.set(group.name, !allClosed);
    render();
  }
  blank.addEventListener("dblclick", toggleGroups);
  blank.addEventListener("click", event => { if (event.detail === 0) toggleGroups(); });
  pin.addEventListener("click", () => { savePin(!pinned); render(); });
  root.querySelector(".close").addEventListener("click", event => closePanel(event.detail === 0));
  box.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch") return;
    hovered = true;
    clearTimeout(hoverTimer);
    if (!expanded && !event.buttons) hoverTimer = setTimeout(() => setExpanded(true), 120);
  });
  box.addEventListener("pointerleave", () => {
    hovered = false;
    clearTimeout(hoverTimer);
    if (!pinned && expanded && !root.activeElement?.matches(":focus-visible")) {
      hoverTimer = setTimeout(() => setExpanded(false), 150);
    }
  });
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
  }

  function removeToast(revision) {
    const index = toasts.findIndex(item => item.revision === revision);
    if (index < 0) return;
    const [item] = toasts.splice(index, 1);
    clearTimeout(item.timer);
    item.button.remove();
    layoutToasts();
  }

  function showToast(task) {
    if (!web.id(task?.id) || !task.revision || toasts.some(item => item.revision === task.revision)) return;
    const title = oneLine(task.name);
    const button = element("button", "toast" + (task.failed ? " stuck" : ""));
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", "Agent 回话了 · " + title);
    const body = element("span", "toast-body", title);
    button.append(element("span", "toast-title", "Agent 回话了"), body);
    button.addEventListener("click", async () => {
      if (await command("tp.open", task)) {
        button.setAttribute("data-dismissing", "");
        setTimeout(() => removeToast(task.revision), 110);
      }
    });
    toasts.unshift({ id: task.id, revision: task.revision, button, timer: setTimeout(() => removeToast(task.revision), 15_000) });
    if (toasts.length > 3) removeToast(toasts.at(-1).revision);
    stack.prepend(button);
    layoutToasts();
    fitText(body, title);
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
        if (task && !task.pending) removeToast(toast.revision);
      }
    }
    if (changes[pinKey]) {
      pinChanged = true;
      pinned = changes[pinKey].newValue === true;
      if (pinned || !hovered) expanded = pinned;
    }
    if (changes[web.keys.state] || changes[pinKey]) render();
  });
  chrome.storage.local.get([web.keys.state, pinKey]).then(items => {
    if (!stateChanged) state = items[web.keys.state] ?? rules.blank();
    if (!pinChanged) {
      pinned = items[pinKey] === true;
      if (pinned) expanded = true;
    }
    render();
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind === "tp.show") {
      if (expanded) closePanel();
      else setExpanded(true);
      reply({ ok: true });
    }
    if (msg?.kind === "tp.replies" && !document.hidden && web.conversationPage(location.href)) {
      for (const task of msg.tasks ?? []) showToast(task);
      reply({ ok: true });
    }
  });
  document.addEventListener("visibilitychange", () => { if (alive()) render(); });
  window.addEventListener("resize", () => { if (expanded) updateTimes(Date.now(), true); });
  const clock = setInterval(() => {
    if (!alive()) {
      clearInterval(clock);
      clearInterval(panelClock);
      host.remove();
    } else if (!document.hidden) render();
  }, 15_000);
})();
