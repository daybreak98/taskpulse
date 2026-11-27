// Same-origin resource timing metadata only. Do not patch fetch/XHR,
// read native bodies, credentials or chat text, or send a request.
// These observations are diagnostics, not authoritative reply evidence.
(() => {
  function observe(web) {
    const types = ["list", "queue", "messages"];
    const counts = () => Object.fromEntries(types.map(type => [type, 0]));
    const native = counts(), own = counts(), near = counts(), unknown = counts();
    const outstanding = [], last = new Map();
    const cap = 128;
    const clock = () => globalThis.performance.now();
    function identify(value) {
      try {
        const url = new URL(value, location.origin);
        if (url.origin !== location.origin || !url.pathname.startsWith(web.api.prefix + "/conversations/")) return null;
        const tail = url.pathname.slice((web.api.prefix + "/conversations/").length);
        if (tail === "list") return { type: "list", key: "list", href: url.href };
        const match = /^(\d{1,20})\/(queue|messages)$/.exec(tail);
        if (!match || !web.id(match[1])) return null;
        return { type: match[2], key: match[2] + "/" + match[1], href: url.href };
      } catch { return null; }
    }
    function startOwn(value) {
      const item = identify(value);
      if (!item) return () => {};
      const at = clock();
      own[item.type]++;
      const previous = last.get(item.key);
      if (previous !== undefined && at >= previous && at - previous <= 2000) near[item.type]++;
      const record = { href: item.href, start: at, end: Infinity };
      outstanding.push(record);
      if (outstanding.length > cap) outstanding.shift();
      return () => { record.end = clock(); };
    }
    function receive(entries) {
      for (const entry of entries) {
        if (!["fetch", "xmlhttprequest"].includes(entry.initiatorType)) continue;
        const item = identify(entry.name);
        if (!item || !Number.isFinite(entry.startTime)) continue;
        // Conservatively exclude our own overlapping calls. A simultaneous
        // native request can be undercounted; never claim it was saved.
        if (outstanding.some(r => r.href === item.href &&
            entry.startTime >= r.start - 2 && entry.startTime <= r.end + 2)) continue;
        const status = Number(entry.responseStatus);
        if (!(status >= 200 && status < 300)) {
          if (!status) unknown[item.type]++;
          continue;
        }
        native[item.type]++;
        const end = Number(entry.responseEnd);
        if (Number.isFinite(end)) {
          last.delete(item.key);
          last.set(item.key, end);
          if (last.size > cap) last.delete(last.keys().next().value);
        }
      }
    }
    let supported = false;
    if (typeof PerformanceObserver === "function" && typeof globalThis.performance?.now === "function") {
      try {
        const observer = new PerformanceObserver(list => receive(list.getEntries()));
        observer.observe({ type: "resource", buffered: false });
        supported = true;
      } catch { /* No Resource Timing support: normal collection unaffected. */ }
    }
    return {
      startOwn: supported ? startOwn : () => () => {},
      snapshot: () => ({ supported, native: { ...native }, own: { ...own },
        possibleOverlap: { ...near }, unknownStatus: { ...unknown } })
    };
  }
  globalThis.TaskPulseNative = { observe };
})();
