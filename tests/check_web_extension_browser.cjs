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
  let lastFailed = false, pendingFailed = false, queueFault = false, listFault = false;
  let queueDenied = false, listRegression = false;
  let account = "a";
  const alternate = { id: 21, agentId: 515, name: "合成账号 B 的会话" };
  const expired = { id: 22, agentId: 515, name: "25 小时前的会话" };
  const completed = { id: 23, agentId: 515, name: "已查看的近期会话" };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/viewport-scroll.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("html.fixture-scroll { overflow: scroll; } html.fixture-scroll::-webkit-scrollbar { width:20px;height:18px; } html.fixture-scroll body::after { content:''; display:block; width:200vw; height:200vh; }");
      return;
    }
    if (url.pathname === "/workbench") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="utf-8"><title>Ordinary website fixture</title><link rel="stylesheet" href="/viewport-scroll.css"><button id="underlying" onclick="this.textContent=\'clicked\'">Underlying page</button>');
      return;
    }
    if (url.pathname === "/ai/data-agent") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "style-src 'self'; connect-src 'self'"
      });
      response.end('<!doctype html><meta charset="utf-8"><title>DataAgent fixture</title><link rel="stylesheet" href="/viewport-scroll.css"><h1>会话验收</h1>');
      return;
    }
    if (!url.pathname.startsWith("/rest/flow/api/v1/conversations/")) {
      response.writeHead(404).end();
      return;
    }
    requests.push({ path: url.pathname, from: request.headers.referer || "" });
    if (account === "logout" ||
        account === "b" && !url.pathname.endsWith("/list") &&
          !["21", "22", "23"].some(id => url.pathname.includes("/" + id + "/"))) {
      response.writeHead(account === "logout" ? 401 : 403).end();
      return;
    }
    if (account === "a" && queueDenied && url.pathname.endsWith("/11/queue")) {
      response.writeHead(403).end(); return;
    }
    if (account === "a" && (listFault && url.pathname.endsWith("/list") ||
        queueFault && url.pathname.endsWith("/11/queue"))) {
      response.writeHead(503).end(); return;
    }
    if (account === "b" && url.pathname.endsWith("/21/queue")) {
      response.writeHead(503).end(); return;
    }
    let data;
    if (url.pathname.endsWith("/list") && account === "b") {
      data = { groups: [{ name: "账号 B", conversations: [
        { ...alternate, updateTime: seed, createTime: seed },
        { ...completed, updateTime: seed - 1, createTime: seed - 1 },
        { ...expired, updateTime: seed - 25 * 60 * 60_000, createTime: seed - 25 * 60 * 60_000 }
      ] }], ungrouped: { conversations: [] } };
    } else if (url.pathname.endsWith("/list")) {
      data = { groups: [{ name: "数据质量", conversations: [
        { ...task, updateTime: listRegression ? seed - 1 : updated, createTime: seed },
        { ...unopened, updateTime: seed, createTime: seed },
        { id: 13, agentId: 515, name: "未打开的近期会话", updateTime: seed, createTime: seed }
      ] }], ungrouped: { conversations: [] } };
    } else if (url.pathname.endsWith("/queue")) {
      data = { sessionState: url.pathname.includes("/11/") && working ? "BUSY" : "IDLE", pending: [] };
    } else if (url.pathname.endsWith("/messages")) {
      if (Date.now() >= replyReadyAt) { lastReply = pendingReply; lastFailed = pendingFailed; }
      const primary = url.pathname.includes("/11/");
      const stamp = primary ? lastReply : seed;
      data = { list: [{ sender: "assistant", id: "m" + stamp, createTime: stamp,
        content: primary && lastFailed ? "当前服务繁忙" : "Synthetic private reply" }] };
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
    releaseReply: (lag = 0, failed = false) => {
      working = false; updated = Date.now() + 1;
      pendingReply = updated; pendingFailed = failed; replyReadyAt = Date.now() + lag; return updated;
    },
    startRun: () => { working = true; updated = Date.now() + 1; return updated; },
    setQueueFault: value => { queueFault = value; },
    setListFault: value => { listFault = value; },
    setQueueDenied: value => { queueDenied = value; },
    setListRegression: value => { listRegression = value; },
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
    // Fault injection is confined to this disposable extension copy.
    // Two independent scenarios: registration fails synchronously or
    // asynchronously, then the first authenticated frame never completes
    // rendering. The synchronous case exposed the latched promise.
    const hostPath = path.join(extension, "surface-host.js");
    const hostSource = await fs.readFile(hostPath, "utf8");
    const regAnchor = 'const result = await chrome.runtime.sendMessage({ kind: "tp.surface.register" }).catch(() => null);';
    const sizeAnchor = 'else if (msg.type === "tp-frame-size") sizePanel(msg.expanded, msg.panelHeight);';
    assert.ok(hostSource.includes(regAnchor) && hostSource.includes(sizeAnchor));
    await fs.writeFile(hostPath, hostSource.replace(regAnchor,
      'const fault = new URL(location.href).searchParams.has("fixture-recover");' +
      'const attempt = fault ? Number(document.documentElement.dataset.fixtureMountAttempts || 0) + 1 : 0;' +
      'if (fault) document.documentElement.dataset.fixtureMountAttempts = String(attempt);' +
      'const asyncFault = new URL(location.href).searchParams.has("fixture-async");' +
      'const result = attempt === 1 ? (asyncFault ? await Promise.reject(new Error("fixture rejection")).catch(() => null) : null) : await chrome.runtime.sendMessage({ kind: "tp.surface.register" }).catch(() => null);')
      .replace(sizeAnchor, 'else if (msg.type === "tp-frame-size") {' +
      'if (new URL(location.href).searchParams.has("fixture-recover") && document.documentElement.dataset.fixtureMountAttempts === "2") return;' +
      'sizePanel(msg.expanded, msg.panelHeight); }'));
    context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
      channel: "chromium", headless: true, viewport: { width: 1400, height: 880 },
      ignoreDefaultArgs: ["--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--hide-scrollbars"],
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
    // Assert the production shadow stylesheet, including every count and
    // selection combination, without changing live task state.
    const readPalette = counter => counter.locator(".number").evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return {
        base: style.getPropertyValue("--base").trim(),
        light: style.getPropertyValue("--light").trim(),
        selection: style.getPropertyValue("--selection").trim()
      };
    }));
    const palette = await compact.evaluate(el => {
      const clone = el.cloneNode(true);
      clone.hidden = false;
      clone.style.visibility = "hidden";
      el.getRootNode().append(clone);
      const nodes = [...clone.querySelectorAll(".number")];
      const sample = () => nodes.map(node => {
        const style = getComputedStyle(node);
        return {
          base: style.getPropertyValue("--base").trim(),
          light: style.getPropertyValue("--light").trim(),
          selection: style.getPropertyValue("--selection").trim()
        };
      });
      try {
        nodes.forEach(node => { node.classList.add("zero"); node.classList.remove("dimmed"); node.setAttribute("aria-pressed", "false"); });
        const zero = sample();
        nodes.forEach(node => node.classList.remove("zero"));
        const active = sample();
        const selected = nodes.map((node, index) => {
          nodes.forEach((other, i) => {
            other.classList.toggle("dimmed", i !== index);
            other.setAttribute("aria-pressed", String(i === index));
          });
          return sample();
        });
        nodes.forEach(node => node.classList.add("zero"));
        const selectedZero = sample();
        return { zero, active, selected, selectedZero };
      } finally { clone.remove(); }
    });
    assert.deepEqual(palette.zero.map(p => p.base), ["59 119 156", "148 126 83", "155 84 85"]);
    assert.deepEqual(palette.active.map(p => p.base), ["65 151 204", "194 150 61", "203 105 94"]);
    assert.equal(new Set(palette.zero.map(p => p.base)).size, 3);
    const brightness = color => color.split(" ").map(Number).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
    for (let i = 0; i < 3; i++) {
      assert.ok(brightness(palette.active[i].light) - brightness(palette.zero[i].light) >= 45);
      assert.deepEqual(palette.selected[i].map(p => p.base), palette.active.map(p => p.base));
      assert.deepEqual(palette.selected[i].map(p => p.selection), [0, 1, 2].map(j => j === i ? ".42" : "0"));
    }
    assert.deepEqual(palette.selectedZero.map(p => p.base), palette.zero.map(p => p.base));
    assert.equal(palette.selectedZero[2].selection, ".42");
    assert.deepEqual((await readPalette(compact)).map(p => p.base),
      [palette.active[0].base, palette.zero[1].base, palette.zero[2].base]);
    console.log("Reference capsule palette: zero, active and selected states retain all three segment hues");

    const opacityOf = counter => counter.evaluate(el => getComputedStyle(el).opacity);
    assert.equal(await opacityOf(compact), "1", "active counter must retain full opacity");
    const vertical = await compact.boundingBox();
    assert.deepEqual(vertical, { x: 1372, y: 22, width: 28, height: 96 });
    const pillFont = await compact.locator(".number").first().evaluate(el => getComputedStyle(el).fontSize);
    assert.equal(pillFont, "16px");
    async function assertFitsContentViewport(page, locator) {
      let bounds, size;
      for (let i = 0; i < 60; i++) {
        size = await page.evaluate(() => ({ width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight, innerWidth, innerHeight }));
        bounds = await locator.boundingBox();
        if (bounds && bounds.x >= 0 && bounds.y >= 0 &&
            bounds.x + bounds.width <= size.width + .5 && bounds.y + bounds.height <= size.height + .5) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(size.width < size.innerWidth && size.height < size.innerHeight, "fixture must have classic scrollbars");
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
        bounds.x + bounds.width <= size.width + .5 && bounds.y + bounds.height <= size.height + .5,
        JSON.stringify({ bounds, size }));
      return bounds;
    }
    await page.evaluate(() => document.documentElement.classList.add("fixture-scroll"));
    await worker.evaluate(() => chrome.storage.local.set({ "tp-web-position": { x: 1, y: 1 } }));
    const atScrollEdge = await assertFitsContentViewport(page, compact);
    assert.equal(atScrollEdge.width, 28); assert.equal(atScrollEdge.height, 96);
    await compact.hover();
    await panel.waitFor({ state: "visible" });
    await assertFitsContentViewport(page, panel);
    await page.mouse.move(500, 300);
    await panel.waitFor({ state: "hidden" });
    await worker.evaluate(() => chrome.storage.local.remove("tp-web-position"));
    await page.evaluate(() => document.documentElement.classList.remove("fixture-scroll"));
    for (let i = 0; i < 60; i++) {
      const box = await compact.boundingBox();
      if (box?.x === vertical.x && box?.y === vertical.y) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(await compact.boundingBox(), vertical);
    console.log("Native capsule and expanded panel remain inside classic scrollbars");
    await compact.hover();
    await panel.waitFor({ state: "visible" });
    await compact.waitFor({ state: "hidden" });
    assert.deepEqual(await horizontal.boundingBox(), { x: 1172, y: 26, width: vertical.height, height: vertical.width });
    assert.equal(await horizontal.locator(".number").first().evaluate(el => getComputedStyle(el).fontSize), pillFont);
    assert.deepEqual(await readPalette(horizontal), await readPalette(compact));
    assert.equal(await panel.locator(".panel-title, .glass-bridge").count(), 0);
    assert.equal((await panel.boundingBox()).width, 240);
    assert.equal(await panel.locator("[data-mode='dataagent']").getAttribute("aria-pressed"), "true");
    assert.equal(await panel.locator(".footer span").textContent(), "WEB");
    await page.mouse.move(600, 400);
    await panel.waitFor({ state: "hidden" });
    const initial = await compact.boundingBox();
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down();
    await page.mouse.move(700, 7, { steps: 10 });
    await page.mouse.up();
    await compact.locator("[data-filter='running']").waitFor();
    for (let i = 0; i < 30 && !(await compact.getAttribute("class")).includes("dock-horizontal"); i++)
      await new Promise(r => setTimeout(r, 50));
    const top = await compact.boundingBox();
    assert.equal(top.width, vertical.height); assert.equal(top.height, vertical.width); assert.equal(top.y, 8);
    assert.equal(await compact.locator(".number").first().evaluate(el => getComputedStyle(el).fontSize), pillFont);
    await compact.hover();
    await panel.waitFor({ state: "visible" });
    await compact.waitFor({ state: "hidden" });
    assert.equal((await panel.boundingBox()).y, top.y);
    assert.equal((await horizontal.boundingBox()).height, top.height);
    assert.equal((await horizontal.boundingBox()).width, top.width);
    // Restore the legacy location for the existing behavioral checks.
    await worker.evaluate(() => chrome.storage.local.remove("tp-web-position"));
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
    const groupText = () => group.locator(".group-name").evaluate(el => ({
      color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity
    }));
    assert.deepEqual(await groupText(), { color: "rgb(238, 246, 251)", opacity: "1" });
    const first = panel.locator("[data-cid='11'] .task-name");
    await first.waitFor();
    assert.equal((await panel.locator(".row.running").boundingBox()).height, 28);
    assert.equal(await panel.locator(".row.running .row-plate").evaluate(el => getComputedStyle(el).backgroundColor),
      "rgba(97, 159, 190, 0.38)", "running row must retain a visible blue fill");
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
    assert.deepEqual((await readPalette(horizontal)).map(p => p.base),
      [palette.zero[0].base, palette.active[1].base, palette.zero[2].base]);
    console.log("Active reply end-to-end latency ms:", Date.now() - firstRelease);
    assert.equal(await panel.locator(".row.attention .row-plate").evaluate(el => getComputedStyle(el).backgroundColor),
      "rgba(200, 164, 96, 0.31)", "existing amber row tint must be preserved");
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
    await horizontal.locator(".number.zero").nth(2).waitFor();
    assert.equal(await opacityOf(horizontal), "0.75");
    assert.equal(await opacityOf(compact), "0.75");
    assert.equal(await opacityOf(panel), "1", "the surrounding panel must not fade");
    assert.deepEqual(await groupText(), { color: "rgb(238, 246, 251)", opacity: "1" },
      "idle group titles remain white");
    assert.deepEqual((await readPalette(horizontal)).map(p => p.base), palette.zero.map(p => p.base));
    await attention.click();
    assert.equal(await attention.getAttribute("aria-pressed"), "true");
    const selectedPalette = await readPalette(horizontal);
    assert.deepEqual(selectedPalette.map(p => p.base), palette.zero.map(p => p.base));
    assert.deepEqual(selectedPalette.map(p => p.selection), ["0", ".42", "0"]);
    assert.equal(await opacityOf(horizontal), "0.75", "selection keeps the highlight hierarchy at zero counts");
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
    await globalPanel.locator(".group-head").filter({ hasText: "未分组标签页" }).waitFor();
    assert.equal(await globalPanel.locator(".group-head").count(), 2);
    assert.equal(await globalPanel.locator(".group-head").filter({ hasText: "数据质量" }).count(), 0);
    assert.equal(await globalPanel.locator(".group-head").filter({ hasText: "未打开" }).count(), 0);
    for (const group of await globalPanel.locator(".group-head").all()) {
      if (await group.getAttribute("aria-expanded") === "false") await group.click();
    }
    assert.equal(await globalPanel.locator("[data-cid='11']").count(), 1);
    assert.equal(await globalPanel.locator("[data-cid='12']").count(), 1);
    assert.equal(await globalPanel.locator("[data-cid='13']").count(), 0);
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
    assert.equal(await frame2.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgba(0, 0, 0, 0)");
    assert.equal(await frame2.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light");
    const capsule2 = frame2.locator(root + " .compact");
    const panel2 = frame2.locator(root + " .panel");
    const headerCapsule = panel2.locator(".horizontal");
    await capsule2.waitFor({ state: "hidden" });
    assert.equal((await headerCapsule.boundingBox()).height, 28);
    const rect2 = await panel2.locator(".header-blank").boundingBox();
    const fromX = rect2.x + rect2.width / 2, fromY = rect2.y + rect2.height / 2;
    await external2.mouse.move(fromX, fromY);
    await external2.mouse.down();
    // Let the cross-origin start message install its drag shield. This is
    // normal pointer input, not synthetic dispatch into the extension.
    await new Promise(r => setTimeout(r, 50));
    for (let step = 1; step <= 12; step++) {
      await external2.mouse.move(fromX + (700 - fromX) * step / 12, fromY + (5 - fromY) * step / 12);
      await new Promise(r => setTimeout(r, 17));
    }
    await external2.mouse.up();
    let dockPosition;
    for (let i = 0; i < 50; i++) {
      dockPosition = await worker.evaluate(async () => (await chrome.storage.local.get("tp-web-position"))["tp-web-position"]);
      if (dockPosition?.edge === "top" && (await panel2.boundingBox())?.y === 8) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(dockPosition?.edge, "top", JSON.stringify(dockPosition));
    assert.equal((await panel2.boundingBox()).y, 8);
    // Collapse at the new dock and verify the standalone rotated pill.
    await panel2.locator(".close").click();
    await capsule2.waitFor({ state: "visible" });
    const docked = await capsule2.boundingBox();
    assert.equal(docked.width, vertical.height); assert.equal(docked.height, vertical.width); assert.equal(docked.y, 8);
    await capsule2.hover();
    await panel2.waitFor({ state: "visible" });
    await panel2.locator(".pin").click();
    await worker.evaluate(value => chrome.storage.local.set({ "tp-web-position": value }), position);
    console.log("Global isolated capsule drag, persistence across tabs and ordinary page interaction passed");

    // The active collector is allowed to be hidden while the user works
    // on a different website. Trigger a real activity hint and a delayed
    // latest-message update, then check the visible global toast.
    fixture.startRun();
    await other.bringToFront();
    await other.locator("h1").click();
    await waitState(s => s?.tasks["11"]?.status === "running", "active run before background completion");
    await external2.bringToFront();
    const resumedFrame = await waitFrame(external2, "panel");
    const resumedCounter = resumedFrame.locator(root + " .panel .horizontal");
    await resumedCounter.locator("[data-filter='running']").filter({ hasText: /^1$/ }).waitFor({ timeout: 8_000 });
    assert.equal(await opacityOf(resumedCounter), "1", "new work restores full opacity");
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

    // Real extension UI: keep a verified unread through a list outage,
    // revalidation, and a subsequent queue outage. Nudge the existing
    // collector using its real activity protocol to avoid a cold 60s wait.
    // Never write synthetic task state into extension storage.
    await created.bringToFront();
    const continuityPanel = created.locator(root + " .panel");
    if (!await continuityPanel.isVisible()) {
      await created.locator(root + " .compact [data-filter='running']").click();
    }
    await continuityPanel.waitFor({ state: "visible" });
    const yellow = continuityPanel.locator(".horizontal [data-filter='attention']");
    const red = continuityPanel.locator(".horizontal [data-filter='stuck']");
    const continuityGroup = continuityPanel.locator(".group-head").filter({ hasText: "数据质量" });
    async function nudgePrimary() {
      const lead = await currentLeader();
      assert.ok(lead?.tabId);
      await worker.evaluate(async lead => {
        await chrome.tabs.sendMessage(lead.tabId, {
          kind: "tp.nudge", pageId: lead.pageId, activity: true, cid: "11"
        }, { frameId: 0 });
      }, lead);
    }
    const continuityStamp = fixture.releaseReply();
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + continuityStamp &&
      s.tasks["11"].pending && s.tasks["11"].status === "attention", "continuity unread reply");
    await yellow.filter({ hasText: /^1$/ }).waitFor();
    await yellow.click();
    await continuityPanel.locator("[data-cid='11']").waitFor({ state: "visible" });
    fixture.setListFault(true);
    await nudgePrimary();
    await waitState(s => s?.error === "HTTP 503" && s.tasks["11"]?.pending, "list outage for unread");
    fixture.setListFault(false);
    fixture.setQueueFault(true);
    await nudgePrimary();
    const partialRecovery = await waitState(s => !s?.error && !s?.sourceUnavailable &&
      s?.tasks["11"]?.pending && s.tasks["11"].queueError,
      "list recovered while the conversation queue remains unavailable");
    assert.equal(partialRecovery.tasks["11"].replyKey, "message.m" + continuityStamp);
    await yellow.filter({ hasText: /^1$/ }).waitFor({ timeout: 8_000 });
    assert.equal(await continuityGroup.locator(".group-open").textContent(), "1");
    console.log("Partial list recovery keeps the previously verified yellow reply visible");
    fixture.setQueueFault(false);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.pending && !s.tasks["11"].queueError,
      "queue revalidated after partial recovery");
    fixture.setQueueFault(true);
    await nudgePrimary();
    const uncertainUnread = await waitState(s => s?.tasks["11"]?.queueError &&
      s.tasks["11"].pending, "second outage for same unread");
    assert.equal(uncertainUnread.tasks["11"].replyKey, "message.m" + continuityStamp);
    await yellow.filter({ hasText: /^1$/ }).waitFor({ timeout: 8_000 });
    assert.equal(await continuityGroup.locator(".group-open").textContent(), "1");
    assert.equal(await continuityGroup.getAttribute("aria-expanded"), "true");
    assert.equal(await continuityPanel.locator(".task-open").count(), 1);
    assert.equal(await continuityPanel.locator(".row.attention .row-plate").evaluate(el => getComputedStyle(el).backgroundColor),
      "rgba(200, 164, 96, 0.31)");
    fixture.setQueueFault(false);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.pending && !s.tasks["11"].queueError, "queue recovered");
    console.log("Repeated list/queue outage preserves exact unread, yellow counter, group, filter and amber row");

    // Red completed reply, not a genuinely busy execution. Click the actual
    // row while a 503 prevents immediate acknowledgement; recover while
    // the destination remains active. No fake read or direct storage write.
    const redStamp = fixture.releaseReply(0, true);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + redStamp &&
      s.tasks["11"].pending && s.tasks["11"].status === "stuck" && !s.tasks["11"].runAt,
      "completed failed reply");
    await red.filter({ hasText: /^1$/ }).waitFor();
    await red.click();
    await continuityPanel.locator(".row.stuck [data-cid='11']").waitFor();
    assert.equal(await continuityPanel.locator(".row.stuck .row-plate").evaluate(el => getComputedStyle(el).backgroundColor),
      "rgba(206, 112, 100, 0.4)", "completed failed reply must have coral fill");
    fixture.setQueueFault(true);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.queueError && s.tasks["11"].pending, "red row temporary queue fault");
    await red.filter({ hasText: /^1$/ }).waitFor();
    await continuityPanel.locator(".row.stuck [data-cid='11']").click();
    await waitState(s => s?.tasks["11"]?.pending, "red reply remains pending until recovery");
    // Wait for the actual landing and its durable deferred guard before
    // unblocking the queue so this test cannot accidentally take the fresh path.
    let deferred;
    for (let i = 0; i < 80; i++) {
      deferred = await worker.evaluate(async target => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const guards = (await chrome.storage.session.get("tp-web-jump-tabs-v1"))["tp-web-jump-tabs-v1"] || {};
        return tab?.url === target && guards[tab.id]?.deferredRead ? guards[tab.id] : null;
      }, existing);
      if (deferred) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(deferred, "red row did not retain exact landed deferred read");
    assert.ok(deferred.revision.endsWith("message.m" + redStamp));
    // A real trusted wheel event records that the user inspected the
    // conversation. Switching away must preserve this exact read intent.
    await other.mouse.move(420, 420);
    await other.mouse.wheel(0, 900);
    let visitedGuard;
    for (let i = 0; i < 80; i++) {
      visitedGuard = await worker.evaluate(async () =>
        (await chrome.storage.session.get("tp-web-jump-tabs-v1"))["tp-web-jump-tabs-v1"] || {});
      if (Object.values(visitedGuard).some(guard => guard?.visited && guard.revision === deferred.revision)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(Object.values(visitedGuard).some(guard => guard?.visited && guard.revision === deferred.revision),
      "trusted wheel interaction did not persist the exact visit intent");
    await created.bringToFront();
    visitedGuard = await worker.evaluate(async () =>
      (await chrome.storage.session.get("tp-web-jump-tabs-v1"))["tp-web-jump-tabs-v1"] || {});
    assert.ok(Object.values(visitedGuard).some(guard => guard?.visited && guard.revision === deferred.revision),
      "switching away discarded the visited read intent");
    fixture.setQueueFault(false);
    await nudgePrimary();
    const redRead = await waitState(s => s?.tasks["11"]?.pending === false &&
      s.tasks["11"].readRevision === deferred.revision, "exact red reply acknowledged after recovery");
    assert.equal(redRead.tasks["11"].status, "seen");

    // P1: the interaction that inspected red reply A must not transfer to
    // a later reply B while the same destination tab remains foreground.
    fixture.setQueueFault(true);
    const guardedStamp = fixture.releaseReply(0, true);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + guardedStamp &&
      s.tasks["11"].pending && s.tasks["11"].status === "stuck" && s.tasks["11"].queueError,
      "second red reply with unavailable queue");
    await red.filter({ hasText: /^1$/ }).waitFor();
    await continuityPanel.locator(".row.stuck [data-cid='11']").click();
    let guarded;
    for (let i = 0; i < 80; i++) {
      guarded = await worker.evaluate(async target => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const guards = (await chrome.storage.session.get("tp-web-jump-tabs-v1"))["tp-web-jump-tabs-v1"] || {};
        return tab?.url === target ? guards[tab.id] : null;
      }, existing);
      if (guarded?.deferredRead) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(guarded?.deferredRead);
    await other.mouse.move(420, 420);
    await other.mouse.wheel(0, 900);
    for (let i = 0; i < 80; i++) {
      const current = await worker.evaluate(async () =>
        (await chrome.storage.session.get("tp-web-jump-tabs-v1"))["tp-web-jump-tabs-v1"] || {});
      if (Object.values(current).some(g => g?.visited && g.revision === guarded.revision)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fixture.setQueueFault(false);
    const successorStamp = fixture.releaseReply(0, false);
    await nudgePrimary();
    const successor = await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + successorStamp &&
      s.tasks["11"].pending && !s.tasks["11"].queueError,
      "successor reply B recovered without transferring A read");
    assert.notEqual(successor.tasks["11"].readRevision,
      "11/515/" + successorStamp + "/message.m" + successorStamp);
    assert.ok(Object.keys(successor.outbox).some(key => key.endsWith("message.m" + successorStamp)),
      "successor reply must retain its own notice");
    await other.mouse.move(420, 420);
    await other.mouse.wheel(0, 900);
    await waitState(s => s?.tasks["11"]?.pending === false &&
      s.tasks["11"].readRevision === "11/515/" + successorStamp + "/message.m" + successorStamp,
      "a fresh page interaction after B may acknowledge B");
    await created.bringToFront();

    // A per-conversation 403 must win over a regressed list row, hide the
    // prior-account title and withdraw its notification.
    const deniedStamp = fixture.releaseReply(0, true);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.replyKey === "message.m" + deniedStamp &&
      s.tasks["11"].pending && s.tasks["11"].status === "stuck", "reply before per-conversation denial");
    await red.filter({ hasText: /^1$/ }).waitFor();
    fixture.setListRegression(true);
    fixture.setQueueDenied(true);
    await nudgePrimary();
    const denied = await waitState(s => s?.tasks["11"]?.accessDeniedAt &&
      s.tasks["11"].listUncertain, "403 combined with a regressed list");
    assert.equal(denied.tasks["11"].pending, true);
    assert.equal((await notifications()).length, 0);
    await continuityPanel.locator("[data-cid='11']").waitFor({ state: "hidden" });
    fixture.setQueueDenied(false);
    fixture.setListRegression(false);
    await nudgePrimary();
    await waitState(s => s?.tasks["11"]?.pending && !s.tasks["11"].accessDeniedAt &&
      !s.tasks["11"].listUncertain, "per-conversation access restored with fresh queue evidence");
    await red.filter({ hasText: /^1$/ }).waitFor();
    await continuityPanel.locator(".row.stuck [data-cid='11']").click();
    await waitState(s => s?.tasks["11"]?.pending === false, "red reply acknowledged after access recovery");

    await created.bringToFront();
    // The selected red filter has no match. Manually opening a quiet group
    // must not leak nonmatching historical/seen rows into filter results.
    await red.filter({ hasText: /^0$/ }).waitFor();
    if (await continuityGroup.getAttribute("aria-expanded") === "false") await continuityGroup.click();
    assert.equal(await continuityPanel.locator(".task-open").count(), 0);
    await red.click(); // restore all-rows view for the remaining original checks
    console.log("Real red row jump defers exact read through 503, clears on recovery, and keeps zero-match filter exact");

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

    // A new tab can activate before it has a real URL. Remove dynamic
    // registration to force the actual onUpdated completion recovery.
    const registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ["taskpulse-global-surface"] }));
    assert.equal(registrations.length, 1);
    await worker.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ["taskpulse-global-surface"] }));
    const recovering = monitor(await context.newPage());
    await recovering.goto(externalUrl + "?fixture-recover=1");
    await recovering.bringToFront();
    let recoveredFrame;
    for (let i = 0; i < 120; i++) {
      const attempts = await recovering.evaluate(() => Number(document.documentElement.dataset.fixtureMountAttempts || 0));
      recoveredFrame = recovering.frames().find(f => f.url().includes("surface.html#panel/"));
      if (attempts >= 3 && recoveredFrame) {
        const ready = await recoveredFrame.locator(root + " .window").isVisible().catch(() => false);
        if (ready) break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await recovering.evaluate(() => Number(document.documentElement.dataset.fixtureMountAttempts || 0)), 3);
    const recoveredPanel = recoveredFrame.locator(root + " .panel");
    await recoveredPanel.waitFor({ state: "visible", timeout: 8_000 });
    const probeSurface = () => worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      return chrome.tabs.sendMessage(tab.id, { kind: "tp.surface-probe" }, { frameId: 0 });
    }, recovering.url());
    assert.equal((await probeSurface()).ok, true);
    await recovering.evaluate(() => document.getElementById("taskpulse-global-host").remove());
    const lost = await probeSurface();
    assert.deepEqual(lost, { ok: false, installed: true });
    for (let i = 0; i < 60; i++) {
      const result = await probeSurface().catch(() => null);
      if (result?.ok) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await probeSurface()).ok, true);
    assert.equal(await recovering.locator("#taskpulse-global-host").count(), 1);
    // A healthy-looking frame whose session token was lost must not stay
    // silently unusable. Real activation exercises background health repair.
    const staleCredential = (await probeSurface()).token;
    assert.ok(staleCredential);
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      await chrome.storage.session.remove("tp-web-surface:" + tab.id);
    }, recovering.url());
    // Probe via an actual activation, without manually requesting repair.
    await options.bringToFront();
    await recovering.bringToFront();
    let renewed;
    for (let i = 0; i < 80; i++) {
      const result = await probeSurface().catch(() => null);
      if (result?.ok && result.token && result.token !== staleCredential) {
        renewed = result;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(renewed, "lost surface credential was not renewed");
    assert.equal(await recovering.locator("#taskpulse-global-host").count(), 1);
    const frameAfter = await waitFrame(recovering, "panel");
    await recovering.evaluate(() => document.documentElement.classList.add("fixture-scroll"));
    await worker.evaluate(() => chrome.storage.local.set({ "tp-web-position": { x: 1, y: 1 } }));
    const boundedPanel = frameAfter.locator(root + " .panel");
    await boundedPanel.waitFor({ state: "visible" });
    await assertFitsContentViewport(recovering, boundedPanel);
    await boundedPanel.locator(".close").click();
    const boundedCompact = frameAfter.locator(root + " .compact");
    await boundedCompact.waitFor({ state: "visible" });
    const bounds = await assertFitsContentViewport(recovering, boundedCompact);
    assert.equal(bounds.width, 28); assert.equal(bounds.height, 96);
    // Verify the user's actual checkbox interaction in the isolated frame.
    await worker.evaluate(() => chrome.storage.local.remove("tp-web-position"));
    for (let i = 0; i < 60; i++) {
      if ((await boundedCompact.boundingBox())?.y === 22) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await boundedCompact.boundingBox()).y, 22);
    await boundedCompact.hover();
    await boundedPanel.waitFor({ state: "visible" });
    await boundedPanel.locator(".pin").click();
    const newGroup = boundedPanel.locator(".group-head").filter({ hasText: "账号 B" });
    await newGroup.waitFor();
    if (await newGroup.getAttribute("aria-expanded") === "false") await newGroup.click();
    await waitState(s => s?.tasks["21"]?.queueError && s?.tasks["23"]?.observedAt &&
      s.tasks["22"]?.listedAt === s.listAt, "uncertain/recent/expired fixture rows");
    assert.equal(await boundedPanel.locator("[data-cid='22']").count(), 0);
    assert.ok((await newGroup.textContent()).includes("2 个会话"));
    const beforeDismiss = (await readState()).tasks["21"];
    const check = boundedPanel.locator("[data-check='21']");
    assert.equal(await check.isEnabled(), true);
    await check.click();
    await boundedPanel.locator("[data-cid='21']").waitFor({ state: "detached" });
    const dismissed = (await readState()).tasks["21"];
    assert.equal(dismissed.acked, beforeDismiss.acked);
    assert.equal(dismissed.readRevision, beforeDismiss.readRevision);
    assert.ok(dismissed.dismissedVersion);
    const known = boundedPanel.locator("[data-check='23']");
    await known.waitFor({ state: "visible" });
    assert.equal(await known.isEnabled(), true);
    await known.click();
    await boundedPanel.locator("[data-cid='23']").waitFor({ state: "detached" });
    assert.equal(await boundedPanel.locator(".task-open").count(), 0);
    console.log("Uncertain and verified checkbox dismissal removes rows, keeps evidence, and excludes 25-hour history");
    await recovering.close();
    const asyncRecovering = monitor(await context.newPage());
    await asyncRecovering.goto(externalUrl + "?fixture-recover=1&fixture-async=1");
    await asyncRecovering.bringToFront();
    for (let i = 0; i < 120; i++) {
      const attempts = await asyncRecovering.evaluate(() => Number(document.documentElement.dataset.fixtureMountAttempts || 0));
      const f = asyncRecovering.frames().find(f => f.url().includes("surface.html#panel/"));
      if (attempts === 3 && f && await f.locator(root + " .panel").isVisible().catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await asyncRecovering.evaluate(() => Number(document.documentElement.dataset.fixtureMountAttempts || 0)), 3);
    const asyncFrame = await waitFrame(asyncRecovering, "panel");
    await asyncFrame.locator(root + " .panel").waitFor({ state: "visible", timeout: 8_000 });
    await asyncRecovering.close();
    await worker.evaluate(value => chrome.scripting.registerContentScripts(value), registrations);
    console.log("New-tab completion, bounded failed-register/frame recovery, detached-host repair and isolated scrollbar geometry passed");
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
