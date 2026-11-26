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
  // Keep legacy x/y storage and the right-side default. Only a drag into
  // the top docking band selects horizontal orientation.
  function move(value, dx, dy, w, h) {
    const p = normalized(value);
    const x = p.x * Math.max(0, w - 44) + dx;
    const y = (p.edge === "top" ? 0 : p.y === null ? 22 : p.y * Math.max(0, h - 84)) + dy;
    const edge = y <= (p.edge === "top" ? 64 : 42) ? "top" : "";
    return { x: clamp(x / Math.max(1, w - 44), 0, 1),
      y: edge ? 0 : clamp(y / Math.max(1, h - 84), 0, 1), ...(edge ? { edge } : {}) };
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
    const gap = 10;
    const cw = Math.min(w, horizontal ? 108 : 44), ch = Math.min(h, horizontal ? 32 : 84);
    const x = Math.round(p.x * (w - cw));
    const y = Math.round(clamp(horizontal ? 8 : p.y === null ? 22 : p.y * (h - ch), 0, h - ch));
    const cap = rect(x, y, cw, ch);
    let panel = null, bridge = null, relation = "";
    if (expanded && panelHeight > 0) {
      const pw = Math.min(240, w);
      const ph = Math.min(panelHeight, h);
      const leftRoom = x >= pw + gap, rightRoom = w - x - cw >= pw + gap;
      if (!horizontal && (leftRoom || rightRoom)) {
        const left = leftRoom && (!rightRoom || p.x >= .5);
        const py = clamp(y + ch / 2 - ph / 2, 0, h - ph);
        panel = rect(left ? x - gap - pw : x + cw + gap, py, pw, ph);
        const cy = clamp(y + ch / 2, panel.top + Math.min(8, ph / 2), panel.top + ph - Math.min(8, ph / 2));
        bridge = rect(left ? x - gap : x + cw, cy - 5, gap, 10);
        relation = "side";
      } else if (h > ch + gap + 1) {
        // Top-docked capsules open downward; on short viewports use the
        // available side of the anchor. Do not move the capsule on expand.
        const below = horizontal || h - y - ch >= y;
        const available = below ? h - y - ch - gap : y - gap;
        const height = Math.min(ph, Math.max(1, available));
        const px = clamp(x + cw / 2 - pw / 2, 0, w - pw);
        panel = rect(px, below ? y + ch + gap : y - gap - height, pw, height);
        const cx = clamp(x + cw / 2, panel.left + Math.min(8,pw / 2), panel.left + pw - Math.min(8,pw / 2));
        bridge = rect(cx - 5, below ? y + ch : y - gap, 10, gap);
        relation = "vertical";
      }
    }
    const boxes = [cap, panel, bridge].filter(Boolean);
    const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top));
    const width = Math.max(...boxes.map(b => b.left + b.width)) - left;
    const height = Math.max(...boxes.map(b => b.top + b.height)) - top;
    const local = b => b && rect(b.left - left, b.top - top, b.width, b.height);
    return { left, top, width, height, horizontal, capsule: local(cap), panel: local(panel),
      bridge: local(bridge), relation };
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
    return "path('" + [rounded(layout.capsule, 999),
      layout.panel && rounded(layout.panel, 12), layout.bridge && rounded(layout.bridge, 0)]
      .filter(Boolean).join(" ") + "')";
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
