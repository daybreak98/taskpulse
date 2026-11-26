// Lightweight top-frame host. Never reads TaskPulse task names or state.
(() => {
  const ui = globalThis.TaskPulseUI;
  if (!ui || globalThis.taskPulseSurfaceHost?.alive()) return;
  function alive() { try { return Boolean(chrome.runtime?.id); } catch { return false; } }
  globalThis.taskPulseSurfaceHost = { alive };
  const extOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
  let enabled = false, position, mountGeneration = 0, registration = null, mountPromise = null;
  let host = null, shadow = null, panel = null, toast = null;
  let panelSize = { width: 44, height: 84 }, pendingOpen = false, pendingToast = false;
  let dragStart = null, moveFrame = 0;
  let prefGeneration = 0, prefVersion = 0, listening = false;
  const visible = () => !document.hidden && enabled && alive() &&
    !globalThis.TaskPulseWeb?.conversationPage(location.href);
  function createFrame(mode) {
    const frame = document.createElement("iframe");
    frame.title = mode === "panel" ? "TaskPulse" : "TaskPulse 提醒";
    frame.src = chrome.runtime.getURL("surface.html") + "#" + mode + "/" + registration.token;
    Object.assign(frame.style, { position: "fixed", display: "block", margin: "0", border: "0",
      background: "transparent", colorScheme: "dark", pointerEvents: "auto", overflow: "hidden" });
    frame.setAttribute("scrolling", "no");
    shadow.append(frame);
    return frame;
  }
  function reposition() {
    if (!panel) return;
    const p = ui.place(position, innerWidth, innerHeight, panelSize.width, panelSize.height);
    Object.assign(panel.style, { left: p.left + "px", top: p.top + "px",
      width: panelSize.width + "px", height: panelSize.height + "px" });
  }
  function signalFrame(frame, message) {
    frame?.contentWindow?.postMessage(message, extOrigin);
  }
  function sizePanel(width, height) {
    panelSize = { width: Math.max(44, Math.min(innerWidth, Math.ceil(Number(width) || 44), 260)),
      height: Math.max(28, Math.min(innerHeight, Math.ceil(Number(height) || 84))) };
    reposition();
  }
  function mountToast() {
    if (!panel || !registration || !visible()) return;
    pendingToast = false;
    if (!toast) {
      toast = createFrame("toast");
      Object.assign(toast.style, { top: "14px", right: "14px", width: Math.max(1, Math.min(288, innerWidth - 28)) + "px",
        height: "1px", visibility: "hidden" });
    } else signalFrame(toast, { type: "tp-host-refresh" });
  }
  function unmount() {
    mountGeneration++;
    mountPromise = null;
    host?.remove();
    host = shadow = panel = toast = registration = null;
    pendingOpen = pendingToast = false;
    dragStart = null;
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
  }
  function mount() {
    if (!visible() || panel) return Promise.resolve(Boolean(panel));
    if (mountPromise) return mountPromise;
    const generation = ++mountGeneration;
    mountPromise = (async () => {
      const result = await chrome.runtime.sendMessage({ kind: "tp.surface.register" }).catch(() => null);
      if (generation !== mountGeneration || !visible() || !result?.ok) return false;
      registration = result;
      host = document.createElement("div");
      host.id = "taskpulse-global-host";
      Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", pointerEvents: "none",
        zIndex: "2147483000" });
      shadow = host.attachShadow({ mode: "closed" });
      document.documentElement.append(host);
      panelSize = { width: 44, height: 84 };
      panel = createFrame("panel");
      panel.style.visibility = "hidden";
      reposition();
      if (pendingToast) mountToast();
      return true;
    })().finally(() => { if (generation === mountGeneration) mountPromise = null; });
    return mountPromise;
  }
  function show() { if (visible()) void mount(); else unmount(); }
  window.addEventListener("message", event => {
    if (event.origin !== extOrigin || !registration || !event.data || typeof event.data !== "object") return;
    const msg = event.data;
    if (panel && event.source === panel.contentWindow) {
      if (msg.type === "tp-frame-ready") {
        panel.style.visibility = "visible";
        if (pendingOpen) { pendingOpen = false; signalFrame(panel, { type: "tp-host-open" }); }
        signalFrame(panel, { type: "tp-host-viewport", height: innerHeight, width: innerWidth });
      } else if (msg.type === "tp-frame-size") sizePanel(msg.width, msg.height);
      else if (msg.type === "tp-frame-drag" && Number.isFinite(msg.dx) && Number.isFinite(msg.dy)) {
        if (msg.start || !dragStart) dragStart = ui.normalized(position);
        position = ui.move(dragStart, msg.dx, msg.dy, innerWidth, innerHeight);
        if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; reposition(); });
        if (msg.done) {
          dragStart = null;
          reposition();
          void chrome.storage.local.set({ [ui.keys.position]: position }).catch(() => {});
        }
      }
    } else if (toast && event.source === toast.contentWindow && msg.type === "tp-frame-size") {
      const height = Math.max(0, Math.min(160, Number(msg.height) || 0));
      if (!height) { toast.remove(); toast = null; }
      else Object.assign(toast.style, { height: height + "px", visibility: "visible" });
    }
  });
  window.addEventListener("resize", () => {
    reposition();
    signalFrame(panel, { type: "tp-host-viewport", width: innerWidth, height: innerHeight });
    if (toast) toast.style.width = Math.max(1, Math.min(288, innerWidth - 28)) + "px";
  }, { passive: true });
  function onPrefs(changes, area) {
    if (area !== "local" || !changes[ui.keys.enabled] && !changes[ui.keys.position]) return;
    prefVersion++;
    if (changes[ui.keys.enabled]) { enabled = changes[ui.keys.enabled].newValue === true; show(); }
    if (changes[ui.keys.position] && !dragStart) { position = changes[ui.keys.position].newValue; reposition(); }
  }
  function followVisibility() {
    const generation = ++prefGeneration;
    // Hidden ordinary tabs have neither an extension iframe nor a storage
    // change subscription, avoiding cloning the full state into every tab.
    if (document.hidden || !alive()) {
      if (listening) chrome.storage.onChanged.removeListener(onPrefs);
      listening = false;
      unmount();
      return;
    }
    if (!listening) { chrome.storage.onChanged.addListener(onPrefs); listening = true; }
    const version = prefVersion;
    void chrome.storage.local.get([ui.keys.enabled, ui.keys.position]).then(saved => {
      if (generation !== prefGeneration || document.hidden) return;
      if (version !== prefVersion) { followVisibility(); return; }
      enabled = saved[ui.keys.enabled] === true;
      if (!dragStart) position = saved[ui.keys.position];
      show();
      reposition();
    }).catch(() => {});
  }
  document.addEventListener("visibilitychange", followVisibility);
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.kind === "tp.route") { followVisibility(); reply({ ok: true }); return false; }
    if (!visible()) return false;
    if (msg?.kind === "tp.surface-probe") { reply({ ok: true }); return false; }
    if (msg?.kind === "tp.surface-open" || msg?.kind === "tp.surface-notice") {
      if (msg.kind === "tp.surface-open") pendingOpen = true;
      else pendingToast = true;
      void mount().then(ok => {
        if (ok && msg.kind === "tp.surface-notice" && pendingToast) mountToast();
        if (ok && msg.kind === "tp.surface-open" && panel?.style.visibility === "visible") {
          pendingOpen = false; signalFrame(panel, { type: "tp-host-open" });
        }
        reply({ ok });
      }).catch(() => reply({ ok: false }));
      return true;
    }
    return false;
  });
  followVisibility();
})();
