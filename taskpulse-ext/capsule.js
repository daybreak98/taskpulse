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
  const host = document.createElement("div");
  host.id = hostId;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <aside hidden aria-label="TaskPulse">
      <div class="capsule" role="group" aria-label="任务状态">
        <button class="all" type="button" data-filter="all" aria-label="全部会话" title="全部会话"><i></i><i></i><i></i></button>
        <button class="number running" type="button" data-filter="running"><span>–</span></button>
        <button class="number attention" type="button" data-filter="attention"><span>–</span></button>
        <button class="number stuck" type="button" data-filter="stuck"><span>–</span></button>
      </div>
      <section class="panel" id="tp-conversations" aria-label="会话列表" hidden>
        <header><strong>TaskPulse</strong><button type="button" class="close" aria-label="收起会话列表">×</button></header>
        <p class="note" role="status" hidden></p>
        <div class="groups"></div>
      </section>
    </aside>`;
  const box = root.querySelector("aside");
  document.documentElement.append(host);
  fetch(chrome.runtime.getURL("capsule.css")).then(response => {
    if (!response.ok) throw new Error("无法读取胶囊样式");
    return response.text();
  }).then(css => {
    const style = new CSSStyleSheet();
    style.replaceSync(css);
    root.adoptedStyleSheets = [style];
    box.hidden = false;
  }).catch(error => console.warn("TaskPulse:", error.message));

  const panel = root.querySelector(".panel");
  const note = root.querySelector(".note");
  const list = root.querySelector(".groups");
  const buttons = [...root.querySelectorAll("[data-filter]")];
  const names = { running: "运行中", attention: "待处理", stuck: "疑似卡住", seen: "已查看" };
  let state = rules.blank();
  let filter = "";
  let lastRows = "";
  let actionError = "";

  function setFilter(next) {
    filter = next;
    actionError = "";
    render();
  }

  function explain(view) {
    if (actionError) return actionError;
    if (!state.at) return "正在连接 DataAgent…";
    if (/HTTP (401|403)/.test(view.error)) return "请登录 DataAgent 后继续。";
    if (view.error) return "采集暂不可用，显示上次结果。";
    if (view.stale) return "状态暂未更新，显示上次结果。";
    return "";
  }

  function taskButton(task) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row " + (task.uncertain ? "uncertain" : task.status);
    row.dataset.cid = task.id;
    row.setAttribute("aria-label", task.name + "，" + (task.uncertain ? "状态待确认" : names[task.status]));
    row.title = task.name;
    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.textContent = task.name;
    const jump = document.createElement("span");
    jump.className = "jump";
    jump.setAttribute("aria-hidden", "true");
    row.append(dot, title, jump);
    row.addEventListener("click", async () => {
      try {
        if ((await chrome.runtime.sendMessage({ kind: "tp.open", id: task.id, revision: rules.revision(task) }))?.ok) {
          setFilter("");
          return;
        }
      } catch { /* The worker can restart while the tab is navigating. */ }
      actionError = "暂时无法打开此会话，请重试。";
      render();
    });
    return row;
  }

  function renderTasks(tasks) {
    const key = JSON.stringify([filter, tasks.map(task => [
      rules.revision(task), task.group, task.name, task.status, task.uncertain
    ])]);
    if (key === lastRows) return;
    lastRows = key;
    const focusedId = root.activeElement?.dataset.cid;
    const groups = new Map();
    for (const task of tasks) {
      if (!groups.has(task.group)) groups.set(task.group, []);
      groups.get(task.group).push(task);
    }

    const parts = document.createDocumentFragment();
    for (const [name, rows] of groups) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = name || "未分组";
      section.append(heading);
      for (const task of rows) section.append(taskButton(task));
      parts.append(section);
    }
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = filter === "all" ? "还没有可显示的会话" : "当前没有" + names[filter] + "的会话";
      parts.append(empty);
    }
    list.replaceChildren(parts);
    if (focusedId) list.querySelector('[data-cid="' + focusedId + '"]')?.focus({ preventScroll: true });
  }

  function render() {
    host.hidden = !web.conversationPage(location.href);
    const view = rules.view(state, Date.now());
    for (const button of buttons) {
      const kind = button.dataset.filter;
      button.setAttribute("aria-expanded", String(kind === filter));
      button.setAttribute("aria-controls", panel.id);
      if (kind === "all") continue;
      const number = view.counts[kind];
      button.firstElementChild.textContent = view.stale ? "–" : number > 99 ? "99+" : String(number);
      button.classList.toggle("zero", !number || view.stale);
      button.title = names[kind] + " · " + (view.stale ? "待更新" : number);
      button.setAttribute("aria-label", button.title);
    }
    panel.hidden = !filter;
    if (!filter) return;
    const message = explain(view);
    note.textContent = message;
    note.hidden = !message;
    renderTasks(filter === "all" ? view.tasks
      : view.tasks.filter(task => task.status === filter && !task.uncertain));
  }

  for (const button of buttons) {
    button.addEventListener("click", () => setFilter(filter === button.dataset.filter ? "" : button.dataset.filter));
  }
  root.querySelector(".close").addEventListener("click", () => {
    setFilter("");
    buttons[0].focus();
  });
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && filter) {
      event.stopPropagation();
      setFilter("");
      buttons[0].focus();
    }
  });

  let gotChange = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[web.keys.state]) return;
    gotChange = true;
    state = changes[web.keys.state].newValue ?? rules.blank();
    render();
  });
  chrome.storage.local.get(web.keys.state).then(items => {
    if (!gotChange) state = items[web.keys.state] ?? rules.blank();
    render();
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind === "tp.show") {
      setFilter(filter ? "" : "all");
      reply({ ok: true });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && alive()) render();
  });
  const clock = setInterval(() => {
    if (!alive()) {
      clearInterval(clock);
      host.remove();
    } else if (!document.hidden) render();
  }, 15_000);
})();
