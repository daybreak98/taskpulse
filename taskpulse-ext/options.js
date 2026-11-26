(() => {
  const ui = globalThis.TaskPulseUI, web = globalThis.TaskPulseWeb;
  const globalButton = document.getElementById("global"), status = document.getElementById("status");
  const group = document.getElementById("group");
  let enabled = false, mode = "dataagent";
  async function refresh() {
    const saved = await chrome.storage.local.get([ui.keys.enabled, ui.keys.grouping]);
    enabled = saved[ui.keys.enabled] === true && await chrome.permissions.contains({ origins: ui.origins });
    mode = saved[ui.keys.grouping] === "tab" ? "tab" : "dataagent";
    globalButton.textContent = enabled ? "关闭全网页显示并撤销授权" : "启用全网页显示";
    group.textContent = mode === "tab" ? "切换为 DataAgent 分组" : "切换为标签组";
  }
  globalButton.addEventListener("click", async () => {
    globalButton.disabled = true;
    try {
      if (enabled) {
        await chrome.storage.local.set({ [ui.keys.enabled]: false });
        await chrome.permissions.remove({ origins: ui.origins });
        status.textContent = "已关闭全网页显示";
      } else {
        const granted = await chrome.permissions.request({ origins: ui.origins });
        await chrome.storage.local.set({ [ui.keys.enabled]: granted });
        status.textContent = granted ? "已授权，普通网页会自动显示胶囊" : "未授权，保持 DataAgent 网页模式";
      }
    } catch { status.textContent = "授权操作未完成，请重试"; }
    finally { globalButton.disabled = false; await refresh(); }
  });
  document.getElementById("reset").addEventListener("click", () =>
    chrome.storage.local.remove(ui.keys.position));
  group.addEventListener("click", async () => {
    await chrome.storage.local.set({ [ui.keys.grouping]: mode === "tab" ? "dataagent" : "tab" }); await refresh();
  });
  document.getElementById("dataagent").addEventListener("click", () => chrome.tabs.create({ url: web.page }));
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") void refresh(); });
  void refresh();
})();
