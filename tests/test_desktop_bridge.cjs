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
  const reports = [];
  const respond = data => ({ok:true, json:async () => data});
  const cfg = {api:{prefix:"",conv:"/list",queue:"/q/{cid}",state:"state",pending:"pending",idle:["IDLE"]}};
  const list = id => ({data:{groups:[],ungrouped:{conversations:[{id,name:"test",updateTime:1}]}}});
  const ctx = {
    window:{}, location:{href:target}, document:{hidden:false,hasFocus:()=>true,addEventListener:()=>{}},
    crypto:{randomUUID}, AbortController, Date, setTimeout, clearTimeout,
    setInterval:()=>1, clearInterval:()=>{},
    chrome:{runtime:{
      id:"fixture",onMessage:{addListener:cb=>{receive=cb;}},
      sendMessage:(msg,cb)=>{
        if(msg.kind==="get-config") cb(cfg);
        else if(msg.kind==="tp-role-ask") cb({leader:true,generation:"old-gen",lease:"old"});
        else if(msg.kind==="webstate"){reports.push(JSON.parse(JSON.stringify(msg.payload))); cb({ok:true});}
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
});
