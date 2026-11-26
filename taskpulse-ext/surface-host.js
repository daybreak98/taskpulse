// Lightweight top-frame host. Never reads TaskPulse task names or state.
(() => {
  const ui = globalThis.TaskPulseUI;
  if (!ui || globalThis.taskPulseSurfaceHost?.alive()) return;
  function alive() { try { return Boolean(chrome.runtime?.id); } catch { return false; } }
  globalThis.taskPulseSurfaceHost = { alive };
  const extOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
  let enabled = false, position, mountGeneration = 0, registration = null, mountPromise = null;
  let host = null, shadow = null, panel = null, toast = null;
  let panelSize = { expanded: false, panelHeight: 0 }, pendingOpen = false, pendingToast = false;
  let dragStart = null, moveFrame = 0, dragShield = null;
  let prefGeneration = 0, prefVersion = 0, listening = false;
  const visible = () => !document.hidden && enabled && alive() &&
    !globalThis.TaskPulseWeb?.conversationPage(location.href);
  function createFrame(mode) {
    const frame = document.createElement("iframe");
    frame.title = mode === "panel" ? "TaskPulse" : "TaskPulse 提醒";
    frame.src = chrome.runtime.getURL("surface.html") + "#" + mode + "/" + registration.token;
    Object.assign(frame.style, { position: "fixed", display: "block", margin: "0", border: "0",
      background: "transparent", colorScheme: "light", pointerEvents: "auto", overflow: "hidden" });
    frame.setAttribute("scrolling", "no");
    shadow.append(frame);
    return frame;
  }
  function reposition() {
    if (!panel) return;
    const p = ui.glassLayout(position, innerWidth, innerHeight, panelSize.expanded, panelSize.panelHeight);
    Object.assign(panel.style, { left: p.left + "px", top: p.top + "px",
      width: p.width + "px", height: p.height + "px", clipPath: ui.glassClip(p) });
  }
  function signalFrame(frame, message) {
    frame?.contentWindow?.postMessage(message, extOrigin);
  }
  function sendGeometry() {
    signalFrame(panel, { type: "tp-host-viewport", height: innerHeight, width: innerWidth, position: ui.normalized(position) });
  }
  function sizePanel(expanded, panelHeight) {
    panelSize = { expanded: expanded === true, panelHeight: Math.max(0, Math.min(innerHeight, Math.ceil(Number(panelHeight) || 0))) };
    reposition();
    if (panel) panel.style.visibility = "visible";
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
  function finishDrag(notify = true) {
    if (!dragStart) return;
    const drag = dragStart;
    dragStart = null;
    dragShield?.remove();
    dragShield = null;
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    if (drag.moved) {
      reposition(); sendGeometry();
      void chrome.storage.local.set({ [ui.keys.position]: position }).catch(() => {});
    }
    if (notify) signalFrame(panel, { type: "tp-host-drag-ended", gesture: drag.gesture, moved: drag.moved });
  }
  function startDrag(msg) {
    if (!Number.isInteger(msg.gesture) || !Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !shadow) return;
    finishDrag(false);
    dragStart = { gesture: msg.gesture, x: msg.x, y: msg.y, position: ui.normalized(position), moved: false };
    // Transparent drag-only hit shield behind the iframe. It prevents
    // dropped capture from turning into clicks on the underlying site.
    dragShield = document.createElement("div");
    Object.assign(dragShield.style, { position: "fixed", inset: "0", background: "transparent",
      pointerEvents: "auto", touchAction: "none", cursor: "grabbing" });
    shadow.prepend(dragShield);
  }
  function moveDrag(x, y) {
    if (!dragStart || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const dx = x - dragStart.x, dy = y - dragStart.y;
    dragStart.moved ||= Math.hypot(dx, dy) >= 5;
    if (!dragStart.moved) return;
    position = ui.move(dragStart.position, dx, dy, innerWidth, innerHeight);
    if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; reposition(); sendGeometry(); });
  }
  // Parent-side fallback only while an authenticated frame gesture exists.
  window.addEventListener("pointermove", event => {
    if (!dragStart || !event.isTrusted || !event.composedPath().includes(host)) return;
    if (!(event.buttons & 1)) { finishDrag(); return; }
    event.preventDefault(); event.stopPropagation();
    moveDrag(event.screenX, event.screenY);
  }, true);
  window.addEventListener("pointerup", event => {
    if (!dragStart || !event.isTrusted || !event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopPropagation();
    moveDrag(event.screenX, event.screenY); finishDrag();
  }, true);
  window.addEventListener("pointercancel", event => {
    if (dragStart && event.isTrusted && event.composedPath().includes(host)) finishDrag();
  }, true);

  function unmount() {
    mountGeneration++;
    mountPromise = null;
    finishDrag(false);
    host?.remove();
    host = shadow = panel = toast = registration = null;
    pendingOpen = pendingToast = false;
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
      panelSize = { expanded: false, panelHeight: 0 };
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
        sendGeometry();
        if (pendingOpen) { pendingOpen = false; signalFrame(panel, { type: "tp-host-open" }); }
      } else if (msg.type === "tp-frame-size") sizePanel(msg.expanded, msg.panelHeight);
      else if (msg.type === "tp-frame-drag-start") startDrag(msg);
      else if (msg.type === "tp-frame-drag" && dragStart?.gesture === msg.gesture) {
        moveDrag(msg.x, msg.y);
        if (msg.done) finishDrag();
      }
    } else if (toast && event.source === toast.contentWindow && msg.type === "tp-frame-size") {
      const height = Math.max(0, Math.min(160, Number(msg.height) || 0));
      if (!height) { toast.remove(); toast = null; }
      else Object.assign(toast.style, { height: height + "px", visibility: "visible" });
    }
  });
  window.addEventListener("resize", () => {
    reposition();
    sendGeometry();
    if (toast) toast.style.width = Math.max(1, Math.min(288, innerWidth - 28)) + "px";
  }, { passive: true });
  function onPrefs(changes, area) {
    if (area !== "local" || !changes[ui.keys.enabled] && !changes[ui.keys.position]) return;
    prefVersion++;
    if (changes[ui.keys.enabled]) { enabled = changes[ui.keys.enabled].newValue === true; show(); }
    if (changes[ui.keys.position] && !dragStart) { position = changes[ui.keys.position].newValue; reposition(); sendGeometry(); }
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
      reposition(); sendGeometry();
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
