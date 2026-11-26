const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

require("../taskpulse-ext/config.js");
require("../taskpulse-ext/state.js");
require("../taskpulse-ext/ui-rules.js");
const ui = globalThis.TaskPulseUI;
const web = globalThis.TaskPulseWeb;
const rules = globalThis.TaskPulseState;
const ext = path.join(__dirname, "../taskpulse-ext");
const manifest = require("../taskpulse-ext/manifest.json");
const now = 1_760_000_000_000;
const old = now - 20_000;
const id = "42";
const agent = "515";
const row = (updateTime = old, createTime = old, agentId = agent) => ({
  id, agentId, name: "核对订单分区", groupName: "数据质量", updateTime, createTime
});
const message = (updateTime, at, messageId, more = {}) => ({
  sender: "assistant", updateTime, messageId, at, ...more
});
const report = (at, conversation, options = {}) => ({
  at, listAt: options.listAt ?? at, error: options.error ?? "",
  conversations: [conversation],
  queues: options.busy === null ? {} : { [id]: { sessionState: options.busy ? "BUSY" : "IDLE", pending: [] } },
  queueAt: options.busy === null ? {} : { [id]: options.queueAt ?? at },
  queueErrors: options.queueError ? { [id]: at } : {},
  messageErrors: options.messageError ? { [id]: at } : {},
  accessErrors: options.accessError ? { [id]: at } : {},
  lastMessages: options.message ? { [id]: options.message } : {}
});

function timeline() {
  let state = rules.blank();
  return {
    next(packet, active = "") {
      const result = rules.absorb(state, packet, packet.at, active);
      state = result.state;
      return { ...result, task: state.tasks[id] };
    },
    restore(saved) { state = JSON.parse(JSON.stringify(saved)); }
  };
}

test("first successful list seeds historical replies quietly but shows running tasks", () => {
  const { next } = timeline();
  const historical = next(report(now, row(), { message: message(old, now, "prior") }));
  assert.equal(historical.task.status, "seen");
  assert.equal(historical.task.acked, old);
  assert.equal(historical.replies.length, 0);
  const busy = next(report(now + 5_000, row(), { busy: true }));
  assert.equal(busy.task.status, "running");
  assert.equal(busy.task.runAt, now + 5_000);
  assert.equal(rules.queueBusy({ sessionState: "IDLE", pending: [] }), false);
});

test("短任务回归：队列先空闲仍保留运行中，列表和回复补齐后只通知一次", () => {
  const tracker = timeline();
  tracker.next(report(now, row(), { message: message(old, now, "prior") }));
  tracker.next(report(now + 2_000, row(), { busy: true }));
  const early = tracker.next(report(now + 8_000, row(), { message: message(old, now + 8_000, "prior") }));
  assert.equal(early.task.status, "running");
  assert.equal(early.task.settleUntil, now + 98_000);
  assert.equal(early.replies.length, 0);

  const update = now + 10_000;
  const changed = tracker.next(report(now + 14_000, row(update), { message: message(update, now + 14_000, "new") }));
  assert.equal(changed.task.status, "attention");
  assert.equal(changed.replies.length, 1);
  tracker.restore(changed.state);
  const repeated = tracker.next(report(now + 18_000, row(update), {
    listAt: now + 14_000, queueAt: now + 14_000,
    message: message(update, now + 14_000, "new")
  }));
  assert.equal(repeated.replies.length, 0);
  assert.equal(repeated.task.observedAt, now + 14_000);
  assert.equal(repeated.task.replyKey, changed.task.replyKey);
});

test("有独立消息证据时立即提醒，列表补齐后不重复通知", () => {
  const { next } = timeline();
  next(report(now, row(), { busy: true }));
  const updated = now + 4_000;
  const early = next(report(now + 6_000, row(), {
    message: message(old, now + 6_000, "reply", { atMessage: updated })
  }));
  assert.equal(early.task.status, "attention");
  assert.equal(early.replies.length, 1);
  const complete = next(report(now + 30_000, row(updated), {
    message: message(updated, now + 30_000, "reply", { atMessage: updated })
  }));
  assert.equal(complete.task.status, "attention");
  assert.equal(complete.replies.length, 0);
  assert.equal(rules.revision(complete.task), rules.revision(early.task));
});

test("仅有用户消息或未知队列时不发新回复通知", () => {
  const { next } = timeline();
  next(report(now, row()));
  let current = next(report(now + 4_000, row(now + 3_000), {
    message: message(now + 3_000, now + 4_000, "user", { sender: "other" })
  }));
  assert.equal(current.task.status, "seen");
  assert.equal(current.replies.length, 0);
  current = next(report(now + 8_000, row(now + 7_000), { busy: null }));
  assert.equal(current.replies.length, 0);
  assert.equal(current.task.observedAt, now + 4_000);
});

test("历史队列样本不续期，错误和空名单分开处理", () => {
  const { next } = timeline();
  const first = next(report(now, row(), { busy: true }));
  const heartbeat = now + 130_000;
  const repeat = next(report(heartbeat, row(), { listAt: now, queueAt: now, busy: true }));
  assert.equal(repeat.task.observedAt, now);
  assert.equal(rules.view(repeat.state, heartbeat).counts.running, 0);
  const error = next(report(heartbeat + 1, row(), {
    listAt: now, queueAt: now, error: "HTTP 401", queueError: true
  }));
  assert.equal(error.task.status, first.task.status);
  assert.equal(rules.view(error.state, heartbeat + 1).stale, true);
  const empty = next({ ...report(heartbeat + 2, row()), conversations: [] });
  assert.deepEqual(rules.view(empty.state, heartbeat + 2).tasks, []);
});

test("会话正在前台查看时记已查看，跨轮回复继续分别计数", () => {
  const { next } = timeline();
  next(report(now, row()));
  const update1 = now + 1_000;
  const focused = next(report(now + 5_000, row(update1), { message: message(update1, now + 5_000, "v1") }), id);
  assert.equal(focused.task.status, "seen");
  assert.equal(focused.replies.length, 0);
  const update2 = now + 9_000;
  const away = next(report(now + 10_000, row(update2), { message: message(update2, now + 10_000, "v2") }));
  assert.equal(away.task.status, "attention");
  assert.equal(away.replies.length, 1);
});

test("长运行和频繁拉取重播的时间基线独立", () => {
  const { next } = timeline();
  next(report(now, row(), { busy: true }));
  const threshold = now + 30 * 60_000;
  const stuck = next(report(threshold, row(), { busy: true }));
  assert.equal(stuck.task.status, "stuck");
  const wake = next(report(threshold + 31 * 60_000, row(), { busy: true }));
  assert.equal(wake.task.status, "running");
  assert.equal(wake.task.runAt, threshold + 31 * 60_000);
});

test("同一回复的限流标记不会随相同列表重播或少一份消息而清掉", () => {
  const { next } = timeline();
  next(report(now, row()));
  const update = now + 1_000;
  const failed = next(report(now + 4_000, row(update), {
    message: message(update, now + 4_000, "fail", { failed: true })
  }));
  assert.equal(failed.task.status, "stuck");
  assert.equal(failed.replies.length, 1);
  const repeat = next(report(now + 8_000, row(update)));
  assert.equal(repeat.task.status, "stuck");
  assert.equal(repeat.replies.length, 0);
});

test("路径验证和扩展权限限制在 DataAgent", () => {
  assert.equal(web.conversationId(web.conversationUrl(id, agent)), id);
  assert.equal(web.conversationId(web.page + "-share?conversationId=" + id), "");
  assert.equal(web.conversationId("https://example.com/?next=" + web.page + "&conversationId=" + id), "");
  assert.equal(web.conversationId(web.page + "?conversationId=42x"), "");
  assert.deepEqual(manifest.host_permissions, ["https://dataagent.corp.kuaishou.com/*"]);
  assert.equal(manifest.content_scripts[0].matches[0], web.match);
  for (const file of [manifest.background.service_worker, ...manifest.content_scripts[0].js, manifest.icons["128"]]) {
    assert.ok(fs.existsSync(path.join(ext, file)));
  }
});

function worker(seed = {}) {
  const event = () => {
    const listeners = [];
    return {
      addListener: fn => listeners.push(fn),
      removeListener(fn) { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
      listeners
    };
  };
  const local = { data: structuredClone(seed.local || {}) }, session = { data: structuredClone(seed.session || {}) };
  for (const store of [local, session]) {
    store.get = async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(store.data[k])]));
    store.set = async data => Object.assign(store.data, structuredClone(data));
    store.remove = async key => { delete store.data[key]; };
  }
  const notices = new Map(seed.notices || []);
  const tabs = [{ id: 7, windowId: 1, url: web.page, active: true, status: "complete" }];
  const sender = { id: "unit", frameId: 0, tab: tabs[0], url: web.page };
  const chrome = {
    storage: { local, session },
    runtime: {
      id: "unit", getManifest: () => manifest, getURL: file => file,
      onMessage: event(), onInstalled: event(), onStartup: event()
    },
    action: { onClicked: event(), setBadgeText: async () => {} },
    notifications: {
      onClicked: event(), onClosed: event(), getPermissionLevel: async () => "granted",
      create: async (key, value) => notices.set(key, value),
      clear: async key => notices.delete(key), getAll: async () => Object.fromEntries(notices)
    },
    windows: {
      getLastFocused: async () => ({ id: 1, focused: true }),
      update: async () => ({ focused: true })
    },
    tabs: {
      onUpdated: event(), onRemoved: event(), onActivated: event(),
      sendMessage: async () => null,
      query: async query => query.active ? tabs.filter(tab => tab.active) : tabs,
      get: async tabId => structuredClone(tabs.find(tab => tab.id === tabId)),
      create: async ({ url, active = true }) => {
        if (active) for (const tab of tabs) tab.active = false;
        const created = { id: tabs.length + 100, windowId: 1, url, status: "complete", active };
        tabs.push(created);
        return created;
      },
      update: async tabId => {
        for (const tab of tabs) tab.active = tab.id === tabId;
        return structuredClone(tabs.find(tab => tab.id === tabId));
      }
    },
    alarms: { onAlarm: event(), get: async () => ({}), create: async () => {}, clear: async () => {} }
  };
  chrome.windows.onFocusChanged = event();
  let stamp = now;
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({ chrome, URL, console, crypto: webcrypto,
    setTimeout: seed.setTimeout || setTimeout, clearTimeout: seed.clearTimeout || clearTimeout, Date: Clock });
  context.importScripts = (...files) => files.forEach(file =>
    vm.runInContext(fs.readFileSync(path.join(ext, file), "utf-8"), context, { filename: file }));
  context.importScripts("background.js");

  session.data[web.keys.leader] = { pageId: "page", lease: "one", tabId: 7 };
  function send(msg, from = sender) {
    return new Promise(resolve => {
      if (!chrome.runtime.onMessage.listeners[0](msg, from, resolve)) resolve(undefined);
    });
  }
  function deliver(payload, lease = "one") {
    stamp = payload.at;
    return send({ kind: "tp.webstate", pageId: "page", lease, payload });
  }
  return { tabs, sender, send, deliver, notices, local, session, chrome, setClock: value => { stamp = value; } };
}

test("worker rejects the old page lease and reuses a correctly verified conversation", async () => {
  const app = worker();
  assert.equal((await app.deliver(report(now, row()), "retired")).ok, false);
  assert.equal(app.local.data[web.keys.state], undefined);
  await app.deliver(report(now, row()));
  await app.deliver(report(now + 5_000, row(now + 1_000), {
    message: message(now + 1_000, now + 5_000, "v1")
  }));
  assert.equal(app.notices.size, 1);
  const ticket = [...app.notices.keys()][0];
  app.tabs.push({ id: 9, windowId: 1, url: web.conversationUrl(id, agent), status: "complete" });
  const opened = await app.send({ kind: "tp.open", id, revision: ticket.slice("tp-reply:".length) });
  assert.equal(opened.ok, true);
  assert.equal(app.tabs.length, 2);
  assert.equal(app.local.data[web.keys.state].tasks[id].status, "seen");
});

test("stale jump ticket can navigate but does not mark a newer reply as seen", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(report(now + 6_000, row(now + 4_000), {
    message: message(now + 4_000, now + 6_000, "v1")
  }));
  const ticket = [...app.notices.keys()][0];
  await app.deliver(report(now + 20_000, row(now + 16_000), {
    message: message(now + 16_000, now + 20_000, "v2")
  }));
  app.chrome.notifications.onClicked.listeners[0](ticket);
  for (let i = 0; i < 40 && app.notices.has(ticket); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.notices.has(ticket), false);
  assert.equal(app.tabs[1].url, web.conversationUrl(id, agent));
  assert.equal(app.local.data[web.keys.state].tasks[id].status, "attention");
});

test("failed tab action cannot acknowledge the selected reply", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(report(now + 6_000, row(now + 4_000), {
    message: message(now + 4_000, now + 6_000, "v1")
  }));
  app.chrome.tabs.create = async () => { throw new Error("test: browser rejected navigation"); };
  const task = app.local.data[web.keys.state].tasks[id];
  const response = await app.send({ kind: "tp.open", id, revision: rules.revision(task) });
  assert.equal(response.ok, false);
  assert.equal(app.local.data[web.keys.state].tasks[id].status, "attention");
});

test("标记已处理只影响当前版本，新回复照常显示和通知", async () => {
  const app = worker();
  const task = () => app.local.data[web.keys.state].tasks[id];
  await app.deliver(report(now, row(), { busy: true }));
  let version = rules.revision(task());
  assert.equal((await app.send({ kind: "tp.check", id, revision: version, checked: true })).ok, false);

  await app.deliver(report(now + 5_000, row(now + 1_000), {
    message: message(now + 1_000, now + 5_000, "first")
  }));
  version = rules.revision(task());
  assert.equal(task().status, "attention");
  assert.equal((await app.send({ kind: "tp.check", id, revision: version, checked: true })).ok, true);
  assert.equal(task().status, "seen");
  assert.equal(task().checkedRevision, version);
  assert.equal((await app.send({ kind: "tp.check", id, revision: version, checked: false })).ok, true);
  assert.equal(task().checkedRevision, undefined);
  await app.send({ kind: "tp.check", id, revision: version, checked: true });

  await app.deliver(report(now + 15_000, row(now + 10_000), {
    message: message(now + 10_000, now + 15_000, "second")
  }));
  assert.equal(task().status, "attention");
  assert.notEqual(rules.revision(task()), task().checkedRevision);
  assert.equal((await app.send({ kind: "tp.check", id, revision: version, checked: true })).ok, false);
  assert.equal(task().status, "attention");
  assert.equal(app.notices.size, 1);
});

test("已读后的第二条消息独立提醒，列表空档保留未读", () => {
  const tracker = timeline();
  tracker.next(report(now, row(), { busy: true }));
  const first = tracker.next(report(now + 45_000, row(now + 20_000), {
    message: message(now + 20_000, now + 45_000, "one", { atMessage: now + 20_000 })
  }));
  const firstRevision = rules.revision(first.task);
  const partial = tracker.next(report(now + 50_000, row(now + 40_000)));
  assert.equal(partial.task.pending, true);
  assert.equal(rules.revision(partial.task), firstRevision);
  partial.state.tasks[id] = rules.acknowledge(partial.task);
  tracker.restore(partial.state);

  const second = tracker.next(report(now + 55_000, row(now + 40_000), {
    message: message(now + 40_000, now + 55_000, "two", { atMessage: now + 40_000 })
  }));
  assert.equal(second.replies.length, 1);
  assert.notEqual(rules.revision(second.task), firstRevision);
});

test("首轮名单之外的老会话后来出现时，提醒基线之后的新回复", () => {
  const { next } = timeline();
  next({ ...report(now, row()), conversations: [] });
  const update = now + 10_000;
  const actual = next(report(now + 30_000, row(update), {
    message: message(update, now + 30_000, "discovered", { atMessage: update })
  }));
  assert.equal(actual.task.status, "attention");
  assert.equal(actual.replies.length, 1);
});

test("新采集页只有名单时，保留旧队列故障直到有效样本到达", () => {
  const { next } = timeline();
  next(report(now, row(), { busy: true }));
  next(report(now + 5_000, row(), { queueAt: now, busy: true, queueError: true }));
  const handoff = next(report(now + 10_000, row(), { busy: null }));
  assert.equal(handoff.task.queueError, true);
  assert.equal(rules.view(handoff.state, now + 10_000).counts.running, 0);
  const recovered = next(report(now + 15_000, row(), { busy: true }));
  assert.equal(recovered.task.queueError, false);
  assert.equal(rules.view(recovered.state, now + 15_000).counts.running, 1);
});

test("复查发现晚写入的限流文案时，更新同一回复的状态", () => {
  const { next } = timeline();
  next(report(now, row()));
  const update = now + 1_000;
  next(report(now + 5_000, row(update), { message: message(update, now + 5_000, "reply") }));
  const late = next(report(now + 40_000, row(update), {
    message: message(update, now + 40_000, "reply", { failed: true })
  }));
  assert.equal(late.task.status, "stuck");
  assert.equal(late.replies.length, 0);
});

test("通知创建短暂失败时，重启后仍能重试，已处理后撤回通知", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.chrome.notifications.create = async () => { throw new Error("test: temporary notification failure"); };
  const update = now + 3_000;
  await app.deliver(report(now + 6_000, row(update), { message: message(update, now + 6_000, "retry") }));
  assert.equal(app.notices.size, 0);

  const restarted = worker();
  restarted.local.data = structuredClone(app.local.data);
  await restarted.deliver(report(now + 12_000, row(update)));
  assert.equal(restarted.notices.size, 1);
  const revision = rules.revision(restarted.local.data[web.keys.state].tasks[id]);
  await restarted.send({ kind: "tp.check", id, revision, checked: true });
  assert.equal(restarted.notices.size, 0);
});

for (const redirected of [false, true]) {
  test(redirected ? "登录重定向保留系统通知和未读" : "延迟落地的旧通知不会清除新回复", async () => {
    const app = worker();
    await app.deliver(report(now, row()));
    await app.deliver(report(now + 5_000, row(now + 1_000), {
      message: message(now + 1_000, now + 5_000, "old-target")
    }));
    const ticket = [...app.notices.keys()][0];
    await app.deliver(report(now + 15_000, row(now + 10_000), {
      message: message(now + 10_000, now + 15_000, "latest")
    }));
    const create = app.chrome.tabs.create;
    app.chrome.tabs.create = async args => {
      const tab = await create(args);
      Object.assign(tab, { url: "about:blank", pendingUrl: args.url, status: "loading" });
      return tab;
    };
    app.chrome.notifications.onClicked.listeners[0](ticket);
    for (let i = 0; i < 20 && app.chrome.tabs.onUpdated.listeners.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(app.notices.has(ticket), true);
    const tab = app.tabs[1];
    tab.url = redirected ? new URL("/login", web.page).href : tab.pendingUrl;
    delete tab.pendingUrl;
    tab.status = "complete";
    for (const listener of [...app.chrome.tabs.onUpdated.listeners]) listener(tab.id, { url: tab.url, status: "complete" }, tab);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(app.notices.has(ticket), redirected);
    assert.equal(app.local.data[web.keys.state].tasks[id].status, "attention");
  });
}

test("同文档进入 DataAgent 时补装采集脚本，工具栏优先使用已就绪页面", async () => {
  const app = worker();
  const page = app.tabs[0];
  const sent = [];
  let injected = false;
  app.chrome.scripting = { executeScript: async () => { injected = true; } };
  app.chrome.tabs.sendMessage = async (tabId, packet) => {
    sent.push({ tabId, kind: packet.kind });
    return injected ? { ok: true, pageId: "page", lease: "one" } : null;
  };
  app.chrome.tabs.onUpdated.listeners[0](page.id, { url: web.page }, page);
  for (let i = 0; i < 40 && !injected; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(injected, true);

  page.discarded = true;
  const ready = { id: 9, url: web.page, windowId: 1, status: "complete" };
  app.tabs.push(ready);
  app.chrome.action.onClicked.listeners[0]({ id: 80, url: "https://example.com" });
  for (let i = 0; i < 40 && !sent.some(item => item.kind === "tp.show"); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(sent.find(item => item.kind === "tp.show"), { tabId: ready.id, kind: "tp.show" });
});

async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), label || "event did not settle");
}

test("idle message failures never settle an unconfirmed run as read; recovery is deduplicated", () => {
  const { next } = timeline();
  next(report(now, row(), { message: message(old, now, "historical") }));
  next(report(now + 5_000, row(), { busy: true }));
  const idle = next(report(now + 10_000, row(), {
    message: message(old, now, "historical"), messageError: true
  }));
  assert.equal(idle.task.messageUncertain, true);
  assert.equal(rules.canAcknowledge(idle.task), false);
  const afterTimeout = next(report(now + 110_000, row(), { messageError: true }));
  assert.notEqual(afterTimeout.task.status, "seen");
  assert.equal(afterTimeout.task.acked, old);
  assert.equal(rules.view(afterTimeout.state, now + 110_000).tasks[0].uncertain, true);
  const update = now + 120_000;
  const recovered = next(report(now + 121_000, row(update), {
    message: message(update, now + 121_000, "recovered", { atMessage: now + 105_000 })
  }));
  assert.equal(recovered.task.status, "attention");
  assert.equal(recovered.task.messageUncertain, false);
  assert.equal(recovered.replies.length, 1);
  const repeated = next(report(now + 130_000, row(update), {
    message: message(update, now + 130_000, "recovered", { atMessage: now + 105_000 })
  }));
  assert.equal(repeated.replies.length, 0);
});

test("distinct server IDs at the same timestamp are independent, replay of either ID is ignored", () => {
  const tracker = timeline();
  tracker.next(report(now, row()));
  const update = now + 1_000;
  const a = tracker.next(report(now + 5_000, row(update), {
    message: message(update, now + 5_000, "same-time-a", { atMessage: update })
  }));
  a.state.tasks[id] = rules.acknowledge(a.task);
  tracker.restore(a.state);
  const b = tracker.next(report(now + 10_000, row(update), {
    message: message(update, now + 10_000, "same-time-b", { atMessage: update })
  }));
  assert.equal(b.replies.length, 1);
  assert.notEqual(rules.revision(a.task), rules.revision(b.task));
  const replay = tracker.next(report(now + 15_000, row(update), {
    message: message(update, now + 15_000, "same-time-a", { atMessage: update })
  }));
  assert.equal(replay.replies.length, 0);
  assert.equal(rules.revision(replay.task), rules.revision(b.task));
});

test("a late historical message newer than an old list timestamp is quiet at first install", () => {
  const { next } = timeline();
  const first = next(report(now, row(), {
    message: message(old, now, "historical", { atMessage: now - 1_000 })
  }));
  assert.equal(first.replies.length, 0);
  assert.equal(first.task.status, "seen");
  assert.equal(first.task.lastAssistant, "historical");
});

test("known active and unconfirmed tasks survive the 24-row discovery window", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...row(old - i), id: String(100 + i) }));
  const localBusy = rows[25].id;
  const durableBusy = rows[27].id;
  const uncertain = rows[28].id;
  const samples = new Map([[localBusy, { queue: { sessionState: "BUSY", pending: [] } }]]);
  const tracked = {
    [durableBusy]: { agentId: agent, runAt: old },
    [uncertain]: { agentId: agent, messageUncertain: true }
  };
  const ids = rules.watchRows(rows, samples, tracked, now).map(row => row.id);
  assert.equal(ids.length, 27);
  assert.ok(ids.includes(localBusy));
  assert.ok(ids.includes(durableBusy));
  assert.ok(ids.includes(uncertain));
  assert.ok(!ids.includes(rows[29].id));
});

test("collector actually polls a durable old running task after leader handoff; failed message probes recover", async () => {
  const rows = Array.from({ length: 27 }, (_, i) => ({ ...row(old - i), id: String(100 + i) }));
  const trackedId = rows.at(-1).id;
  const probeId = rows[0].id;
  let stamp = now, interval, messageFailure = true;
  let listRequests = 0;
  const queueReads = [], reports = [], listeners = [];
  const reply = data => ({ ok: true, json: async () => ({ success: true, data }) });
  const chrome = {
    storage: { local: { get: async key => ({ [key]: { tasks: { [trackedId]: { agentId: agent, runAt: old } } } }) } },
    runtime: {
      id: "collector-test",
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async packet => { if (packet.kind === "tp.webstate") reports.push(packet.payload); return { ok: true }; }
    }
  };
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({
    chrome, URL, console, crypto: webcrypto, AbortController, Date: Clock,
    location: new URL(web.page), document: { hidden: false, addEventListener() {} },
    setTimeout, clearTimeout, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async url => {
      if (url.pathname.endsWith("/list")) {
        listRequests++;
        return reply({ groups: [], ungrouped: { conversations: rows } });
      }
      const cid = url.pathname.split("/").at(-2);
      if (url.pathname.endsWith("/queue")) {
        queueReads.push(cid);
        return reply({ sessionState: cid === trackedId ? "BUSY" : "IDLE", pending: [] });
      }
      if (cid === probeId && messageFailure) throw new Error("message endpoint offline");
      return reply({ list: [{ sender: "other", id: "user-" + cid, createTime: old }] });
    }
  });
  for (const file of ["config.js", "state.js", "web-bridge.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ext, file), "utf-8"), context, { filename: file });
  }
  let page;
  listeners[0]({ kind: "tp.probe" }, {}, answer => { page = answer; });
  listeners[0]({ kind: "tp.role", pageId: page.pageId, lease: "replacement" }, {}, () => {});
  await until(() => reports.length === 1, "first collector report");
  assert.ok(reports[0].messageErrors[probeId]);
  assert.equal(reports[0].lastMessages[probeId], undefined);
  messageFailure = false;
  for (let round = 1; round <= 7; round++) {
    stamp += 5_000;
    interval();
    await until(() => reports.length >= round + 1, "collector round " + round);
  }
  assert.ok(queueReads.includes(trackedId), "old running task was evicted");
  assert.ok(!queueReads.includes(rows.at(-2).id), "cold task exceeded discovery budget");
  assert.ok(reports.some(report => report.lastMessages[probeId] && !report.messageErrors[probeId]));
  assert.ok(listRequests >= 2, "list refresh was not exercised");
  assert.ok(reports.at(-1).queueAt[trackedId], "old task was lost after list refresh");
  listeners[0]({ kind: "tp.role", pageId: page.pageId, lease: "" }, {}, () => {});
});

test("foreground report acknowledges an already-notified reply and clears the system notification", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), {
    message: message(update, now + 5_000, "foreground")
  }));
  assert.equal(app.notices.size, 1);
  app.tabs[0].url = web.conversationUrl(id, agent);
  await app.deliver(report(now + 10_000, row(update)));
  const state = app.local.data[web.keys.state];
  assert.equal(state.tasks[id].status, "seen");
  assert.equal(state.tasks[id].pending, false);
  assert.equal(app.notices.size, 0);
  assert.deepEqual(state.outbox, {});
});

test("foreground read cancels delayed outbox replay after failure and restart", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.chrome.notifications.create = async () => { throw new Error("temporary delivery failure"); };
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), {
    message: message(update, now + 5_000, "outbox")
  }));
  assert.equal(Object.keys(app.local.data[web.keys.state].outbox).length, 1);
  const resumed = worker({ local: app.local.data });
  resumed.tabs[0].url = web.conversationUrl(id, agent);
  await resumed.deliver(report(now + 15_000, row(update)));
  assert.equal(resumed.local.data[web.keys.state].tasks[id].pending, false);
  assert.deepEqual(resumed.local.data[web.keys.state].outbox, {});
  assert.equal(resumed.notices.size, 0);
  resumed.tabs[0].url = web.page;
  await resumed.deliver(report(now + 20_000, row(update)));
  assert.equal(resumed.notices.size, 0);
});

test("notification cleanup is retried after a transient clear failure", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), {
    message: message(update, now + 5_000, "clear-retry")
  }));
  const clear = app.chrome.notifications.clear;
  app.chrome.notifications.clear = async () => { throw new Error("temporary clear failure"); };
  app.tabs[0].url = web.conversationUrl(id, agent);
  await app.deliver(report(now + 10_000, row(update)));
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, false);
  assert.equal(app.notices.size, 1);
  app.chrome.notifications.clear = clear;
  app.tabs[0].url = web.page;
  await app.deliver(report(now + 15_000, row(update)));
  assert.equal(app.notices.size, 0);
});

test("different revisions never reuse a successful navigation result; failed second jump keeps its notice", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const updateA = now + 1_000, updateB = now + 10_000;
  await app.deliver(report(now + 5_000, row(updateA), { message: message(updateA, now + 5_000, "jump-a") }));
  const a = [...app.notices.keys()][0];
  await app.deliver(report(now + 15_000, row(updateB), { message: message(updateB, now + 15_000, "jump-b") }));
  const b = [...app.notices.keys()].find(key => key !== a);
  let release, attempts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const create = app.chrome.tabs.create;
  app.chrome.tabs.create = async args => {
    if (++attempts !== 1) throw new Error("second navigation failed");
    await gate;
    return create(args);
  };
  const update = app.chrome.tabs.update;
  let focusAttempts = 0;
  app.chrome.tabs.update = async tabId => {
    // The hardened path creates an inactive tab and must focus it once.
    if (!app.tabs.find(tab => tab.id === tabId)?.active && ++focusAttempts === 1) return update(tabId);
    throw new Error("second focus failed");
  };
  const first = app.send({ kind: "tp.open", id, revision: a.slice("tp-reply:".length) });
  await until(() => attempts === 1);
  app.chrome.notifications.onClicked.listeners[0](b);
  release();
  assert.equal((await first).ok, true);
  await until(() => attempts === 2, "second navigation was incorrectly coalesced");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.notices.has(b), true);
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, true);
});

test("old jump stays version-protected on subsequent report and worker restart, real visit reads the new reply", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const updateA = now + 1_000, updateB = now + 10_000;
  await app.deliver(report(now + 5_000, row(updateA), { message: message(updateA, now + 5_000, "old") }));
  const a = [...app.notices.keys()][0];
  await app.deliver(report(now + 15_000, row(updateB), { message: message(updateB, now + 15_000, "new") }));
  const b = [...app.notices.keys()].find(key => key !== a);
  assert.equal((await app.send({ kind: "tp.open", id, revision: a.slice("tp-reply:".length) })).ok, true);
  await app.deliver(report(now + 20_000, row(updateB)));
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, true);
  assert.equal(app.notices.has(b), true);
  const restarted = worker({ local: app.local.data, session: app.session.data, notices: [...app.notices] });
  restarted.tabs.splice(0, restarted.tabs.length, ...structuredClone(app.tabs));
  await restarted.deliver(report(now + 25_000, row(updateB)));
  assert.equal(restarted.local.data[web.keys.state].tasks[id].pending, true);
  const target = restarted.tabs.find(tab => tab.active);
  assert.equal((await restarted.send({ kind: "tp.visit", id }, {
    id: "unit", frameId: 0, tab: target, url: target.url
  })).ok, true);
  assert.equal(restarted.local.data[web.keys.state].tasks[id].pending, false);
  assert.equal(restarted.notices.has(b), false);
});

test("unconfirmed message cannot be checked or cleared by a foreground visit", async () => {
  const app = worker();
  await app.deliver(report(now, row(), { busy: true }));
  const update = now + 5_000;
  await app.deliver(report(now + 10_000, row(update), { messageError: true }));
  app.tabs[0].url = web.conversationUrl(id, agent);
  await app.deliver(report(now + 110_000, row(update), { messageError: true }));
  const task = app.local.data[web.keys.state].tasks[id];
  assert.equal(task.messageUncertain, true);
  assert.equal((await app.send({ kind: "tp.check", id, revision: rules.revision(task), checked: true })).ok, false);
  assert.notEqual(app.local.data[web.keys.state].tasks[id].status, "seen");
  assert.equal(app.local.data[web.keys.state].tasks[id].acked, old);
});

test("disconnect does not deliver a stale outbox; recovery delivers the current version only once", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), { message: message(update, now + 5_000, "reconnect") }));
  assert.equal(Object.keys(app.local.data[web.keys.state].outbox).length, 1);
  app.chrome.notifications.getPermissionLevel = async () => "granted";
  await app.deliver(report(now + 10_000, row(update), { error: "HTTP 401", busy: null }));
  assert.equal(app.notices.size, 0);
  await app.deliver(report(now + 15_000, row(update)));
  assert.equal(app.notices.size, 1);
  await app.deliver(report(now + 20_000, row(update)));
  assert.equal(app.notices.size, 1);
  assert.deepEqual(app.local.data[web.keys.state].outbox, {});
});

test("late focus or route events cannot remove an old-notification landing guard", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const updateA = now + 1_000, updateB = now + 10_000;
  await app.deliver(report(now + 5_000, row(updateA), { message: message(updateA, now + 5_000, "event-old") }));
  const a = [...app.notices.keys()][0];
  await app.deliver(report(now + 15_000, row(updateB), { message: message(updateB, now + 15_000, "event-new") }));
  const b = [...app.notices.keys()].find(key => key !== a);
  assert.equal((await app.send({ kind: "tp.open", id, revision: a.slice("tp-reply:".length) })).ok, true);
  const target = app.tabs.find(tab => tab.active);
  assert.equal(target.url, web.conversationUrl(id, agent));
  app.chrome.windows.onFocusChanged.listeners[0](2); // stale window event; actual focus is window 1
  for (const listener of [...app.chrome.tabs.onUpdated.listeners]) {
    listener(target.id, { url: web.page, status: "complete" }, { ...target, url: web.page });
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  await app.deliver(report(now + 20_000, row(updateB)));
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, true);
  assert.equal(app.notices.has(b), true);
  assert.equal(app.session.data["tp-web-jump-tabs-v1"][target.id]?.cid ?? app.session.data["tp-web-jump-tabs-v1"][target.id], id);
});

test("an activation event during an in-flight focus cannot discard the new guard", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const updateA = now + 1_000, updateB = now + 10_000;
  await app.deliver(report(now + 5_000, row(updateA), { message: message(updateA, now + 5_000, "focus-old") }));
  const a = [...app.notices.keys()][0];
  await app.deliver(report(now + 15_000, row(updateB), { message: message(updateB, now + 15_000, "focus-new") }));
  const b = [...app.notices.keys()].find(key => key !== a);
  const target = { id: 9, windowId: 1, url: web.conversationUrl(id, agent), status: "complete", active: false };
  app.tabs.push(target);
  let release, waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  const update = app.chrome.tabs.update;
  app.chrome.tabs.update = async tabId => { waiting = true; await gate; return update(tabId); };
  const opening = app.send({ kind: "tp.open", id, revision: a.slice("tp-reply:".length) });
  await until(() => waiting);
  app.chrome.tabs.onActivated.listeners[0]({ tabId: 7, windowId: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.session.data["tp-web-jump-tabs-v1"][target.id]?.cid ?? app.session.data["tp-web-jump-tabs-v1"][target.id], id);
  release();
  assert.equal((await opening).ok, true);
  await app.deliver(report(now + 20_000, row(updateB)));
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, true);
  assert.equal(app.notices.has(b), true);
});

test("genuine window blur and return releases the old-ticket guard and reads current reply", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const updateA = now + 1_000, updateB = now + 10_000;
  await app.deliver(report(now + 5_000, row(updateA), { message: message(updateA, now + 5_000, "blur-old") }));
  const a = [...app.notices.keys()][0];
  await app.deliver(report(now + 15_000, row(updateB), { message: message(updateB, now + 15_000, "blur-new") }));
  assert.equal((await app.send({ kind: "tp.open", id, revision: a.slice("tp-reply:".length) })).ok, true);
  let focused = false;
  app.chrome.windows.getLastFocused = async () => ({ id: 1, focused });
  app.chrome.windows.onFocusChanged.listeners[0](-1);
  await until(() => Object.keys(app.session.data["tp-web-jump-tabs-v1"] || {}).length === 0);
  assert.equal(app.local.data[web.keys.state].tasks[id].pending, true);
  focused = true;
  app.chrome.windows.onFocusChanged.listeners[0](1);
  await until(() => app.local.data[web.keys.state].tasks[id].pending === false && app.notices.size === 0);
});

test("upgrading existing storage clears notices for replies already read by the old build", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), { message: message(update, now + 5_000, "legacy") }));
  const state = structuredClone(app.local.data[web.keys.state]);
  state.tasks[id] = rules.acknowledge(state.tasks[id]);
  delete state.tasks[id].readRevision;
  const restarted = worker({ local: { [web.keys.state]: state }, notices: [...app.notices] });
  await restarted.deliver(report(now + 10_000, row(update)));
  assert.equal(restarted.local.data[web.keys.state].tasks[id].pending, false);
  assert.equal(restarted.notices.size, 0);
});

/* Read-only review counterexamples: added before the hardening implementation. */
const currentTask = app => app.local.data[web.keys.state].tasks[id];
const exactRevision = app => rules.revision(currentTask(app));
const replyReport = (at, update, key, extra = {}) => report(at, row(update), {
  message: message(update, at, key, { atMessage: update, ...extra })
});

test("P1 normal jump releases guard; a later foreground reply is read without an extra notice", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  assert.equal((await app.send({ kind: "tp.open", id, revision: exactRevision(app) })).ok, true);
  assert.equal(currentTask(app).pending, false);
  await app.deliver(replyReport(now + 15_000, now + 10_000, "B"));
  assert.equal(currentTask(app).pending, false);
  assert.equal(currentTask(app).status, "seen");
  assert.equal(app.notices.size, 0);
});

test("P1 failed inactive-target jump cannot block a later genuine tab visit", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  const target = { id: 9, windowId: 1, url: web.conversationUrl(id, agent), status: "complete", active: false };
  app.tabs.push(target);
  const update = app.chrome.tabs.update;
  app.chrome.tabs.update = async () => { throw new Error("focus failed"); };
  app.chrome.tabs.create = async () => { throw new Error("creation failed"); };
  assert.equal((await app.send({ kind: "tp.open", id, revision: exactRevision(app) })).ok, false);
  app.chrome.tabs.update = update;
  await update(target.id);
  app.chrome.tabs.onActivated.listeners[0]({ tabId: target.id, windowId: 1 });
  await until(() => currentTask(app).pending === false, "manual tab visit blocked by failed jump");
  assert.equal(app.notices.size, 0);
});

test("P1 focus changes between window and tab query: preserve unread", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.tabs[0].url = web.conversationUrl(id, agent);
  let focused = true;
  app.chrome.windows.getLastFocused = async () => ({ id: 1, focused });
  const query = app.chrome.tabs.query;
  app.chrome.tabs.query = async q => {
    const tabs = await query(q);
    if (q.active) focused = false;
    return tabs;
  };
  await app.deliver(replyReport(now + 5_000, now + 1_000, "focus-race"));
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 1);
});

test("P1 landing loses focus before serialized acknowledgment: do not clear selected reply", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  let release, entered = false, landed = false, focused = true, hold = true;
  const gate = new Promise(r => { release = r; });
  const getAll = app.chrome.notifications.getAll;
  app.chrome.notifications.getAll = async () => {
    if (hold) { entered = true; await gate; }
    return getAll();
  };
  const packet = replyReport(now + 7_000, now + 1_000, "A");
  const other = "43", update = now + 6_000;
  packet.conversations.push({ ...row(update), id: other });
  packet.queues[other] = { sessionState: "IDLE", pending: [] };
  packet.queueAt[other] = packet.at;
  packet.lastMessages[other] = message(update, packet.at, "other", { atMessage: update });
  const reporting = app.deliver(packet);
  await until(() => entered);
  app.chrome.windows.getLastFocused = async () => ({ id: 1, focused });
  const query = app.chrome.tabs.query;
  app.chrome.tabs.query = async q => {
    const tabs = await query(q);
    if (q.active && tabs[0]?.url.includes("conversationId=42")) landed = true;
    return tabs;
  };
  const opening = app.send({ kind: "tp.open", id, revision: exactRevision(app) });
  await until(() => landed);
  await new Promise(r => setTimeout(r, 5));
  focused = false;
  hold = false;
  release();
  await reporting;
  const result = await opening;
  assert.equal(result.ok, false);
  assert.equal(currentTask(app).pending, true);
  assert.ok([...app.notices.keys()].some(key => key.endsWith("message.A")));
});

test("P1 message failure after a user-only success on the same list version remains uncertain", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const update = now + 1_000;
  await app.deliver(replyReport(now + 5_000, update, "user", { sender: "other" }));
  await app.deliver(report(now + 10_000, row(update), { messageError: true }));
  assert.equal(currentTask(app).messageUncertain, true);
  assert.equal(rules.view(app.local.data[web.keys.state], now + 10_000).tasks[0].uncertain, true);
  assert.equal((await app.send({ kind: "tp.check", id, revision: exactRevision(app), checked: true })).ok, false);
  await app.deliver(replyReport(now + 15_000, update, "B"));
  assert.equal(currentTask(app).pending, true);
  assert.equal(currentTask(app).messageUncertain, false);
  assert.equal(app.notices.size, 1);
});

test("P1 unread A cannot terminate B while latest message still returns A", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  await app.deliver(report(now + 12_000, row(now + 10_000), { busy: true }));
  const oldA = { atMessage: now + 1_000 };
  await app.deliver(replyReport(now + 15_000, now + 10_000, "A", oldA));
  assert.equal(currentTask(app).awaitingReply, true);
  assert.equal(currentTask(app).status, "running");
  assert.equal(currentTask(app).pending, true);
  await app.deliver(replyReport(now + 110_000, now + 10_000, "A", oldA));
  assert.equal(currentTask(app).messageUncertain, true);
  assert.equal((await app.send({ kind: "tp.check", id, revision: exactRevision(app), checked: true })).ok, false);
  await app.deliver(replyReport(now + 115_000, now + 10_000, "B", { atMessage: now + 114_000 }));
  assert.equal(currentTask(app).awaitingReply, false);
  assert.equal(currentTask(app).status, "attention");
  assert.ok(currentTask(app).replyKey.endsWith("B"));
});

test("P1 distinct server IDs with missing timestamps and the same list version are recognized once", () => {
  const tracker = timeline(), update = now + 1_000;
  tracker.next(report(now, row(), { message: message(old, now, "history") }));
  const a = tracker.next(report(now + 5_000, row(update), { message: message(update, now + 5_000, "A") }));
  a.state.tasks[id] = rules.acknowledge(a.task);
  tracker.restore(a.state);
  const b = tracker.next(report(now + 10_000, row(update), { message: message(update, now + 10_000, "B") }));
  assert.equal(b.replies.length, 1);
  assert.equal(b.task.replyKey, "message.B");
  assert.equal(tracker.next(report(now + 15_000, row(update), {
    message: message(update, now + 15_000, "A")
  })).replies.length, 0);
  assert.equal(tracker.next(report(now + 20_000, row(update), {
    message: message(update, now + 20_000, "history")
  })).task.replyKey, "message.B");
});

test("P1 invalid or cached list cannot clear a prior source failure or auto-read", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  await app.deliver(report(now + 10_000, row(update), { listAt: now + 5_000, busy: null, error: "HTTP 401" }));
  app.tabs[0].url = web.conversationUrl(id, agent);
  await app.deliver(report(now + 15_000, row(update), { listAt: 0, busy: null }));
  assert.equal(app.local.data[web.keys.state].error, "HTTP 401");
  assert.equal(currentTask(app).pending, true);
  await app.deliver(report(now + 20_000, row(update), { listAt: now + 5_000, busy: null }));
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 0); // explicit authorization loss hides the old title
  assert.equal(rules.view(app.local.data[web.keys.state], now + 20_000).tasks.length, 0);
  await app.deliver(report(now + 25_000, row(update)));
  assert.equal(currentTask(app).pending, false);
  assert.equal(app.notices.size, 0);
});

test("P1 durable old active task remains pollable when absent from a bounded service list", () => {
  const tracker = timeline();
  const active = tracker.next(report(now, row(), { busy: true }));
  const newer = Array.from({ length: 27 }, (_, i) => ({ ...row(now + i + 1), id: String(100 + i) }));
  const watched = rules.watchRows(newer, new Map(), active.state.tasks, now + 5_000);
  const retained = watched.find(item => item.id === id);
  assert.ok(retained, "missing retained task");
  assert.equal(retained.retained, true);
  assert.equal(watched.length, 25);
  const result = tracker.next({ ...report(now + 10_000, retained, {
    message: message(old, now + 10_000, "completion", { atMessage: now + 8_000 })
  }), conversations: [retained] });
  assert.equal(result.task.status, "attention");
  assert.equal(result.replies.length, 1);
  assert.equal(rules.view(result.state, now + 10_000).tasks[0].id, id);
  const expired = rules.watchRows(newer, new Map(), active.state.tasks, now + 8 * 24 * 60 * 60_000);
  assert.ok(!expired.some(item => item.id === id), "retention must stay bounded");
});

test("P2 current pending outbox survives a 24-hour permission outage", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  await app.deliver(replyReport(now + 5_000, update, "A"));
  assert.equal(app.notices.size, 0);
  app.chrome.notifications.getPermissionLevel = async () => "granted";
  const at = now + 24 * 60 * 60_000 + 10_000;
  await app.deliver(replyReport(at, update, "A"));
  assert.equal(app.notices.size, 1);
  await app.deliver(replyReport(at + 5_000, update, "A"));
  assert.equal(app.notices.size, 1);
});

test("P2 explicit tab visit restores original failed-reply acknowledgment behavior", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "failed", { failed: true }));
  assert.equal(currentTask(app).status, "stuck");
  app.tabs[0].url = web.conversationUrl(id, agent);
  app.chrome.tabs.onActivated.listeners[0]({ tabId: 7, windowId: 1 });
  await until(() => currentTask(app).pending === false, "failed reply manual visit did not acknowledge");
  assert.equal(app.notices.size, 0);
});

test("P2 stale queue or failed queue prevents explicit check and jump acknowledgment", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  await app.deliver(report(now + 10_000, row(update), { busy: null, queueError: true }));
  assert.equal((await app.send({ kind: "tp.check", id, revision: exactRevision(app), checked: true })).ok, false);
  const result = await app.send({ kind: "tp.open", id, revision: exactRevision(app) });
  assert.equal(result.ok, true);
  assert.equal(result.clearNotice, false);
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 1);
});

test("P1 new tab is not activated before its version guard is persisted", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  const oldRevision = exactRevision(app);
  await app.deliver(replyReport(now + 15_000, now + 10_000, "B"));
  const create = app.chrome.tabs.create, update = app.chrome.tabs.update;
  let createdInactive = false, protectedBeforeFocus = false;
  app.chrome.tabs.create = async args => {
    createdInactive = args.active === false;
    return create(args);
  };
  app.chrome.tabs.update = async tabId => {
    protectedBeforeFocus = !!app.session.data["tp-web-jump-tabs-v1"]?.[tabId];
    return update(tabId);
  };
  assert.equal((await app.send({ kind: "tp.open", id, revision: oldRevision })).ok, true);
  assert.equal(createdInactive, true);
  assert.equal(protectedBeforeFocus, true);
  assert.equal(currentTask(app).pending, true);
});

test("P1 notification closure is durable evidence of delivery, even after interrupted persistence", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  await app.deliver(replyReport(now + 5_000, update, "A"));
  const saved = app.local.data[web.keys.state];
  const rev = exactRevision(app), ticket = "tp-reply:" + rev;
  // Simulate the create/commit gap: the notification appeared and was closed,
  // but the durable outbox still contains the revision when the worker restarts.
  const restarted = worker({ local: { [web.keys.state]: saved } });
  const listener = restarted.chrome.notifications.onClosed.listeners[0];
  assert.equal(typeof listener, "function");
  listener(ticket, true);
  await restarted.deliver(replyReport(now + 10_000, update, "A"));
  assert.equal(currentTask(restarted).pending, true);
  assert.equal(restarted.notices.size, 0);
  assert.deepEqual(restarted.local.data[web.keys.state].outbox, {});
});

test("P2 foreground changes while permission check is pending: cancel delayed delivery", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => {
    app.tabs[0].url = web.conversationUrl(id, agent);
    return "granted";
  };
  let creates = 0;
  const create = app.chrome.notifications.create;
  app.chrome.notifications.create = async (...args) => { creates++; return create(...args); };
  await app.deliver(replyReport(now + 5_000, update, "A"));
  assert.equal(currentTask(app).pending, false);
  assert.equal(creates, 0);
  assert.equal(app.notices.size, 0);
});

test("P1 normal row jump while running allows a later foreground reply to auto-read", async () => {
  const app = worker();
  await app.deliver(report(now, row(), { busy: true }));
  const opened = await app.send({ kind: "tp.open", id, revision: exactRevision(app), intent: "row" });
  assert.equal(opened.ok, true);
  assert.equal(currentTask(app).status, "running");
  await app.deliver(replyReport(now + 10_000, now + 8_000, "A"));
  assert.equal(currentTask(app).pending, false);
  assert.equal(app.notices.size, 0);
});

test("P1 a replayed notification for an already read version is not a normal row visit", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  const revision = exactRevision(app);
  await app.send({ kind: "tp.check", id, revision, checked: true });
  assert.equal(currentTask(app).pending, false);
  const opened = await app.send({ kind: "tp.open", id, revision, intent: "notice" });
  assert.equal(opened.ok, true);
  await app.deliver(replyReport(now + 15_000, now + 10_000, "B"));
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 1);
});

test("P1 notification closure during a pending permission check suppresses duplicate creation", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  await app.deliver(replyReport(now + 5_000, update, "A"));
  const ticket = "tp-reply:" + exactRevision(app);
  let release, waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  app.chrome.notifications.getPermissionLevel = async () => {
    waiting = true;
    await gate;
    return "granted";
  };
  const reportPromise = app.deliver(replyReport(now + 10_000, update, "A"));
  await until(() => waiting);
  app.chrome.notifications.onClosed.listeners[0](ticket, true);
  release();
  await reportPromise;
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 0);
  assert.deepEqual(app.local.data[web.keys.state].outbox, {});
});

test("P1 exact durable jump commit permits normal foreground reading after interrupted guard cleanup", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  const rev = exactRevision(app);
  // Persisted acknowledgement and token, but the session guard was not removed.
  const saved = structuredClone(app.local.data);
  saved[web.keys.state].tasks[id] = { ...rules.acknowledge(currentTask(app)), jumpCommit: "exact-commit" };
  const resumed = worker({ local: saved, session: {
    "tp-web-jump-tabs-v1": { "7": { cid: id, revision: rev, token: "exact-commit", at: now + 5_000 } }
  } });
  resumed.tabs[0].url = web.conversationUrl(id, agent);
  await resumed.deliver(replyReport(now + 15_000, now + 10_000, "B"));
  assert.equal(currentTask(resumed).pending, false);
  assert.equal(resumed.notices.size, 0);
});

test("P1 collector retains a missing active row and clears cached samples on same-token reacquisition", async () => {
  const actual = [{ ...row(old), id: "100" }];
  const trackedId = id;
  const tracked = { [trackedId]: { id: trackedId, agentId: agent, name: "old active", group: "",
    update: old, created: old, listedAt: now, runAt: old } };
  let stamp = now, interval, failQueues = false;
  const queueReads = [], reports = [], listeners = [];
  const reply = data => ({ ok: true, json: async () => ({ success: true, data }) });
  const chrome = {
    storage: { local: { get: async key => ({ [key]: { tasks: tracked } }) } },
    runtime: {
      id: "collector-test",
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async packet => {
        if (packet.kind === "tp.webstate") reports.push(packet.payload);
        return { ok: true };
      }
    }
  };
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({
    chrome, URL, console, crypto: webcrypto, AbortController, Date: Clock,
    location: new URL(web.page), document: { hidden: false, addEventListener() {} },
    setTimeout, clearTimeout, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async url => {
      if (url.pathname.endsWith("/list")) return reply({ groups: [], ungrouped: { conversations: actual } });
      const cid = url.pathname.split("/").at(-2);
      if (url.pathname.endsWith("/queue")) {
        queueReads.push(cid);
        if (failQueues) throw new Error("queue endpoint offline");
        return reply({ sessionState: cid === trackedId ? "BUSY" : "IDLE", pending: [] });
      }
      return reply({ list: [{ sender: "other", id: "u", createTime: old }] });
    }
  });
  for (const file of ["config.js", "state.js", "web-bridge.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ext, file), "utf-8"), context, { filename: file });
  }
  let page;
  listeners[0]({ kind: "tp.probe" }, {}, answer => { page = answer; });
  const role = lease => listeners[0]({ kind: "tp.role", pageId: page.pageId, lease }, {}, () => {});
  role("stable-token");
  await until(() => reports.length === 1);
  assert.ok(queueReads.includes(trackedId));
  assert.ok(reports[0].conversations.some(item => item.id === trackedId && item.retained));
  assert.ok(reports[0].queueAt[trackedId]);
  await new Promise(r => setTimeout(r, 5));
  role("");
  failQueues = true;
  stamp += 6_000;
  role("stable-token");
  await until(() => reports.length >= 2);
  assert.equal(reports.at(-1).queueAt[trackedId], undefined, "old lease queue sample was relabeled");
  assert.ok(reports.at(-1).queueErrors[trackedId]);
  role("");
});

test("P1 previously rejected old assistant ID cannot become new when its timestamp disappears", () => {
  const tracker = timeline();
  tracker.next(report(now, row()));
  const first = tracker.next(replyReport(now + 5_000, now + 1_000, "A"));
  first.state.tasks[id] = rules.acknowledge(first.task);
  tracker.restore(first.state);
  const late = tracker.next(replyReport(now + 10_000, now + 1_000, "older", { atMessage: old }));
  assert.equal(late.replies.length, 0);
  const replay = tracker.next(report(now + 15_000, row(now + 1_000), {
    message: message(now + 1_000, now + 15_000, "older")
  }));
  assert.equal(replay.replies.length, 0);
  assert.equal(replay.task.replyKey, "message.A");
});

test("P2 same-time read history retries removal of older notifications without clearing new pending C", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  const a = "tp-reply:" + exactRevision(app);
  await app.deliver(replyReport(now + 10_000, update, "B"));
  const b = "tp-reply:" + exactRevision(app);
  const clear = app.chrome.notifications.clear;
  app.chrome.notifications.clear = async key => {
    if (key === a) throw new Error("temporary old notice cleanup failure");
    return clear(key);
  };
  await app.send({ kind: "tp.check", id, revision: exactRevision(app), checked: true });
  assert.equal(app.notices.has(a), true);
  assert.equal(app.notices.has(b), false);
  app.chrome.notifications.clear = clear;
  await app.deliver(replyReport(now + 15_000, update, "C"));
  const c = "tp-reply:" + exactRevision(app);
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.has(a), false);
  assert.equal(app.notices.has(c), true);
  assert.equal(app.notices.size, 1);
});

test("P1 stale landing event snapshot cannot cancel a still-loading correct new tab", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "A"));
  const create = app.chrome.tabs.create;
  app.chrome.tabs.create = async args => {
    const tab = await create(args);
    Object.assign(tab, { url: "about:blank", pendingUrl: args.url, status: "loading" });
    return tab;
  };
  const opening = app.send({ kind: "tp.open", id, revision: exactRevision(app), intent: "notice" });
  await until(() => app.chrome.tabs.onUpdated.listeners.length >= 2);
  const tab = app.tabs[1];
  const stale = { ...tab, url: new URL("/login", web.page).href, status: "complete" };
  delete stale.pendingUrl;
  for (const listener of [...app.chrome.tabs.onUpdated.listeners]) listener(tab.id, { url: stale.url, status: "complete" }, stale);
  await new Promise(resolve => setTimeout(resolve, 10));
  tab.url = tab.pendingUrl;
  delete tab.pendingUrl;
  tab.status = "complete";
  for (const listener of [...app.chrome.tabs.onUpdated.listeners]) listener(tab.id, { url: tab.url, status: "complete" }, tab);
  assert.equal((await opening).ok, true);
  assert.equal(currentTask(app).pending, false);
  assert.equal(app.notices.size, 0);
});

test("P2 webpage toast may dismiss only after the worker authorizes clearing that notice", () => {
  assert.equal(rules.mayDismissNotice({ ok: true, clearNotice: false }), false);
  assert.equal(rules.mayDismissNotice({ ok: false, clearNotice: true }), false);
  assert.equal(rules.mayDismissNotice({ ok: true, clearNotice: true }), true);
  assert.equal(rules.mayDismissNotice(null), false);
});


/* Post-integration review: account access, source availability and stale handoff. */
test("logout hides prior titles and notices; relogin needs post-failure queue evidence", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  assert.equal(app.notices.size, 1);
  const rev = exactRevision(app);
  await app.deliver(report(now + 10_000, row(update), {
    error: "HTTP 401", listAt: now + 5_000, busy: null
  }));
  let saved = app.local.data[web.keys.state];
  assert.equal(rules.view(saved, now + 10_000).tasks.length, 0);
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 0);
  const count = app.tabs.length;
  assert.equal((await app.send({ kind: "tp.open", id, revision: rev, intent: "notice" })).ok, false);
  assert.equal(app.tabs.length, count);
  // The old queue timestamp must not confirm a reply in the recovered list.
  app.tabs[0].url = web.conversationUrl(id, agent);
  await app.deliver(report(now + 15_000, row(update), { queueAt: now + 5_000 }));
  assert.equal(currentTask(app).pending, true);
  assert.equal(rules.view(app.local.data[web.keys.state], now + 15_000).counts.attention, 0);
  await app.deliver(report(now + 20_000, row(update)));
  assert.equal(currentTask(app).pending, false);
  assert.equal(app.notices.size, 0);
});

test("account switch: absent old task is hidden until freshly authorized, denied ID stops retention", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  const oldRevision = exactRevision(app), newId = "43";
  const oldRow = { ...row(update), retained: true };
  const accountB = (at, opts = {}) => {
    const p = report(at, oldRow, opts);
    p.conversations.unshift({ ...row(at - 1_000), id: newId, name: "second account" });
    p.queues[newId] = { sessionState: "IDLE", pending: [] };
    p.queueAt[newId] = at;
    return p;
  };
  await app.deliver(accountB(now + 10_000, { queueAt: now + 5_000 }));
  let state = app.local.data[web.keys.state];
  assert.ok(!rules.view(state, now + 10_000).tasks.some(t => t.id === id));
  assert.equal(app.notices.size, 0);
  await app.deliver(accountB(now + 15_000, { busy: null, queueError: true, accessError: true }));
  state = app.local.data[web.keys.state];
  assert.ok(!rules.view(state, now + 15_000).tasks.some(t => t.id === id));
  assert.ok(!rules.reportRows([{ ...row(), id: newId }], state.tasks, now + 15_000).some(t => t.id === id));
  assert.equal((await app.send({ kind: "tp.open", id, revision: oldRevision, intent: "notice" })).ok, false);
  // Switching back to a real list and obtaining a new queue sample is safe.
  await app.deliver(report(now + 20_000, row(update)));
  state = app.local.data[web.keys.state];
  assert.equal(rules.view(state, now + 20_000).counts.attention, 1);
  assert.equal(currentTask(app).pending, true);
  assert.equal(app.notices.size, 0); // already delivered before the switch
});

test("a late report from a collector that left DataAgent cannot update state", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.tabs[0].url = "https://example.com/";
  const answer = await app.deliver(replyReport(now + 5_000, now + 1_000, "late"));
  assert.equal(answer.ok, false);
  assert.equal(currentTask(app).pending, undefined);
  assert.equal(app.notices.size, 0);
});

test("closing the last ready collector pauses delayed delivery before the stale timeout", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  await app.deliver(replyReport(now + 5_000, update, "A"));
  assert.equal(Object.keys(app.local.data[web.keys.state].outbox).length, 1);
  app.chrome.notifications.getPermissionLevel = async () => "granted";
  app.tabs.splice(0, app.tabs.length);
  app.setClock(now + 6_000);
  app.chrome.alarms.onAlarm.listeners[0]({ name: "tp-web-sync" });
  await until(() => !app.session.data[web.keys.leader]);
  await new Promise(r => setTimeout(r, 25));
  const state = app.local.data[web.keys.state];
  assert.equal(rules.view(state, now + 6_000).stale, true);
  assert.equal(state.tasks[id].pending, true);
  assert.equal(app.notices.size, 0);
  assert.equal(Object.keys(state.outbox).length, 1);
});

test("a responsive but stale hidden leader yields to a ready foreground DataAgent tab", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  app.tabs[0].active = false;
  const other = { id: 9, windowId: 1, url: web.page, active: true, status: "complete" };
  app.tabs.push(other);
  const rolePackets = [];
  app.chrome.tabs.sendMessage = async (tabId, packet) => {
    if (packet.kind === "tp.probe") return { pageId: tabId === 7 ? "page" : "other-page", lease: tabId === 7 ? "one" : "" };
    if (packet.kind === "tp.role") {
      rolePackets.push({ tabId, lease: packet.lease });
      return { pageId: packet.pageId };
    }
    return { pageId: packet.pageId };
  };
  app.setClock(now + web.timing.sourceStale + 1);
  app.chrome.alarms.onAlarm.listeners[0]({ name: "tp-web-sync" });
  await until(() => app.session.data[web.keys.leader]?.tabId === 9, "stalled collector was kept");
  await until(() => rolePackets.some(p => p.tabId === 9 && p.lease));
  assert.ok(rolePackets.some(p => p.tabId === 7 && p.lease === ""));
  assert.equal((await app.deliver(report(now + web.timing.sourceStale + 2, row()), "one")).ok, false);
});


test("collector propagates actual HTTP denial for an absent retained row and stops polling it", async () => {
  const tracker = timeline();
  const active = tracker.next(report(now, row(), { busy: true }));
  let durable = active.state, stamp = now + 10_000, interval;
  const requests = [], reports = [], listeners = [];
  const currentId = "100";
  const reply = data => ({ ok: true, json: async () => ({ success: true, data }) });
  const chrome = {
    storage: { local: { get: async key => ({ [key]: durable }) } },
    runtime: { id: "collector-test", onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async packet => {
        if (packet.kind === "tp.webstate") {
          reports.push(packet.payload);
          durable = rules.absorb(durable, packet.payload, stamp).state;
        }
        return { ok: true };
      }
    }
  };
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({
    chrome, URL, console, crypto: webcrypto, AbortController, Date: Clock,
    location: new URL(web.page), document: { hidden: false, addEventListener() {} },
    setTimeout, clearTimeout, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async url => {
      requests.push(url.pathname);
      if (url.pathname.endsWith("/list")) return reply({ groups: [], ungrouped: {
        conversations: [{ ...row(old), id: currentId }]
      } });
      const cid = url.pathname.split("/").at(-2);
      if (cid === id) return { ok: false, status: 403 };
      if (url.pathname.endsWith("/queue")) return reply({ sessionState: "IDLE", pending: [] });
      return reply({ list: [{ sender: "other", id: "u", createTime: old }] });
    }
  });
  for (const file of ["config.js", "state.js", "web-bridge.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ext, file), "utf-8"), context, { filename: file });
  }
  let page;
  listeners[0]({ kind: "tp.probe" }, {}, answer => { page = answer; });
  const role = lease => listeners[0]({ kind: "tp.role", pageId: page.pageId, lease }, {}, () => {});
  const oldReads = () => requests.filter(p => p.includes("/" + id + "/")).length;
  role("account-b");
  await until(() => reports.length === 1);
  assert.equal(reports[0].accessErrors[id], stamp);
  assert.ok(durable.tasks[id].accessDeniedAt);
  assert.equal(oldReads(), 1);
  await new Promise(r => setTimeout(r, 5));
  stamp += web.timing.idle + web.timing.list;
  interval();
  await until(() => reports.length >= 2);
  assert.equal(oldReads(), 1, "denied absent task was repeatedly queried");
  assert.ok(!reports.at(-1).conversations.some(item => item.id === id));
  role("");
});

test("idle report does not perform foreground-only browser queries when no reply is eligible", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  let windowReads = 0, tabQueries = 0, tabReads = 0;
  const w = app.chrome.windows.getLastFocused, q = app.chrome.tabs.query, g = app.chrome.tabs.get;
  app.chrome.windows.getLastFocused = async (...args) => { windowReads++; return w(...args); };
  app.chrome.tabs.query = async (...args) => { tabQueries++; return q(...args); };
  app.chrome.tabs.get = async (...args) => { tabReads++; return g(...args); };
  await app.deliver(report(now + 5_000, row()));
  assert.deepEqual({ windowReads, tabQueries, tabReads }, { windowReads: 0, tabQueries: 0, tabReads: 1 });
});

test("group mode resolves real tab groups, duplicate tabs, unopened rows and wrong agent IDs", () => {
  const tabs = [
    { id: 3, groupId: 8, url: web.conversationUrl(id, agent), active: false },
    { id: 2, groupId: -1, url: web.conversationUrl(id, agent), active: true },
    { id: 4, groupId: 9, url: web.conversationUrl("43", agent) },
    { id: 5, groupId: 8, url: "https://example.com/" }
  ];
  const mapping = ui.buildGroups(tabs, [{ id: 8, title: "项目 A", color: "blue" },
    { id: 9, title: "项目 A", color: "green" }], web);
  assert.equal(Object.keys(mapping).length, 2);
  const task = { id, agentId: agent, group: "数据质量" };
  assert.equal(ui.groupFor(task, "dataagent", mapping).name, "数据质量");
  assert.equal(ui.groupFor(task, "tab", mapping).key, "tab:8");
  assert.equal(ui.groupFor(task, "tab", mapping).color, "#78a6db");
  assert.equal(ui.groupFor({ ...task, id: "43" }, "tab", mapping).key, "tab:9");
  assert.equal(ui.groupFor({ ...task, id: "44" }, "tab", mapping).name, "未打开 · 数据质量");
  assert.equal(ui.groupFor({ ...task, agentId: "2528" }, "tab", mapping).key, "closed:数据质量");
});

test("drag position preserves original default and clamps across viewport and panel sizes", () => {
  assert.deepEqual(ui.place(undefined, 1400, 880, 44, 84), { left: 1356, top: 22 });
  assert.deepEqual(ui.place(undefined, 1400, 880, 240, 200), { left: 1160, top: 22 });
  const position = ui.move(undefined, -200, 100, 1400, 880);
  const moved = ui.glassLayout(position, 1400, 880);
  assert.deepEqual({ left: moved.left, top: moved.top }, { left: 1172, top: 122 });
  const small = ui.place(position, 320, 240, 240, 200);
  assert.ok(small.left >= 0 && small.left <= 80 && small.top >= 0 && small.top <= 40);
  assert.deepEqual(ui.move(undefined, 1e6, -1e6, 1400, 880), { x: 1, y: 0, edge: "top" });
});

test("global presentation is opt-in; external frame needs same-tab opaque registration", async () => {
  const app = worker();
  const ordinary = { id: 9, windowId: 1, active: true, status: "complete", url: "https://example.com/work" };
  app.tabs.push(ordinary);
  app.chrome.permissions = { contains: async () => true };
  const sender = { id: "unit", tab: ordinary, frameId: 0, url: ordinary.url };
  const frame = { id: "unit", tab: ordinary, frameId: 4, url: "surface.html" };
  assert.equal((await app.send({ kind: "tp.surface.register" }, sender)).ok, false);
  app.local.data[ui.keys.enabled] = true;
  const registered = await app.send({ kind: "tp.surface.register" }, sender);
  assert.ok(registered.ok && registered.token);
  assert.equal((await app.send({ kind: "tp.surface.attach", token: "bad" }, frame)).ok, false);
  assert.equal((await app.send({ kind: "tp.surface.attach", token: registered.token }, frame)).ok, true);
  assert.equal((await app.send({ kind: "tp.surface.attach", token: registered.token }, { ...frame, frameId: 0 })).ok, false);
  assert.equal((await app.send({ kind: "tp.surface.attach", token: registered.token }, { ...frame, tab: app.tabs[0] })).ok, false);
  app.chrome.permissions.contains = async () => false;
  assert.equal((await app.send({ kind: "tp.surface.attach", token: registered.token }, frame)).ok, false);
});

test("cross-page toast routing sends no task titles to the webpage host and revalidates the isolated frame", async () => {
  const app = worker();
  app.local.data[ui.keys.enabled] = true;
  app.chrome.permissions = { contains: async () => true };
  const ordinary = { id: 9, windowId: 1, active: true, status: "complete", url: "https://example.com/work" };
  app.tabs[0].active = false;
  app.tabs.push(ordinary);
  const messages = [];
  app.chrome.tabs.sendMessage = async (tabId, packet) => {
    if (tabId === 9) { messages.push(packet); return { ok: true }; }
    return null;
  };
  const sender = { id: "unit", tab: ordinary, frameId: 0, url: ordinary.url };
  const registered = await app.send({ kind: "tp.surface.register" }, sender);
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, now + 1_000, "external-reply"));
  assert.ok(messages.some(p => p.kind === "tp.surface-notice"));
  assert.ok(!JSON.stringify(messages).includes(row().name));
  const frame = { id: "unit", tab: ordinary, frameId: 4, url: "surface.html" };
  const result = await app.send({ kind: "tp.surface.toasts", token: registered.token }, frame);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, row().name);
  const bad = await app.send({ kind: "tp.surface.toasts", token: "wrong" }, frame);
  assert.equal(bad.ok, false);
  await app.send({ kind: "tp.check", id, revision: exactRevision(app), checked: true });
  assert.equal((await app.send({ kind: "tp.surface.toasts", token: registered.token }, frame)).tasks.length, 0);
});

async function latencyScenario({ idle = false, many = false } = {}) {
  let durable = rules.blank(), stamp = now, interval, queue = idle ? "IDLE" : "BUSY";
  const reports = [], requests = [], listeners = [], replies = [];
  const rows = Array.from({ length: many ? 24 : 1 }, (_, index) => ({ ...row(old - index - 1), id: String(42 + index) }));
  const first = rows[0], readyAt = now + 6_000;
  const success = data => ({ ok: true, json: async () => ({ success: true, data }) });
  const chrome = {
    storage: { local: { get: async key => ({ [key]: durable }) } },
    runtime: { id: "collector-clock", onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async packet => {
        if (packet.kind === "tp.webstate") {
          reports.push(packet.payload);
          const result = rules.absorb(durable, packet.payload, stamp);
          durable = result.state; replies.push(...result.replies.map(task => ({ at: stamp, revision: rules.revision(task) })));
        }
        return { ok: true };
      }
    }
  };
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({
    chrome, URL, console, crypto: webcrypto, AbortController, Date: Clock,
    location: new URL(web.page), document: { hidden: false, addEventListener() {} },
    setTimeout, clearTimeout, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async url => {
      requests.push({ at: stamp, path: url.pathname });
      if (url.pathname.endsWith("/list")) return success({ groups: [], ungrouped: { conversations: rows } });
      const cid = url.pathname.split("/").at(-2);
      if (url.pathname.endsWith("/queue")) return success({ sessionState: cid === id ? queue : "IDLE", pending: [] });
      const fresh = !idle && cid === id && stamp >= readyAt;
      return success({ list: [{ sender: "assistant", id: fresh ? "new" : "old-" + cid,
        createTime: fresh ? readyAt : old - 1000 }] });
    }
  });
  for (const file of ["config.js", "state.js", "web-bridge.js"])
    vm.runInContext(fs.readFileSync(path.join(ext, file), "utf-8"), context, { filename: file });
  let page;
  listeners[0]({ kind: "tp.probe" }, {}, answer => { page = answer; });
  const role = lease => listeners[0]({ kind: "tp.role", pageId: page.pageId, lease }, {}, () => {});
  role("clock");
  await until(() => reports.length >= 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  for (let second = 1; second <= (idle ? 65 : 40); second++) {
    stamp = now + second * 1_000;
    if (!idle && second >= 2) queue = "IDLE";
    await interval();
  }
  role("");
  return { readyAt, replies, requests, reports, durable };
}

test("fast completion retries a stale assistant without waiting 30 seconds", async () => {
  const result = await latencyScenario();
  assert.equal(result.replies.length, 1);
  assert.ok(result.replies[0].at - result.readyAt <= 3_000, "reply latency: " + (result.replies[0].at - result.readyAt));
  assert.equal(result.durable.tasks[id].pending, true);
});

test("cold historical rows remain low-frequency and request bursts are bounded", async () => {
  const result = await latencyScenario({ idle: true, many: true });
  const list = result.requests.filter(r => r.path.endsWith("/list"));
  assert.ok(list.length <= 3, "idle list request count: " + list.length);
  const checks = result.requests.filter(r => r.path.endsWith("/queue") && r.path.includes("/42/"));
  assert.ok(checks.length <= 2, "cold queue request count: " + checks.length);
  for (const request of result.requests) {
    const count = result.requests.filter(r => r.at > request.at - 2_000 && r.at <= request.at).length;
    assert.ok(count <= 12, "request budget exceeded: " + count);
  }
});


test("hidden active collector is nudged without a second lease and stops waking after reply", async () => {
  let serial = 0;
  const timers = new Map();
  const app = worker({
    setTimeout: (fn, delay, ...args) => {
      if (delay !== web.timing.hot) return setTimeout(fn, delay, ...args);
      const key = "fast-" + ++serial;
      timers.set(key, () => fn(...args));
      return key;
    },
    clearTimeout: key => {
      if (typeof key === "string" && key.startsWith("fast-")) timers.delete(key);
      else clearTimeout(key);
    }
  });
  const packets = [];
  app.chrome.tabs.sendMessage = async (tabId, packet) => {
    packets.push({ tabId, ...packet });
    if (packet.kind === "tp.nudge") return { pageId: "page" };
    return null;
  };
  await app.deliver({ ...report(now, row(), { busy: true }), hidden: false });
  assert.equal(timers.size, 0);
  const hidden = { kind: "tp.visibility", pageId: "page", lease: "one", hidden: true };
  assert.equal((await app.send(hidden)).ok, true);
  assert.equal(timers.size, 1);
  const [key, callback] = [...timers.entries()][0];
  timers.delete(key);
  app.setClock(now + web.timing.hot);
  await callback();
  assert.ok(packets.some(p => p.tabId === 7 && p.kind === "tp.nudge" && p.pageId === "page"));
  assert.equal(app.session.data[web.keys.leader].lease, "one");
  assert.equal(timers.size, 1);
  await app.deliver({ ...replyReport(now + 5_000, now + 4_000, "finished"), hidden: true });
  assert.equal(currentTask(app).pending, true);
  assert.equal(timers.size, 0);
});

test("top and side pills are exact rotations; expansion replaces the capsule with one rounded panel", () => {
  const side = ui.glassLayout(undefined, 1400, 880);
  assert.deepEqual(ui.pill, { long: 96, short: 28 });
  assert.deepEqual(side.capsule, { left: 0, top: 0, width: 28, height: 96 });
  const top = ui.move(undefined, -600, -90, 1400, 880);
  const a = ui.glassLayout(top, 1400, 880);
  assert.equal(a.horizontal, true);
  assert.equal(a.top, 8);
  assert.deepEqual(a.capsule, { left: 0, top: 0, width: side.capsule.height, height: side.capsule.width });
  const b = ui.glassLayout(top, 1400, 880, true, 220);
  assert.equal(b.capsule, null);
  assert.deepEqual(b.panel, { left: 0, top: 0, width: 240, height: 220 });
  assert.equal(b.top, a.top);
  assert.ok(b.left <= a.left && b.left + b.width >= a.left + a.width);
  assert.ok(ui.glassClip(b).includes("A12 12 0 0 1"));
  assert.ok(!ui.glassClip(b).includes("A14 14 0 0 1"));
  assert.ok(ui.glassClip(a).includes("A14 14 0 0 1"));
  assert.ok(ui.glassClip(side).includes("A14 14 0 0 1"));
  const back = ui.move(top, 400, 240, 1400, 880);
  const c = ui.glassLayout(back, 1400, 880);
  assert.equal(c.horizontal, false);
  assert.equal(c.width, 28);
  assert.equal(c.height, 96);
  const panel = ui.glassLayout(back, 1400, 880, true, 60);
  assert.equal(panel.capsule, null);
  assert.ok(panel.left <= c.left && panel.left + panel.width >= c.left + c.width);
  assert.ok(panel.top <= c.top && panel.top + panel.height >= c.top + c.height);
  const clamped = ui.glassLayout(top, 320, 180, true, 1000);
  assert.ok(clamped.left >= 0 && clamped.top >= 0 && clamped.left + clamped.width <= 320 && clamped.top + clamped.height <= 180);
  assert.deepEqual(ui.glassLayout(top, 1400, 880), a);
});

test("surface geometry uses content viewport without classic scrollbars", () => {
  const win = { innerWidth: 1400, innerHeight: 880, document: {
    compatMode: "CSS1Compat", documentElement: { clientWidth: 1380, clientHeight: 862 }
  } };
  const v = ui.viewportSize(win);
  assert.deepEqual(v, { width: 1380, height: 862 });
  const right = ui.glassLayout({ x: 1, y: 1 }, v.width, v.height);
  assert.deepEqual({ left: right.left, top: right.top, width: right.width, height: right.height },
    { left: 1352, top: 766, width: 28, height: 96 });
  const top = ui.glassLayout({ x: 1, y: 0, edge: "top" }, v.width, v.height);
  assert.equal(top.left + top.width, 1380);
  const panel = ui.glassLayout({ x: 1, y: 1 }, v.width, v.height, true, 350);
  assert.equal(panel.left + panel.width, 1380);
  assert.equal(panel.top + panel.height, 862);
  win.document.compatMode = "BackCompat";
  win.document.body = { clientWidth: 1376, clientHeight: 860 };
  assert.deepEqual(ui.viewportSize(win), { width: 1376, height: 860 });
});

test("new-tab completion retries the real document after early activation and transient injection failure", async () => {
  const app = worker();
  app.local.data[ui.keys.enabled] = true;
  app.chrome.permissions = { contains: async () => true };
  app.tabs[0].active = false;
  const tab = { id: 9, windowId: 1, url: "chrome://newtab/", status: "loading", active: true };
  app.tabs.push(tab);
  let attempts = 0, probes = 0, installed = false;
  app.chrome.scripting = { executeScript: async ({ target }) => {
    assert.equal(target.tabId, tab.id);
    if (++attempts === 1) throw new Error("transient injection rejection");
    installed = true;
  } };
  app.chrome.tabs.sendMessage = async (tabId, msg) => {
    if (tabId === tab.id && msg.kind === "tp.surface-probe") {
      probes++;
      return installed ? { ok: false, installed: true } : null;
    }
    return null;
  };
  app.chrome.tabs.onActivated.listeners[0]({ tabId: tab.id, windowId: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 0);
  tab.url = "https://example.com/work";
  tab.status = "complete";
  app.chrome.tabs.onUpdated.listeners[0](tab.id, { status: "complete" }, tab);
  for (let i = 0; i < 100 && !installed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, 2);
  assert.ok(installed);
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = probes;
  app.chrome.tabs.onActivated.listeners[0]({ tabId: tab.id, windowId: 1 });
  for (let i = 0; i < 50 && probes === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(probes > before);
  assert.equal(attempts, 2, "installed but not ready host handles its own recovery");
});


test("uncertain row can be dismissed without false read evidence; same version stays hidden across refresh and restart", async () => {
  const app = worker();
  await app.deliver(report(now, row()));
  const update = now + 1_000;
  await app.deliver(report(now + 5_000, row(update), { messageError: true }));
  const before = structuredClone(currentTask(app));
  assert.equal(rules.view(app.local.data[web.keys.state], now + 5_000).tasks[0].uncertain, true);
  assert.equal((await app.send({ kind: "tp.dismiss", id, version: rules.displayVersion(before) })).ok, true);
  const hidden = currentTask(app);
  assert.equal(hidden.acked, before.acked);
  assert.equal(hidden.pending, before.pending);
  assert.equal(hidden.readRevision, before.readRevision);
  assert.equal(hidden.messageUncertain, true);
  assert.equal(rules.view(app.local.data[web.keys.state], now + 5_000).tasks.length, 0);
  const restarted = worker({ local: app.local.data, session: app.session.data });
  await restarted.deliver(report(now + 10_000, row(update), { messageError: true }));
  assert.equal(rules.view(restarted.local.data[web.keys.state], now + 10_000).tasks.length, 0);
  await restarted.deliver(replyReport(now + 15_000, update, "new-after-dismiss"));
  assert.equal(rules.view(restarted.local.data[web.keys.state], now + 15_000).tasks.length, 1);
  assert.equal(currentTask(restarted).pending, true);
  assert.equal(restarted.notices.size, 1);
});

test("checked verified reply disappears from counts, rows and notices; new run at same list timestamp returns", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  await app.deliver(replyReport(now + 5_000, update, "A"));
  const version = rules.displayVersion(currentTask(app));
  assert.equal(app.notices.size, 1);
  assert.equal((await app.send({ kind: "tp.dismiss", id, version })).ok, true);
  assert.equal(currentTask(app).pending, false);
  assert.equal(app.notices.size, 0);
  assert.equal(rules.view(app.local.data[web.keys.state], now + 5_000).tasks.length, 0);
  await app.deliver(replyReport(now + 10_000, update, "A"));
  assert.equal(rules.view(app.local.data[web.keys.state], now + 10_000).tasks.length, 0);
  await app.deliver(report(now + 15_000, row(update), { busy: true }));
  assert.equal(rules.view(app.local.data[web.keys.state], now + 15_000).counts.running, 1);
  assert.equal((await app.send({ kind: "tp.dismiss", id, version })).ok, false, "old checkbox cannot dismiss a new run");
  assert.equal((await app.send({ kind: "tp.dismiss", id, version: rules.displayVersion(currentTask(app)) })).ok, false, "known running task cannot be marked handled");
  await app.deliver(replyReport(now + 20_000, update, "B", { atMessage: now + 18_000 }));
  assert.equal(rules.view(app.local.data[web.keys.state], now + 20_000).counts.attention, 1);
  assert.equal(app.notices.size, 1);
});

test("a dismissed uncertain pending reply cancels delayed delivery without marking it read", async () => {
  const app = worker(), update = now + 1_000;
  await app.deliver(report(now, row()));
  app.chrome.notifications.getPermissionLevel = async () => "denied";
  await app.deliver(replyReport(now + 5_000, update, "A"));
  assert.equal(Object.keys(app.local.data[web.keys.state].outbox).length, 1);
  await app.deliver(report(now + 10_000, row(update), { busy: null, queueError: true }));
  const before = currentTask(app);
  assert.equal((await app.send({ kind: "tp.dismiss", id, version: rules.displayVersion(before) })).ok, true);
  assert.equal(currentTask(app).pending, true);
  assert.equal(currentTask(app).acked, before.acked);
  assert.deepEqual(app.local.data[web.keys.state].outbox, {});
  app.chrome.notifications.getPermissionLevel = async () => "granted";
  await app.deliver(replyReport(now + 15_000, update, "A"));
  assert.equal(app.notices.size, 0);
  assert.equal(rules.view(app.local.data[web.keys.state], now + 15_000).tasks.length, 0);
});

test("48-hour display window uses activity rather than polling; older tasks remain in collector tracking", () => {
  const tracker = timeline();
  const age = 48 * 60 * 60_000;
  const older = now - age - 1, edge = now - age;
  const oldRow = { ...row(older, older), id: "43" };
  const edgeRow = { ...row(edge, edge), id: "44" };
  const packet = report(now, row());
  packet.conversations.push(oldRow, edgeRow);
  const initial = tracker.next(packet);
  assert.deepEqual(rules.view(initial.state, now).tasks.map(t => t.id).sort(), ["42", "44"]);
  const oldTask = initial.state.tasks["43"];
  assert.ok(oldTask, "visibility filtering must not delete durable state");
  assert.ok(rules.watchRows(Array.from({length: 24}, (_, i) => ({ ...row(), id: String(100 + i) })).concat(oldRow),
    new Map(), { "43": { ...oldTask, pending: true } }, now).some(r => r.id === "43"));
  const later = tracker.next({ ...packet, at: now + 1, listAt: now + 1, queueAt: { [id]: now + 1, "43": now + 1, "44": now + 1 },
    queues: { [id]: { sessionState: "IDLE", pending: [] }, "43": { sessionState: "IDLE", pending: [] }, "44": { sessionState: "IDLE", pending: [] } } });
  assert.deepEqual(rules.view(later.state, now + 1).tasks.map(t => t.id), ["42"]);
  const renewed = tracker.next({ ...packet, at: now + 5_000, listAt: now + 5_000,
    conversations: [row(), { ...oldRow, updateTime: now + 3_000 }, edgeRow] });
  assert.ok(rules.view(renewed.state, now + 5_000).tasks.some(t => t.id === "43"));
});


test("historical user-message backfill never reopens a dismissed conversation, including missing timestamps", async () => {
  const app = worker();
  const update = now - 1_000;
  await app.deliver(report(now, row(update), { busy: null, queueError: true }));
  const original = currentTask(app);
  const version = rules.displayVersion(original);
  assert.equal((await app.send({ kind: "tp.dismiss", id, version })).ok, true);
  const saved = structuredClone(app.local.data);
  assert.equal(currentTask(app).dismissedAt, now);
  const restarted = worker({ local: saved, session: app.session.data });
  for (const [delta, userId, atMessage] of [
    [5_000, "historical-user", update],
    [10_000, "historical-undated-user", 0],
    [15_000, "historical-late-list", now - 1],
    [20_000, "historical-late-list", now - 1]
  ]) {
    const at = now + delta;
    await restarted.deliver(report(at, row(update), {
      message: message(update, at, userId, { sender: "other", atMessage })
    }));
    const task = currentTask(restarted);
    assert.equal(task.lastUserMessage, userId, "collector watermark is still recorded");
    assert.equal(rules.displayVersion(task), version, "backfill is not activity");
    assert.equal(task.acked, original.acked);
    assert.equal(task.readRevision, original.readRevision);
    assert.equal(rules.view(restarted.local.data[web.keys.state], at).tasks.length, 0);
    assert.equal(restarted.notices.size, 0);
  }

  const at = now + 25_000;
  const userAt = now + 22_000;
  await restarted.deliver(report(at, row(update), {
    message: message(update, at, "new-user", { sender: "other", atMessage: userAt })
  }));
  assert.equal(currentTask(restarted).userActivityAt, userAt);
  assert.equal(rules.view(restarted.local.data[web.keys.state], at).tasks.length, 1);
  assert.equal((await restarted.send({ kind: "tp.dismiss", id, version })).ok, false,
    "old display ticket must not remove a newly evidenced activity");
  assert.equal((await restarted.send({ kind: "tp.dismiss", id, version: rules.displayVersion(currentTask(restarted)) })).ok, true);
  await restarted.deliver(report(now + 30_000, row(update), {
    message: message(update, now + 30_000, "new-user", { sender: "other", atMessage: userAt })
  }));
  assert.equal(rules.view(restarted.local.data[web.keys.state], now + 30_000).tasks.length, 0);
  await restarted.deliver(report(now + 35_000, row(now + 32_000)));
  assert.equal(rules.view(restarted.local.data[web.keys.state], now + 35_000).tasks.length, 1,
    "new list activity must still reopen even without a timestamped message");
});

test("legacy dismissal ticket is preserved when its only change is a hydrated user watermark", () => {
  const task = {
    id, agentId: agent, created: old, update: old, status: "seen",
    dismissedVersion: JSON.stringify([id, agent, old, old, "", 0, ""]),
    lastUserMessage: "historical"
  };
  assert.equal(rules.isDismissed(task), true);
  assert.equal(rules.isDismissed({ ...task, userActivityAt: now }), false);
  assert.equal(rules.isDismissed({ ...task, runCycleAt: now }), false);
  assert.equal(rules.isDismissed({ ...task, replyKey: "message.new" }), false);
  assert.equal(rules.isDismissed({ ...task, update: now }), false);
});
