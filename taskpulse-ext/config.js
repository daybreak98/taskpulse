// The standalone build uses the pilot's DataAgent WEB configuration.
(() => {
  const page = new URL("https://dataagent.corp.kuaishou.com/ai/data-agent");
  const match = page.href + "*";

  function id(value) {
    const text = String(value ?? "");
    return /^[1-9]\d{0,19}$/.test(text) ? text : "";
  }

  function conversationPage(value) {
    try {
      const url = new URL(value);
      if (url.origin === page.origin &&
          (url.pathname === page.pathname || url.pathname.startsWith(page.pathname + "/"))) {
        return url;
      }
    } catch {
      // The tab can be closed, navigating or outside the extension's host.
    }
    return null;
  }

  function conversationId(value) {
    return id(conversationPage(value)?.searchParams.get("conversationId"));
  }

  function conversationUrl(cid, agentId) {
    if (!id(cid)) return "";
    const url = new URL(page);
    url.searchParams.set("agentId", id(agentId));
    url.searchParams.set("openHistory", "true");
    url.searchParams.set("conversationId", id(cid));
    url.searchParams.set("formPage", "web");
    return url.href;
  }

  globalThis.TaskPulseWeb = {
    page: page.href, match, id, conversationPage, conversationId, conversationUrl,
    api: {
      prefix: "/rest/flow/api/v1",
      conv: "/conversations/list",
      queue: "/conversations/{cid}/queue",
      messages: "/conversations/{cid}/messages?pageNo=1&pageSize=1",
      state: "sessionState",
      pending: "pending",
      idle: ["IDLE"],
      body: {
        agentIdList: [515, 2528, 4033], isCurAgent: false, searchKey: "",
        ungroupedPageNo: 1, ungroupedPageSize: 60
      },
      marks: ["当前服务繁忙", "tpm limit"]
    },
    timing: {
      tick: 1_000, idleTick: 2_000, report: 4_000, urgentReport: 250, list: 30_000,
      activeList: 5_000, hot: 2_000, idle: 60_000, hotWindow: 20_000,
      settleFast: 12_000, settleSlow: 90_000, queueBudget: 6, watch: 24,
      coldIdle: 300_000, pressureBase: 30_000, pressureMax: 300_000,
      budgetWindow: 2_000, requestBurst: 12, round: 10_000, request: 4_000,
      queueStale: 120_000, sourceStale: 180_000
    },
    keys: { state: "tp-web-state-v1", leader: "tp-web-leader-v1", opened: "tp-web-opened-conversations-v1" }
  };
})();
