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

test("回复接口比列表先返回新消息时，列表补齐后仍能通知", () => {
  const { next } = timeline();
  next(report(now, row(), { busy: true }));
  const updated = now + 4_000;
  const early = next(report(now + 6_000, row(), {
    message: message(old, now + 6_000, "reply", { atMessage: updated })
  }));
  assert.equal(early.task.status, "running");
  assert.equal(early.replies.length, 0);
  const complete = next(report(now + 30_000, row(updated), {
    message: message(updated, now + 30_000, "reply", { atMessage: updated })
  }));
  assert.equal(complete.task.status, "attention");
  assert.equal(complete.replies.length, 1);
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

function worker() {
  const event = () => {
    const listeners = [];
    return { addListener: fn => listeners.push(fn), listeners };
  };
  const local = { data: {} }, session = { data: {} };
  for (const store of [local, session]) {
    store.get = async key => ({ [key]: structuredClone(store.data[key]) });
    store.set = async data => Object.assign(store.data, structuredClone(data));
    store.remove = async key => { delete store.data[key]; };
  }
  const notices = new Map();
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
      clear: async key => notices.delete(key)
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
        const created = { id: tabs.length + 100, windowId: 1, url };
        tabs.push(created);
        return created;
      },
      update: async tabId => structuredClone(tabs.find(tab => tab.id === tabId))
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
  return { tabs, sender, send, deliver, notices, local, chrome };
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
  app.tabs.push({ id: 9, windowId: 1, url: web.conversationUrl(id, agent) });
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
  assert.equal(app.notices.size, 2);
});
