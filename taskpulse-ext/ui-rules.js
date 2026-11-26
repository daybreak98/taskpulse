// Shared, pure presentation rules. No browsing or collection here.
(() => {
  const keys = {
    enabled: "tp-web-global-enabled", position: "tp-web-position",
    grouping: "tp-web-grouping", tabGroups: "tp-web-tab-groups",
    surface: tabId => "tp-web-surface:" + tabId,
    toast: tabId => "tp-web-toast:" + tabId
  };
  const origins = ["http://*/*", "https://*/*"];
  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi));
  const normalized = value => ({
    x: Number.isFinite(value?.x) ? clamp(value.x, 0, 1) : 1,
    y: Number.isFinite(value?.y) ? clamp(value.y, 0, 1) : null
  });
  function place(value, viewportWidth, viewportHeight, width, height) {
    const p = normalized(value);
    // The default remains the original right-edge, 22px top capsule.
    const anchorX = p.x * Math.max(0, viewportWidth - 44);
    const anchorY = p.y === null ? 22 : p.y * Math.max(0, viewportHeight - 84);
    return { left: Math.round(clamp(anchorX - (width - 44) * p.x, 0, viewportWidth - width)),
      top: Math.round(clamp(anchorY, 0, viewportHeight - height)) };
  }
  function move(value, dx, dy, w, h) {
    const p = normalized(value);
    const x = p.x * Math.max(0, w - 44), y = p.y === null ? 22 : p.y * Math.max(0, h - 84);
    return { x: clamp((x + dx) / Math.max(1, w - 44), 0, 1),
      y: clamp((y + dy) / Math.max(1, h - 84), 0, 1) };
  }
  function ordinary(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url : null;
    } catch { return null; }
  }
  const colors = { grey: "#9aa6ae", blue: "#78a6db", red: "#d28d8e", yellow: "#d2b46e",
    green: "#78b99b", pink: "#cb95b6", purple: "#a99ad8", cyan: "#75b8c4", orange: "#d9a077" };
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
  function buildGroups(tabs, groups, web) {
    const byId = new Map(groups.map(group => [group.id, group]));
    const selected = new Map();
    // Prefer the active copy within grouped tabs, then deterministic tab ID.
    // A duplicate open conversation contributes exactly one row.
    const sorted = [...tabs].sort((a,b) => Number(b.groupId >= 0) - Number(a.groupId >= 0) ||
      Number(Boolean(b.active)) - Number(Boolean(a.active)) || a.id - b.id);
    for (const tab of sorted) {
      const url = web.conversationPage(tab.url);
      const cid = web.conversationId(tab.url);
      if (!url || !cid || selected.has(cid)) continue;
      const agentId = web.id(url.searchParams.get("agentId"));
      const group = byId.get(tab.groupId);
      selected.set(cid, group ? { agentId, key: "tab:" + group.id,
        name: clean(group.title) || "未命名标签组", color: colors[group.color] || colors.grey } :
        { agentId, key: "tab:ungrouped", name: "未分组标签页", color: "" });
    }
    return Object.fromEntries(selected);
  }
  function groupFor(task, mode, mapping = {}) {
    const platform = clean(task.group) || "未分组";
    if (mode !== "tab") return { key: "da:" + platform, name: platform, color: "" };
    const match = mapping[task.id];
    if (match && (!match.agentId || match.agentId === task.agentId)) return match;
    return { key: "closed:" + platform, name: "未打开 · " + platform, color: "" };
  }
  globalThis.TaskPulseUI = { keys, origins, normalized, place, move, ordinary, buildGroups, groupFor };
})();
