// 抓每个商品的可用支付方式（免房支付 / 预付分期 / 客房分成 / 0元购）
// 接口：POST /hmall/api/installment/queryRecommendInstallment
// 做法：把循环放进页面里跑（避免逐条 CDP 往返，慢且易卡）
// 用法：node tools/fetch-pay.mjs [--chunk=1500] [--conc=8]
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadRaw, isTrial, isNonGoods } from "./fold.mjs";

const PORT = 9333;
const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));
const CHUNK = Number(argv.chunk || 1500), CONC = Number(argv.conc || 8);
const OUT = path.join(ROOT, "data", "raw-pay.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// 每个商品取「最少下单金额」作为查询 price
const raw = loadRaw();
const ask = [];
for (const pid of Object.keys(raw)) {
  const v = raw[pid]; if (!v || v.code !== "200") continue;
  let best = null;
  for (const x of (v.pk || [])) {
    if (isTrial(x.n, x.p) || isNonGoods(x.n, x.p)) continue;
    const p = parseFloat(x.p), mq = Number(x.mq) || 1;
    if (!isFinite(p) || p <= 0) continue;
    const tot = p * mq;
    if (best == null || tot < best) best = tot;
  }
  ask.push([pid, best == null ? 0 : Math.round(best * 100) / 100]);
}

let store = { _meta: {}, items: {} };
if (fs.existsSync(OUT)) { try { store = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { } }
if (!store.items) store.items = {};
const todo = ask.filter(([pid]) => !store.items[pid]);
console.log("商品总数 " + ask.length + "，已有 " + Object.keys(store.items).length + "，本次待抓 " + todo.length);

const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("连不上调试浏览器，请先双击 start.bat"))); });
let id = 0; const pend = new Map();
ws.addEventListener("message", ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const rawCall = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id;
  pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })); });
const { targetId } = await rawCall("Target.createTarget", { url: "about:blank" });
const { sessionId } = await rawCall("Target.attachToTarget", { targetId, flatten: true });
const call = (m, p = {}) => rawCall(m, p, sessionId);
await call("Page.enable"); await call("Runtime.enable");
await call("Page.navigate", { url: "https://ebooking.ctrip.com/hmall/product/detail/475" });
await sleep(6000);

// 带超时的求值，避免卡死
const ev = (expr, timeout = 200000) => Promise.race([
  call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then(r => {
    if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error("evaluate 超时")), timeout)),
]);

const WORKER = `
window.__payRes = {};
window.__payRun = async function(items, conc){
  let i = 0;
  const g = (t,k) => ((t.match(new RegExp('<'+k+'>([^<]*)<\\\\/'+k+'>'))||[])[1]||'').trim();
  async function worker(){
    for(;;){
      const k = i++; if(k >= items.length) return;
      const pid = items[k][0], price = items[k][1];
      for(let a=0;a<3;a++){
        try{
          const r = await fetch('/hmall/api/installment/queryRecommendInstallment', {method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({productIdList:[pid], packageIdList:[], price:price})});
          const t = await r.text();
          if(t.indexOf('<code>200</code>') < 0){ window.__payRes[pid] = {code:'ERR'}; break; }
          window.__payRes[pid] = { code:'200', price:price,
            freeRoom: g(t,'canFreeRoom')==='true', prepay: g(t,'canPrepay')==='true',
            commission: g(t,'canCommission')==='true', zeroBuy: g(t,'zeroBuyEnable')==='true',
            disFree: g(t,'isShowFreeRoomDisable')==='true', disPrepay: g(t,'isShowPrepayDisable')==='true',
            disCommission: g(t,'isShowCommissionDisable')==='true' };
          break;
        }catch(e){ await new Promise(z=>setTimeout(z,300)); }
      }
    }
  }
  await Promise.all(Array.from({length:conc}, worker));
  return Object.keys(window.__payRes).length;
};`;
await ev(WORKER, 20000);

const stat = { freeRoom: 0, prepay: 0, commission: 0, zeroBuy: 0 };
Object.values(store.items).forEach(v => { if (v.code === "200") { if (v.freeRoom) stat.freeRoom++; if (v.prepay) stat.prepay++; if (v.commission) stat.commission++; if (v.zeroBuy) stat.zeroBuy++; } });

const t0 = Date.now();
for (let s = 0; s < todo.length; s += CHUNK) {
  const part = todo.slice(s, s + CHUNK);
  await ev(`window.__payRes={};`);
  const n = await ev(`window.__payRun(${JSON.stringify(part)}, ${CONC})`);
  const res = await ev(`(function(){return JSON.stringify(window.__payRes||{});})()`);
  if (res) { try { Object.assign(store.items, JSON.parse(res)); } catch { } }
  const done = Object.keys(store.items).length;
  const sec = (Date.now() - t0) / 1000;
  const rate = (s + part.length) / Math.max(sec, 1);
  const left = Math.round((todo.length - s - part.length) / Math.max(rate, 0.1));
  console.log(`  ${Math.min(s + part.length, todo.length)}/${todo.length}  ${rate.toFixed(0)}/s  剩余约${Math.floor(left / 60)}分${left % 60}秒  (本批返回 ${n})`);
  store._meta = { updatedAt: new Date().toISOString(), total: ask.length, done, stat, finished: false };
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(store)); fs.renameSync(OUT + ".tmp", OUT);
}

stat.freeRoom = stat.prepay = stat.commission = stat.zeroBuy = 0;
Object.values(store.items).forEach(v => { if (v.code === "200") { if (v.freeRoom) stat.freeRoom++; if (v.prepay) stat.prepay++; if (v.commission) stat.commission++; if (v.zeroBuy) stat.zeroBuy++; } });
store._meta = { updatedAt: new Date().toISOString(), total: ask.length, done: Object.keys(store.items).length, stat, finished: true };
fs.writeFileSync(OUT + ".tmp", JSON.stringify(store)); fs.renameSync(OUT + ".tmp", OUT);
console.log("\n===== 完成 =====");
console.log("商品 " + store._meta.done + " / " + ask.length);
console.log("免房支付 " + stat.freeRoom + " · 预付分期 " + stat.prepay + " · 客房分成 " + stat.commission + " · 0元购 " + stat.zeroBuy);
await rawCall("Target.closeTarget", { targetId });
ws.close(); process.exit(0);
