const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const ext = path.resolve(__dirname, "../taskpulse-ext");
const origin = "https://dataagent.corp.kuaishou.com";
const app = origin + "/ai/data-agent";
const home = app + "?demo=board";
const existing = app + "?agentId=515&conversationId=11&openHistory=true";
const unopen = { id: 12, agentId: 515, name: "订单链路字段核查" };
const seed = Date.now() - 120000;
const task = { id: 11, agentId: 515, name: "验证 Spark 分区更新" };
const root = "#taskpulse-web-capsule";
const dataKey = "tp-web-state-v1";
async function trial() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "taskpulse-web-"));
  const channel = process.env.TP_TEST_BROWSER || "chromium";
  const context = await chromium.launchPersistentContext(profile, {
    channel, headless: true, viewport: { width: 1400, height: 880 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--disable-extensions-except=" + ext, "--load-extension=" + ext,
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding"]
  });
  const fail = [];
  const requests = [];
  const workers = [];
  const track = worker => {
    workers.push(worker.url());
    worker.on("console", msg => {
      if (msg.type() === "error" || msg.type() === "warning") console.log(channel, "worker:", msg.text());
    });
  };
  context.serviceWorkers().forEach(track);
  context.on("serviceworker", track);

  let updated = seed;
  const json = (route, data) => route.fulfill({ json: { success: true, data } });
  await context.route(origin + "/**", async route => {
    const u = new URL(route.request().url());
    if (u.pathname === "/ai/data-agent") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DataAgent · Test fixture</title>
<style>body{background:#f2f6fa;margin:0;font:16px -apple-system,sans-serif;color:#20384d}header{height:59px;padding:23px 35px;border-bottom:1px solid #c9d9e6;background:#fff}aside{width:245px;top:106px;bottom:0;position:absolute;padding:35px;background:#e6edf4}article{margin:48px 0 0 342px}h1{font-size:32px}</style>
<header>DataAgent</header><aside>会话<br><br>数据质量<br><br>验证 Spark 分区更新<br><br>订单链路字段核查</aside><article><h1>数据研发工作台</h1><p>用于浏览器自动化验收的示例会话。</p></article></html>` });
    }
    if (!u.pathname.startsWith("/rest/flow/api/v1/conversations/")) return route.fulfill({ status: 404 });
    let from = "";
    try { from = route.request().frame().url(); } catch {}
    requests.push({ path: u.pathname, from });
    if (u.pathname.endsWith("/list")) {
      return json(route, {
        groups: [{ name: "数据质量", conversations: [
          { ...task, updateTime: updated, createTime: seed },
          { ...unopen, updateTime: seed, createTime: seed }
        ] }], ungrouped: { conversations: [] }
      });
    }
    if (u.pathname.endsWith("/queue")) {
      return json(route, { sessionState: u.pathname.includes("/11/") && updated === seed ? "BUSY" : "IDLE", pending: [] });
    }
    if (u.pathname.endsWith("/messages")) {
      return json(route, { list: [{ sender: "assistant", id: "m" + updated,
        createTime: u.pathname.includes("/11/") ? updated : seed, content: "Synthetic private reply" }] });
    }
    return route.fulfill({ status: 404 });
  });

  function monitor(page) {
    page.on("pageerror", e => fail.push(e.message));
    return page;
  }
  try {
    const page = monitor(context.pages()[0]);
    await page.goto(home);
    await page.locator(root + " button.running").filter({ hasText: /^1$/ }).waitFor({ timeout: 16000 });
    console.log(channel, "initial collection and styled capsule verified", workers);
    const other = monitor(await context.newPage());
    await other.goto(existing);
    await page.bringToFront();
    await page.locator(root + " .all").click();
    await page.locator(root + " [data-cid='11']").waitFor();
    assert.equal((await page.locator(root + " [data-cid='11']").textContent()).trim(), task.name + "↗");

    const prior = requests.filter(r => r.path.endsWith("/list") && r.from === home).length;
    assert.equal(prior, 1);
    assert.ok(requests.every(r => r.from !== existing), JSON.stringify(requests));
    updated = Date.now() + 1;
    await page.locator(root + " button.attention").filter({ hasText: /^1$/ }).waitFor({ timeout: 39000 });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const saved = await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], dataKey);
    assert.equal(saved.tasks["11"].status, "attention");
    assert.ok(saved.tasks["11"].notified, JSON.stringify(saved.tasks["11"]));
    assert.ok(!JSON.stringify(saved).includes("Synthetic private reply"));
    const notices = await worker.evaluate(() => chrome.notifications.getAll());
    assert.equal(Object.keys(notices).filter(id => id.startsWith("tp-reply:11/")).length, 1);

    await page.locator(root + " [data-cid='11']").click();
    await page.locator(root + " button.attention").filter({ hasText: /^0$/ }).waitFor({ timeout: 8000 });
    assert.equal(context.pages().length, 2);
    const activated = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
    assert.equal(activated, existing);
    console.log(channel, "single collector, system notification registration, existing-tab navigation and ack verified");

    await page.bringToFront();
    await page.locator(root + " .panel").waitFor({ state: "hidden" });
    await page.locator(root + " .all").click();
    const newTab = context.waitForEvent("page");
    await page.locator(root + " [data-cid='12']").click();
    const created = monitor(await newTab);
    await created.waitForURL(/conversationId=12/);
    assert.equal(new URL(created.url()).origin, origin);
    assert.equal(new URL(created.url()).searchParams.get("agentId"), "515");
    await page.close();
    for (let i = 0; i < 80 && !requests.some(r => r.path.endsWith("/list") && r.from !== home); i++) {
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    assert.ok(requests.some(r => r.path.endsWith("/list") && r.from !== home), JSON.stringify(requests));
    assert.deepEqual(fail, []);
    console.log(channel, "new-tab navigation and handoff to a remaining collector verified");
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

trial().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
