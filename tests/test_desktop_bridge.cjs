const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {randomUUID} = require("node:crypto");
const read = name => fs.readFileSync(path.join(__dirname, "..", "edge-ext", name), "utf8");
const origin = "https://agent.example.com/chat";
const target = origin + "?agentId=a&conversationId=123";
function navigation(tabs, created = []) {
  const source = read("background.js");
  const start = source.indexOf("function matchesConversation(");
  const end = source.indexOf("// 长轮询：", start);
  assert.ok(start >= 0 && end > start);
  const ctx = {
    URL, Date, JSON, SCOPE: origin + "*", sleep: async () => {},
    isConversationTab: u => typeof u === "string" && u.startsWith(origin + "?"),
    chrome: {
      tabs: {
        get: async id => tabs.find(t => t.id === id) || null,
        query: async () => tabs,
        update: async (id, props) => {
          const t = tabs.find(t => t.id === id);
          Object.assign(t, props);
          if (t.pendingUrl) {t.url = t.pendingUrl; delete t.pendingUrl; t.status = "complete";}
          return t;
        },
        create: async props => {created.push(props); const t = {id: 99, windowId: 1, status: "complete", ...props}; tabs.push(t); return t;}
      },
      windows: {get: async () => ({focused:true}), update: async () => ({focused:true})}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return ctx;
}
test("desktop navigation requires exact conversation and agent identity", async () => {
  const tabs = [{id:1, windowId:1, status:"complete", active:true, url:origin+"?agentId=b&conversationId=123"}];
  const created = [];
  const ctx = navigation(tabs, created);
  assert.equal(ctx.matchesConversation(target, "12", target), false);
  assert.equal(ctx.matchesConversation(tabs[0].url, "123", target), false);
  assert.equal(await ctx.focusConversation("123", target, 1, Date.now()+1000, false), "not_started");
  assert.equal(created.length, 0);
});
test("uncertain navigation retries reuse a pending tab and never create a duplicate", async () => {
  const tabs = [{id:2, windowId:1, status:"loading", active:false, url:"about:blank", pendingUrl:target}];
  const created = [];
  const ctx = navigation(tabs, created);
  assert.equal(await ctx.focusConversation("123", target, undefined, Date.now()+1000, false), "focused");
  assert.equal(created.length, 0);
});
test("a late WEB list response from a revoked lease cannot publish", async () => {
  let receive, resolveOld, requests = 0;
  const reports = [], visits = [], listeners = {};
  const respond = data => ({ok:true, json:async () => data});
  const cfg = {api:{prefix:"",conv:"/list",queue:"/q/{cid}",state:"state",pending:"pending",idle:["IDLE"]}};
  const list = id => ({data:{groups:[],ungrouped:{conversations:[{id,name:"test",updateTime:1}]}}});
  const ctx = {
    window:{}, location:{href:target}, document:{hidden:false,hasFocus:()=>true,addEventListener:(kind, cb)=>{listeners[kind]=cb;}},
    crypto:{randomUUID}, AbortController, Date, setTimeout, clearTimeout,
    setInterval:()=>1, clearInterval:()=>{},
    chrome:{runtime:{
      id:"fixture",onMessage:{addListener:cb=>{receive=cb;}},
      sendMessage:(msg,cb)=>{
        if(msg.kind==="get-config") cb(cfg);
        else if(msg.kind==="tp-role-ask") cb({leader:true,generation:"old-gen",lease:"old"});
        else if(msg.kind==="webstate"){reports.push(JSON.parse(JSON.stringify(msg.payload))); cb({ok:true});}
        else if(msg.kind==="tp-user-visit"){visits.push({...msg}); cb({ok:true});}
      }
    }},
    fetch:async url=>{
      if(url==="/list"){
        requests++;
        if(requests===1) return new Promise(resolve=>{resolveOld=()=>resolve(respond(list(1)));});
        return respond(list(2));
      }
      if(url.includes("/q/")) return respond({data:{state:"RUNNING",pending:[]}});
      return respond({data:{list:[]}});
    }
  };
  vm.createContext(ctx); vm.runInContext(read("web-bridge.js"),ctx);
  const flush = () => new Promise(resolve=>setImmediate(resolve));
  await flush();
  assert.equal(requests,1);
  receive({kind:"tp-role",leader:false,generation:"new-gen",lease:"revoked"},null,()=>{});
  receive({kind:"tp-role",leader:true,generation:"new-gen",lease:"new"},null,()=>{});
  resolveOld(); await flush();
  assert.equal(reports.length,0);
  ctx.window.__tpWebBridgeTick(); await flush();
  assert.equal(requests,2);
  assert.equal(reports.length,1);
  assert.equal(reports[0].generation,"new-gen");
  assert.equal(reports[0].conversations[0].id,2);
  listeners.pointerdown({isTrusted:true});
  assert.equal(visits.length,1);
  assert.equal(visits[0].url,target);
});

test("an explicit visit cannot acknowledge a different SPA conversation", async () => {
  const source = read("background.js");
  const start = source.indexOf("async function notifyActive(");
  const end = source.indexOf("// 按 conversationId", start);
  assert.ok(start >= 0 && end > start);
  const current = origin + "?agentId=a&conversationId=456";
  const posts = [];
  const tab = {id: 5, windowId: 1, active: true, status: "complete", url: current};
  const ctx = {
    Date, JSON, AbortSignal, modeActionScope: "scope", ACTIVE_ENDPOINT: "/active",
    collectorId: async () => "chrome-profile", authHeaders: h => h,
    isConversationTab: u => typeof u === "string" && u.startsWith(origin + "?"),
    chrome: {tabs: {get: async () => tab}, windows: {get: async () => ({focused: true})}},
    fetch: async (_url, opts) => {posts.push(JSON.parse(opts.body)); return {ok: true};}
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  await ctx.notifyActive(5, true, Date.now(), target);
  assert.equal(posts.length, 0, "the event belonged to the old conversation");
  await ctx.notifyActive(5, true, Date.now(), current);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, current);
});

test("a failed command acknowledgement is bounded and does not stop listening", async () => {
  const source = read("background.js");
  const start = source.indexOf("// 长轮询：");
  const end = source.indexOf("chrome.runtime.onInstalled.addListener", start);
  assert.ok(start >= 0 && end > start);
  const requests = [], acks = [];
  let resolveFinished;
  const finished = new Promise(resolve => {resolveFinished = resolve;});
  const commands = [
    {id:"close-1", cmd:"closeTabs", collector:"chrome-profile", targets:{}},
    {id:"open-1", cmd:"focus", cid:"123", url:target}
  ];
  const ctx = {
    Date, JSON, encodeURIComponent, AbortSignal: {timeout: ms => ({ms})},
    CMD_ENDPOINT: "/cmd", ACK_ENDPOINT: "/ack", BASE: "",
    collectorId: async () => "chrome-profile", authHeaders: h => h, sleep: async () => {},
    closeTabsFor: async () => 0, focusConversation: async () => "focused",
    fetch: async (url, options) => {
      requests.push(url);
      if (url.startsWith("/ack?")) {
        acks.push(options.signal?.ms);
        throw new Error("fixture: network failure");
      }
      if (commands.length) return {status:200, json:async () => commands.shift()};
      resolveFinished();
      return new Promise(() => {});
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  void ctx.listen();
  await finished;
  assert.deepEqual(acks, [4000, 4000]);
  assert.equal(requests.filter(u => u.startsWith("/cmd?")).length, 3);
});

test("leader without a receiving content script is reinjected and acknowledged", async () => {
  const source = read("background.js");
  const start = source.indexOf("async function postRole(");
  const end = source.indexOf("function persistLeader(", start);
  assert.ok(start >= 0 && end > start);
  let sends = 0, injections = 0;
  const ctx = {
    roleLease:"lease", modeGeneration:"generation", leaderId:7, leaderPageId:"",
    roleSent:null, roleKey:()=>"lease:generation:true",
    chrome:{
      tabs:{sendMessage:async () => {
        if (++sends === 1) throw new Error("Receiving end does not exist");
        return {pageId:"recovered-page"};
      }},
      scripting:{executeScript:async options => {
        assert.equal(options.target.tabId, 7);
        assert.equal(options.files[0], "web-bridge.js");
        injections++;
      }}
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start,end),ctx);
  await ctx.postRole(7, true);
  assert.equal(injections, 1);
  assert.equal(sends, 2);
  assert.equal(ctx.leaderPageId, "recovered-page");
  assert.equal(ctx.roleSent, "lease:generation:true");
});
