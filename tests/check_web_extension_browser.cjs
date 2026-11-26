const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ext = path.resolve(__dirname, "../taskpulse-ext");
const production = "https://dataagent.corp.kuaishou.com";
const seed = Date.now() - 120_000;
const task = { id: 11, agentId: 515, name: "验证 Spark 分区更新" };
const unopened = { id: 12, agentId: 515, name: "订单链路字段核查" };
const root = "#taskpulse-web-capsule";
const stateKey = "tp-web-state-v1";
const leaderKey = "tp-web-leader-v1";

async function startFixture() {
  const requests = [];
  let updated = seed, working = true, lastReply = seed, pendingReply = seed, replyReadyAt = 0;
  let account = "a";
  const alternate = { id: 21, agentId: 515, name: "合成账号 B 的会话" };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/workbench") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="utf-8"><title>Ordinary website fixture</title><button id="underlying" onclick="this.textContent=\'clicked\'">Underlying page</button>');
      return;
    }
    if (url.pathname === "/ai/data-agent") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "style-src 'self'; connect-src 'self'"
      });
      response.end('<!doctype html><meta charset="utf-8"><title>DataAgent fixture</title><h1>会话验收</h1>');
      return;
    }
    if (!url.pathname.startsWith("/rest/flow/api/v1/conversations/")) {
      response.writeHead(404).end();
      return;
    }
    requests.push({ path: url.pathname, from: request.headers.referer || "" });
    if (account === "logout" ||
        account === "b" && !url.pathname.endsWith("/list") && !url.pathname.includes("/21/")) {
      response.writeHead(account === "logout" ? 401 : 403).end();
      return;
    }
    let data;
    if (url.pathname.endsWith("/list") && account === "b") {
      data = { groups: [{ name: "账号 B", conversations: [
        { ...alternate, updateTime: seed, createTime: seed }
      ] }], ungrouped: { conversations: [] } };
    } else if (url.pathname.endsWith("/list")) {
      data = { groups: [{ name: "数据质量", conversations: [
        { ...task, updateTime: updated, createTime: seed },
        { ...unopened, updateTime: seed, createTime: seed }
      ] }], ungrouped: { conversations: [] } };
    } else if (url.pathname.endsWith("/queue")) {
      data = { sessionState: url.pathname.includes("/11/") && working ? "BUSY" : "IDLE", pending: [] };
    } else if (url.pathname.endsWith("/messages")) {
      if (Date.now() >= replyReadyAt) lastReply = pendingReply;
      const stamp = url.pathname.includes("/11/") ? lastReply : seed;
      data = { list: [{ sender: "assistant", id: "m" + stamp, createTime: stamp, content: "Synthetic private reply" }] };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, data }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server, requests, origin: "http://127.0.0.1:" + server.address().port,
    releaseReply: (lag = 0) => {
      working = false; updated = Date.now() + 1;
      pendingReply = updated; replyReadyAt = Date.now() + lag; return updated;
    },
    startRun: () => { working = true; updated = Date.now() + 1; return updated; },
    setAccount: value => { account = value; }
  };
}

// Initial navigation from chrome.tabs.create can start before a Playwright route
// attaches to the new tab. Serve the entire fixture as an actual local site.
async function installFixtureCopy(dir, origin) {
  const destination = path.join(dir, "extension");
  await fs.cp(ext, destination, { recursive: true });
  const host = new URL(origin).hostname;
  const manifestPath = path.join(destination, "manifest.json");
  const configPath = path.join(destination, "config.js");
  const manifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replaceAll(production, "http://" + host));
  // Grant only the two synthetic localhost hosts in this disposable profile.
  // Real installations still request optional permissions through Settings.
  manifest.host_permissions.push("http://localhost/*");
  const uiPath = path.join(destination, "ui-rules.js");
  const ui = (await fs.readFile(uiPath, "utf8")).replace('const origins = ["http://*/*", "https://*/*"];',
    'const origins = ["http://127.0.0.1/*", "http://localhost/*"];');
  const config = (await fs.readFile(configPath, "utf8")).replace(production, origin)
    .replace('const match = page.href + "*";', 'const match = page.origin.replace(/:[0-9]+$/, "") + page.pathname + "*";');
  await Promise.all([fs.writeFile(manifestPath, JSON.stringify(manifest)), fs.writeFile(configPath, config), fs.writeFile(uiPath, ui)]);
  return destination;
}

async function trial() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "taskpulse-web-"));
  const fixture = await startFixture();
  const origin = fixture.origin;
  const app = origin + "/ai/data-agent";
  const home = app + "?demo=board";
  const existing = app + "?agentId=515&conversationId=11&openHistory=true";
  let context;
  const pageErrors = [];
  try {
    const extension = await installFixtureCopy(dir, origin);
    context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
      channel: "chromium", headless: true, viewport: { width: 1400, height: 880 },
      ignoreDefaultArgs: ["--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
      args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension, "--no-proxy-server"]
    });
    const monitor = page => {
      page.on("pageerror", error => pageErrors.push(error.message));
      return page;
    };
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const page = monitor(context.pages()[0]);
    await page.goto(home);
    const compact = page.locator(root + " .compact");
    const panel = page.locator(root + " .panel");
    const horizontal = panel.locator(".horizontal");
    await compact.locator("[data-filter='running']").filter({ hasText: /^1$/ }).waitFor({ timeout: 16_000 });
    assert.deepEqual(await compact.boundingBox(), { x: 1356, y: 22, width: 44, height: 84 });
    await compact.hover();
    await horizontal.waitFor();
    assert.deepEqual(await horizontal.boundingBox(), { x: 1170, y: 24, width: 96, height: 24 });
    assert.equal((await panel.boundingBox()).width, 240);
    assert.equal(await panel.locator("[data-mode='dataagent']").getAttribute("aria-pressed"), "true");
    assert.equal(await panel.locator(".footer span").textContent(), "WEB");
    await page.mouse.move(600, 400);
    await panel.waitFor({ state: "hidden" });
    await compact.hover();
    const pin = panel.getByRole("button", { name: "固定展开" });
    await pin.click();
    assert.equal(await pin.getAttribute("aria-pressed"), "true");
    await page.mouse.move(600, 400);
    console.log("Chromium verified the desktop capsule dimensions, hover expansion and pin");

    const currentLeader = () => worker.evaluate(async key => (await chrome.storage.session.get(key))[key], leaderKey);
    const leader = await currentLeader();
    assert.ok(leader?.tabId);
    const listReads = () => fixture.requests.filter(r => r.path.endsWith("/list")).length;
    const other = monitor(await context.newPage());
    await other.goto(existing);
    await page.bringToFront();
    const group = panel.locator(".group-head").filter({ hasText: "数据质量" });
    await group.click();
    assert.equal((await group.boundingBox()).height, 26);
    const first = panel.locator("[data-cid='11'] .task-name");
    await first.waitFor();
    assert.equal((await panel.locator(".row.running").boundingBox()).height, 28);
    assert.equal((await first.textContent()).trim(), task.name);
    assert.equal((await currentLeader()).tabId, leader.tabId);
    assert.ok(listReads() >= 1);
    // Fast active lists can refresh more than once; leadership is stable.
    assert.equal((await currentLeader()).tabId, leader.tabId);
    assert.equal(await worker.evaluate(async () =>
      (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url), home);

    const firstRelease = fixture.releaseReply(900);
    const attention = horizontal.locator("[data-filter='attention']");
    await attention.filter({ hasText: /^1$/ }).waitFor({ timeout: 8_000 });
    console.log("Active reply end-to-end latency ms:", Date.now() - firstRelease);
    const toast = page.locator(root + " .toast").filter({ hasText: task.name });
    await toast.waitFor();
    assert.deepEqual(await toast.boundingBox(), { x: 1098, y: 14, width: 288, height: 64 });
    assert.equal(await page.locator(root + " .toast").count(), 1);
    const saved = await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], stateKey);
    assert.equal(saved.tasks["11"].status, "attention");
    assert.ok(saved.tasks["11"].notified);
    assert.ok(!JSON.stringify(saved).includes("Synthetic private reply"));

    const notifications = async () => Object.keys(await worker.evaluate(() => chrome.notifications.getAll()))
      .filter(id => id.startsWith("tp-reply:11/"));
    let notices = await notifications();
    for (let i = 0; !notices.length && i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      notices = await notifications();
    }
    assert.equal(notices.length, 1);

    await toast.click();
    await attention.filter({ hasText: /^0$/ }).waitFor({ timeout: 8_000 });
    assert.equal(await worker.evaluate(async () =>
      (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url), existing);
    assert.equal(context.pages().length, 2);
    console.log("Single collector, system notification and desktop-style toast jump passed");

    // Normal current-version toast navigation must not suppress automatic
    // reading of a later reply while the destination stays in the foreground.
    const secondStamp = fixture.releaseReply();
    let second;
    for (let i = 0; i < 32; i++) {
      second = (await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], stateKey)).tasks["11"];
      if (second?.replyKey === "message.m" + secondStamp && second.pending === false) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(second?.replyKey, "message.m" + secondStamp);
    assert.equal(second.pending, false);
    assert.equal(second.status, "seen");
    assert.equal((await notifications()).length, 0);
    assert.equal(await other.locator(root + " .toast").count(), 0);
    console.log("Current-version jump releases its guard; subsequent foreground reply is silently read, latency ms:", Date.now() - secondStamp);

    await page.bringToFront();
    await toast.waitFor({ state: "hidden" });
    await attention.click();
    assert.equal(await attention.getAttribute("aria-pressed"), "true");
    assert.equal(await horizontal.locator(".dimmed").count(), 2);
    await attention.click();
    if (await group.getAttribute("aria-expanded") === "false") await group.click();
    const newTab = context.waitForEvent("page", { timeout: 10_000 });
    await panel.locator("[data-cid='12']").click();
    const created = monitor(await newTab);
    await created.waitForURL(/conversationId=12/, { timeout: 12_000 });
    assert.equal(new URL(created.url()).origin, origin);
    assert.equal(new URL(created.url()).searchParams.get("agentId"), "515");

    const beforeClosing = listReads();
    await page.close();
    for (let i = 0; i < 80 && listReads() <= beforeClosing; i++) {
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    const replacement = await currentLeader();
    assert.ok(replacement?.tabId);
    assert.notEqual(replacement.tabId, leader.tabId);
    assert.ok(listReads() > beforeClosing);
    assert.deepEqual(pageErrors, []);
    console.log("New-tab jump and handoff to a remaining collector passed");

    // Exercise the actual installed content scripts and service worker
    // against a synthetic account change, without a real DataAgent login.
    const readState = () => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], stateKey);
    async function waitState(predicate, label) {
      let state;
      for (let i = 0; i < 176; i++) {
        state = await readState();
        if (predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.fail(label + ": " + JSON.stringify(state));
    }
    // Native Chrome groups are read from tabGroups, not inferred from names.
    const nativeGroup = await worker.evaluate(async targetUrl => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === targetUrl);
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: "合成项目", color: "blue" });
      return groupId;
    }, existing);

    // Enable global presentation via the actual Settings button.
    await created.bringToFront();
    const createdPanel = created.locator(root + " .panel");
    await createdPanel.waitFor({ state: "visible" });
    const openedOptions = context.waitForEvent("page", { timeout: 10_000 });
    await createdPanel.locator(".settings").click();
    const options = monitor(await openedOptions);
    await options.locator("#global").click();
    await options.locator("#global").filter({ hasText: "关闭全网页显示" }).waitFor();
    const external = monitor(await context.newPage());
    const externalUrl = "http://localhost:" + new URL(origin).port + "/workbench";
    await external.goto(externalUrl);
    await external.bringToFront();
    async function waitFrame(page, mode) {
      for (let i = 0; i < 100; i++) {
        const frame = page.frames().find(f => f.url().includes("surface.html#" + mode + "/"));
        if (frame) return frame;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail("Missing isolated surface: " + mode);
    }
    const globalFrame = await waitFrame(external, "panel");
    const globalPanel = globalFrame.locator(root + " .panel");
    await globalPanel.waitFor({ state: "visible" });
    await globalPanel.locator("[data-mode='tab']").click();
    await globalPanel.locator(".group-head").filter({ hasText: "合成项目" }).waitFor();
    await worker.evaluate(id => chrome.tabGroups.update(id, { title: "项目改名", color: "green" }), nativeGroup);
    await globalPanel.locator(".group-head").filter({ hasText: "项目改名" }).waitFor();
    assert.equal(await globalPanel.locator("[data-mode='tab']").getAttribute("aria-pressed"), "true");
    await globalPanel.locator("[data-mode='dataagent']").click();
    await globalPanel.locator(".group-head").filter({ hasText: "数据质量" }).waitFor();
    console.log("Native tab-group mode, live rename and DataAgent switch passed");

    const drag = await globalPanel.locator(".header-blank").boundingBox();
    assert.ok(drag && drag.width > 0);
    await external.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
    await external.mouse.down();
    await external.mouse.move(drag.x + drag.width / 2 - 160, drag.y + drag.height / 2 + 95, { steps: 10 });
    await external.mouse.up();
    let position;
    for (let i = 0; i < 30; i++) {
      position = await worker.evaluate(async () => (await chrome.storage.local.get("tp-web-position"))["tp-web-position"]);
      if (position && position.x < .98 && position.y > .04) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(position?.x < .98 && position?.y > .04, JSON.stringify(position));
    const external2 = monitor(await context.newPage());
    await external2.goto(externalUrl + "?second");
    await external2.bringToFront();
    const frame2 = await waitFrame(external2, "panel");
    await frame2.locator(root + " .panel").waitFor({ state: "visible" });
    const moved = await frame2.locator(root + " .panel").boundingBox();
    assert.ok(moved && moved.x < 1160 && moved.y > 45, JSON.stringify(moved));
    await external2.locator("#underlying").click();
    assert.equal(await external2.locator("#underlying").textContent(), "clicked");
    assert.equal(await external2.evaluate(() => document.getElementById("taskpulse-global-host")?.shadowRoot === null), true);
    assert.equal(await external2.evaluate(() => document.body.innerText.includes("验证 Spark 分区更新")), false);
    console.log("Global isolated capsule drag, persistence across tabs and ordinary page interaction passed");

    // The active collector is allowed to be hidden while the user works
    // on a different website. Trigger a real activity hint and a delayed
    // latest-message update, then check the visible global toast.
    fixture.startRun();
    await other.bringToFront();
    await other.locator("h1").click();
    await waitState(s => s?.tasks["11"]?.status === "running", "active run before background completion");
    await external2.bringToFront();
    const thirdStamp = fixture.releaseReply(1_400);
    const thirdAt = Date.now();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + thirdStamp &&
      s.tasks["11"].pending, "third background reply");
    const toastFrame = await waitFrame(external2, "toast");
    await toastFrame.locator(root + " .toast").filter({ hasText: task.name }).waitFor({ timeout: 8_000 });
    const latency = Date.now() - thirdAt;
    assert.ok(latency <= 8_000, "global reply latency: " + latency);
    assert.equal(fixture.requests.filter(r => r.from.includes("/workbench")).length, 0);
    console.log("Cross-site background reply and isolated toast passed, latency ms:", latency);
    // Clicking the global toast must land on the correct current version.
    await toastFrame.locator(root + " .toast").filter({ hasText: task.name }).click();
    await waitState(s => s?.tasks["11"]?.pending === false, "global toast acknowledged");
    assert.equal(await worker.evaluate(async () =>
      (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url), existing);

    // Preserve the original logout test with an independent unread reply.
    await created.bringToFront();
    const fourthStamp = fixture.releaseReply();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + fourthStamp &&
      s.tasks["11"].pending, "fourth background reply");
    for (let i = 0; i < 20 && !(await notifications()).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal((await notifications()).length, 1);
    fixture.setAccount("logout");
    await waitState(s => s?.authBlocked && s.tasks["11"]?.pending, "logout authorization fence");
    for (let i = 0; i < 20 && (await notifications()).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal((await notifications()).length, 0);
    await created.locator(root + " [data-cid='11']").waitFor({ state: "hidden" });
    console.log("Synthetic logout withdraws prior-account notices and rows without acknowledging the reply");

    fixture.setAccount("b");
    const switched = await waitState(s => !s?.authBlocked && s?.tasks["21"]?.listedAt === s.listAt &&
      s?.tasks["11"]?.accessDeniedAt, "new account and denied retained row");
    assert.equal(switched.tasks["11"].pending, true);
    assert.equal((await notifications()).length, 0);
    await created.locator(root + " [data-cid='11']").waitFor({ state: "hidden" });
    assert.deepEqual(pageErrors, []);
    console.log("Synthetic account switch hides and stops retaining inaccessible prior-account tasks");
    await options.bringToFront();
    await options.locator("#global").click();
    await options.locator("#global").filter({ hasText: "启用全网页显示" }).waitFor();
    await external2.bringToFront();
    await external2.locator("#taskpulse-global-host").waitFor({ state: "detached" });
    console.log("Global permission preference off removes ordinary-site surfaces");
  } catch (error) {
    console.error("Fixture pages:", context?.pages().map(page => page.url()));
    const worker = context?.serviceWorkers()[0];
    const state = await worker?.evaluate(async key => (await chrome.storage.local.get(key))[key], stateKey).catch(() => null);
    console.error("Fixture state:", JSON.stringify(state));
    console.error("Recent fixture requests:", JSON.stringify(fixture.requests.slice(-16)));
    throw error;
  } finally {
    await context?.close();
    await new Promise(resolve => fixture.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

trial().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
