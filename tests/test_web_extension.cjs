const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

require("../taskpulse-ext/config.js");
require("../taskpulse-ext/state.js");
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
    store.get = async key => ({ [key]: structuredClone(store.data[key]) });
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
      onClicked: event(), getPermissionLevel: async () => "granted",
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
      create: async ({ url }) => {
        for (const tab of tabs) tab.active = false;
        const created = { id: tabs.length + 100, windowId: 1, url, status: "complete", active: true };
        tabs.push(created);
        return created;
      },
      update: async tabId => {
        for (const tab of tabs) tab.active = tab.id === tabId;
        return structuredClone(tabs.find(tab => tab.id === tabId));
      }
    },
    alarms: { onAlarm: event() }
  };
  chrome.windows.onFocusChanged = event();
  let stamp = now;
  class Clock extends Date { static now() { return stamp; } }
  const context = vm.createContext({ chrome, URL, console, crypto: webcrypto, setTimeout, clearTimeout, Date: Clock });
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
  return { tabs, sender, send, deliver, notices, local, session, chrome };
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
  app.chrome.tabs.update = async () => { throw new Error("second focus failed"); };
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
