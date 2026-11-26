// Browser UI orchestration; all task data stays in the extension origin.
(() => {
  function create({ web, rules, signal, getState }) {
    const ui = globalThis.TaskPulseUI;
    const registration = "taskpulse-global-surface";
    const frameUrl = chrome.runtime.getURL("surface.html");
    const sideUrl = chrome.runtime.getURL("sidepanel.html");
    let groupTimer = null, groupLane = Promise.resolve(), permissionLane = Promise.resolve();
    let surfaceEnabled = null;

    async function authorized(tab) {
      const url = ui.ordinary(tab?.url);
      if (!url || web.conversationPage(tab.url) || tab.discarded || tab.frozen ||
          !chrome.permissions?.contains) return false;
      const prefs = await chrome.storage.local.get(ui.keys.enabled);
      return prefs[ui.keys.enabled] === true &&
        await chrome.permissions.contains({ origins: [url.protocol + "//" + url.hostname + "/*"] });
    }

    async function actualTab(tabId) {
      return Number.isInteger(tabId) ? chrome.tabs.get(tabId).catch(() => null) : null;
    }
    function topSender(sender) {
      return sender?.id === chrome.runtime.id && sender.frameId === 0 &&
        Number.isInteger(sender.tab?.id) && !!ui.ordinary(sender.url);
    }
    function candidate(sender) {
      if (sender?.id !== chrome.runtime.id) return false;
      return sender.url === sideUrl || (typeof sender.url === "string" &&
        (sender.url === frameUrl || sender.url.startsWith(frameUrl + "#")));
    }
    async function register(sender) {
      if (!topSender(sender)) return { ok: false };
      const tab = await actualTab(sender.tab.id);
      if (!await authorized(tab) || ui.ordinary(sender.url)?.origin !== ui.ordinary(tab.url)?.origin) return { ok: false };
      const token = crypto.randomUUID();
      const key = ui.keys.surface(tab.id);
      const record = { token, origin: ui.ordinary(tab.url).origin };
      await chrome.storage.session.set({ [key]: record });
      return { ok: true, token, origin: record.origin };
    }
    async function validate(sender, token) {
      if (!candidate(sender)) return null;
      if (sender.url === sideUrl && (sender.frameId === 0 || sender.frameId === undefined))
        return { mode: "side" };
      if (!Number.isInteger(sender.tab?.id) || !(sender.frameId > 0) ||
          typeof token !== "string" || token.length > 100) return null;
      const tab = await actualTab(sender.tab.id);
      if (!await authorized(tab)) return null;
      const key = ui.keys.surface(tab.id);
      const record = (await chrome.storage.session.get(key))[key];
      if (!record || record.token !== token || record.origin !== ui.ordinary(tab.url)?.origin) return null;
      return { mode: "frame", tabId: tab.id, origin: record.origin };
    }
    async function attach(sender, token) {
      const session = await validate(sender, token);
      if (!session) return { ok: false };
      return { ok: true, ...session };
    }
    async function toastData(sender, token) {
      const session = await validate(sender, token);
      if (session?.mode !== "frame") return { ok: false };
      const key = ui.keys.toast(session.tabId);
      const notice = (await chrome.storage.session.get(key))[key];
      if (!notice || Date.now() - notice.at > 15_000) return { ok: true, tasks: [] };
      const state = await getState();
      const tasks = [];
      for (const revision of notice.revisions || []) {
        const task = state.tasks[revision.split("/")[0]];
        if (task?.pending && rules.taskFresh(state, task, Date.now()) &&
            rules.canAcknowledge(task) && rules.revision(task) === revision)
          tasks.push({ id: task.id, name: task.name, revision, failed: task.failed });
      }
      return { ok: true, tasks, remaining: Math.max(0, 15_000 - (Date.now() - notice.at)) };
    }
    async function ensure(tab) {
      if (!await authorized(tab) || !tab.active) return false;
      if ((await signal(tab.id, { kind: "tp.surface-probe" }))?.ok) return true;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["config.js", "ui-rules.js", "surface-host.js"] });
        return true;
      } catch { return false; }
    }
    async function notify(tab, tasks) {
      if (!tasks.length || !await authorized(tab)) return false;
      const key = ui.keys.toast(tab.id);
      await chrome.storage.session.set({ [key]: { at: Date.now(), revisions: tasks.slice(0, 3).map(t => rules.revision(t)) } });
      if (!await ensure(tab)) return false;
      return !!(await signal(tab.id, { kind: "tp.surface-notice" }))?.ok;
    }

    function reconcile() {
      if (!chrome.permissions?.contains || !chrome.scripting?.getRegisteredContentScripts) return Promise.resolve();
      const work = async () => {
        const prefs = await chrome.storage.local.get(ui.keys.enabled);
        const granted = await chrome.permissions.contains({ origins: ui.origins });
        const enabled = prefs[ui.keys.enabled] === true && granted;
        surfaceEnabled = enabled;
        const found = await chrome.scripting.getRegisteredContentScripts({ ids: [registration] });
        if (enabled && !found.length) {
          await chrome.scripting.registerContentScripts([{ id: registration, matches: ui.origins,
            excludeMatches: [web.match], js: ["config.js", "ui-rules.js", "surface-host.js"], runAt: "document_idle",
            allFrames: false, persistAcrossSessions: true }]);
        } else if (!enabled && found.length) {
          await chrome.scripting.unregisterContentScripts({ ids: [registration] });
        }
        if (!enabled && prefs[ui.keys.enabled] === true)
          await chrome.storage.local.set({ [ui.keys.enabled]: false });
        if (enabled) {
          const tabs = await chrome.tabs.query({ active: true });
          await Promise.allSettled(tabs.map(ensure));
        }
      };
      const result = permissionLane.then(work);
      permissionLane = result.catch(() => {});
      return result;
    }

    function refreshGroups() {
      if (!chrome.tabGroups?.get) return Promise.resolve();
      const work = async () => {
        const prefs = await chrome.storage.local.get([ui.keys.grouping, ui.keys.tabGroups]);
        if (prefs[ui.keys.grouping] !== "tab") return;
        const tabs = await chrome.tabs.query({ url: web.match });
        const ids = [...new Set(tabs.filter(t => web.conversationId(t.url) && t.groupId >= 0).map(t => t.groupId))];
        const groups = (await Promise.all(ids.map(id => chrome.tabGroups.get(id).catch(() => null)))).filter(Boolean);
        const next = ui.buildGroups(tabs, groups, web);
        if (JSON.stringify(next) !== JSON.stringify(prefs[ui.keys.tabGroups] || {}))
          await chrome.storage.local.set({ [ui.keys.tabGroups]: next });
      };
      const result = groupLane.then(work);
      groupLane = result.catch(() => {});
      return result;
    }
    function scheduleGroups() {
      if (!chrome.tabGroups?.get || groupTimer !== null) return;
      groupTimer = setTimeout(() => { groupTimer = null; void refreshGroups().catch(() => {}); }, 120);
    }
    function activate(tabId) {
      scheduleGroups();
      // Fast-path when global presentation is disabled, but also recover
      // the flag after a service-worker restart without injecting all tabs.
      if (!chrome.permissions?.contains || surfaceEnabled === false) return;
      void (async () => {
        if (surfaceEnabled === null) {
          const prefs = await chrome.storage.local.get(ui.keys.enabled);
          surfaceEnabled = prefs[ui.keys.enabled] === true &&
            await chrome.permissions.contains({ origins: ui.origins });
        }
        if (surfaceEnabled) await ensure(await actualTab(tabId));
      })().catch(() => {});
    }
    async function toolbar(tab) {
      if (web.conversationPage(tab?.url)) return false;
      if (await ensure(tab) && (await signal(tab.id, { kind: "tp.surface-open" }))?.ok) return true;
      return false;
    }
    function install() {
      void reconcile().catch(() => {});
      void refreshGroups().catch(() => {});
    }
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[ui.keys.enabled]) void reconcile().catch(() => {});
      if (changes[ui.keys.grouping]) scheduleGroups();
    });
    chrome.permissions?.onAdded?.addListener(() => void reconcile().catch(() => {}));
    chrome.permissions?.onRemoved?.addListener(() => void reconcile().catch(() => {}));
    for (const event of ["onCreated", "onUpdated", "onMoved", "onRemoved"])
      chrome.tabGroups?.[event]?.addListener(scheduleGroups);
    chrome.tabs.onAttached?.addListener(scheduleGroups);
    chrome.tabs.onDetached?.addListener(scheduleGroups);
    chrome.tabs.onRemoved?.addListener(tabId => {
      scheduleGroups();
      void chrome.storage.session.remove(ui.keys.surface(tabId)).catch(() => {});
      void chrome.storage.session.remove(ui.keys.toast(tabId)).catch(() => {});
    });
    return { candidate, topSender, register, validate, attach, toastData, ensure, notify, toolbar, install,
      scheduleGroups, activate, reconcile, refreshGroups, enabled: () => surfaceEnabled === true };
  }
  globalThis.TaskPulseSurfaceWorker = { create };
})();
