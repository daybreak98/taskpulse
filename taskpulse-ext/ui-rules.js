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
    y: Number.isFinite(value?.y) ? clamp(value.y, 0, 1) : null,
    ...(value?.edge === "top" ? { edge: "top" } : {})
  });
  // Identical pill geometry rotated 90 degrees: 108 x 32 or 32 x 108.
  // Preserve the normalized x/y storage and the top docking hysteresis.
  const pillSize = horizontal => horizontal ? { width: 108, height: 32 } : { width: 32, height: 108 };
  function move(value, dx, dy, w, h) {
    const p = normalized(value), wasTop = p.edge === "top";
    const before = pillSize(wasTop);
    const oldW = Math.min(w, before.width), oldH = Math.min(h, before.height);
    const x = p.x * Math.max(0, w - oldW) + oldW / 2 + dx;
    const y = (wasTop ? 8 : p.y === null ? 22 : p.y * Math.max(0, h - oldH)) + dy;
    const edge = y <= (wasTop ? 64 : 42) ? "top" : "";
    const after = pillSize(Boolean(edge));
    const cw = Math.min(w, after.width), ch = Math.min(h, after.height);
    return { x: clamp((x - cw / 2) / Math.max(1, w - cw), 0, 1),
      y: edge ? 0 : clamp(y / Math.max(1, h - ch), 0, 1), ...(edge ? { edge } : {}) };
  }
  function place(value, viewportWidth, viewportHeight, width, height) {
    const p = normalized(value);
    const anchorX = p.x * Math.max(0, viewportWidth - 44);
    const anchorY = p.y === null ? 22 : p.y * Math.max(0, viewportHeight - 84);
    return { left: Math.round(clamp(anchorX - (width - 44) * p.x, 0, viewportWidth - width)),
      top: Math.round(clamp(anchorY, 0, viewportHeight - height)) };
  }
  const rect = (left, top, width, height) => ({
    left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height)
  });
  function glassLayout(value, w, h, expanded = false, panelHeight = 0) {
    const p = normalized(value), horizontal = p.edge === "top";
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const size = pillSize(horizontal);
    const cw = Math.min(w, size.width), ch = Math.min(h, size.height);
    const x = Math.round(p.x * (w - cw));
    const y = Math.round(clamp(horizontal ? 8 : p.y === null ? 22 : p.y * (h - ch), 0, h - ch));
    if (expanded) {
      // Restore the original replacement interaction: the panel occupies
      // the capsule's anchor, with a horizontal counter inside its header.
      // Cover the previous capsule so hover expansion cannot flicker.
      const pw = Math.min(240, w);
      const ph = Math.min(h, Math.max(ch, Math.round(panelHeight) || 0));
      const left = clamp(x - (pw - cw) * p.x, 0, w - pw);
      const top = clamp(y, 0, h - ph);
      return { ...rect(left, top, pw, ph), horizontal, capsule: null, panel: rect(0, 0, pw, ph) };
    }
    return { ...rect(x, y, cw, ch), horizontal, capsule: rect(0, 0, cw, ch), panel: null };
  }
  // Clip to the rounded shapes, not to their bounding rectangles: a
  // rectangular iframe clip leaves visibly cut-off shadow corners on light pages.
  function glassClip(layout) {
    const rounded = (r, radius) => {
      const x = r.left, y = r.top, right = x + r.width, bottom = y + r.height;
      const k = Math.min(radius, r.width / 2, r.height / 2);
      if (!k) return "M" + x + " " + y + "H" + right + "V" + bottom + "H" + x + "Z";
      const arc = (a, b) => "A" + k + " " + k + " 0 0 1 " + a + " " + b;
      return "M" + (x + k) + " " + y + "H" + (right - k) + arc(right, y + k) +
        "V" + (bottom - k) + arc(right - k, bottom) + "H" + (x + k) +
        arc(x, bottom - k) + "V" + (y + k) + arc(x + k, y) + "Z";
    };
    return "path('" + (layout.panel ? rounded(layout.panel, 12) : rounded(layout.capsule, 999)) + "')";
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
  globalThis.TaskPulseUI = { keys, origins, normalized, place, move, glassLayout, glassClip, ordinary, buildGroups, groupFor };
})();
