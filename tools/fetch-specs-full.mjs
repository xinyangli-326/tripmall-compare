// 全库补抓套餐明细（核心目标：拿到 minQuantity）
// 用法：node tools/fetch-specs-full.mjs  [--limit=N] [--conc=5] [--out=path]
// 依赖：本机已登录的调试 Edge（9333，profile _edgeprofile）。源目录只读。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC = "C:\\Users\\yuri0618\\Documents\\Codex\\2026-09-02\\tripmall-c-users-yuri0618-documents-codex";
const PORT = 9333;

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));
const LIMIT = Number(argv.limit || 0);
const CONC = Number(argv.conc || 5);
const OUT = path.resolve(argv.out || path.join(ROOT, "data", "raw-specs.json"));
const RETRY = Number(argv.retry || 3);

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ---------- CDP 客户端 ----------
function makeClient(ws) {
  let id = 0; const p = new Map();
  ws.addEventListener("message", ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    p.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = list.filter(t => t.type === "page" && /ebooking|hmall/.test(t.url))[0]
    || list.find(t => t.type === "page");
  if (!page) throw new Error("找不到可用页面：请双击源目录 start.bat 启动调试浏览器");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")));
  });
  return ws;
}

// ---------- 页面内解析函数（注入一次，之后只调 __p） ----------
const PARSE = `(t)=>{
  const code=((t.match(/<code>([^<]*)<\\/code>/)||[])[1]||'').trim();
  if(code!=='200') return {code:code||'ERR'};
  const g=(re,b)=>{const m=(b||t).match(re); return m?(m[1]||'').trim():'';};
  const nm=g(/<name>([^<]*)<\\/name>/);
  if(!nm) return {code:'NO_NAME'};
  const cat=(t.match(/<category>([\\s\\S]*?)<\\/category>/)||[])[1]||'';
  const names=[...cat.matchAll(/<typeName>([^<]*)<\\/typeName>/g)].map(m=>m[1]).filter(Boolean);
  const props=[...t.matchAll(/<productPropertyList>([\\s\\S]*?)<\\/productPropertyList>/g)].map(m=>{
    const b=m[1]||'';
    return [g(/<propertyName>([^<]*)<\\/propertyName>/,b), g(/<value>([^<]*)<\\/value>/,b)];
  }).filter(x=>x[0]);
  const pk=[...t.matchAll(/<packages>([\\s\\S]*?)<\\/packages>/g)].map(m=>{
    const b=m[1]||''; if(b.indexOf('<packageId>')<0) return null;
    const num=s=>String(s||'').replace(/[^0-9.]/g,'');
    const mq=g(/<minQuantity>([^<]*)<\\/minQuantity>/,b);
    return {
      n:  g(/<name>([^<]*)<\\/name>/,b),
      p:  num(g(/<price>([^<]*)<\\/price>/,b)),
      cp: num(g(/<couponPrice>([^<]*)<\\/couponPrice>/,b)),
      pic:g(/<pic>([^<]*)<\\/pic>/,b),
      mq: mq===''?null:(parseFloat(mq)||null),
      mqm:g(/<minQuantityMultiple>([^<]*)<\\/minQuantityMultiple>/,b),
      inv:g(/<inventoryQuantity>([^<]*)<\\/inventoryQuantity>/,b),
      tag:g(/<salesTag>([^<]*)<\\/salesTag>/,b)
    };
  }).filter(Boolean);
  const imgs=[...t.matchAll(/<url>([^<]*(?:dimg|\\.jpg|\\.png|\\.webp)[^<]*)<\\/url>/g)].map(m=>m[1]);
  return {
    code:'200',
    n:nm,
    c:names,
    p:props,
    pk:pk,
    s:g(/<summary>([^<]*)<\\/summary>/),
    sup:g(/<supplierName>([^<]*)<\\/supplierName>/),
    sales:g(/<sales>([^<]*)<\\/sales>/).replace(/[^0-9]/g,''),
    img:imgs.find(u=>/dimg/.test(u))||imgs[0]||(pk[0]&&pk[0].pic)||''
  };
}`;

// ---------- 主流程 ----------
const src = JSON.parse(fs.readFileSync(path.join(SRC, "data", "products.json"), "utf8"));
let ids = Object.keys(src).filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b));
if (LIMIT) ids = ids.slice(0, LIMIT);

let store = { _meta: {}, items: {} };
if (fs.existsSync(OUT)) {
  try { store = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { console.log("旧文件损坏，重新开始"); }
}
if (!store.items) store.items = {};

const doneSet = new Set(Object.keys(store.items));
const todo = ids.filter(id => !doneSet.has(id));
console.log(`总商品 ${ids.length}，已有 ${doneSet.size}，本次待抓 ${todo.length}`);
console.log(`输出：${OUT}`);

const ws = await connect();
const call = makeClient(ws);
await call("Runtime.enable");
const ev = async (expr, awaitP = true) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: awaitP });
  if (r.exceptionDetails) throw new Error("eval: " + String(r.exceptionDetails.text || "").slice(0, 80));
  return r.result && r.result.value;
};

const href = await ev("location.href");
if (/login/i.test(href)) { console.log("❌ 登录已失效，请先在浏览器里登录一次再重跑"); process.exit(2); }
console.log("页面就绪：" + href);
await ev("window.__p=" + PARSE, false);

const fetchOne = async (pid) => {
  for (let a = 0; a < RETRY; a++) {
    try {
      const v = await ev(`(async()=>{try{
        const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),20000);
        const r=await fetch('/hmall/api/product/getProduct',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({productId:'${pid}',country:1,province:null,city:22249,district:null,subDistrict:null,latitude:31.225599,longitude:121.36413}),
          signal:ctl.signal});
        clearTimeout(to);
        const t=await r.text();
        return JSON.stringify(window.__p(t));
      }catch(e){return JSON.stringify({code:'NET'});}})()`);
      const o = JSON.parse(v);
      if (o && o.code && o.code !== "NET") return o;
    } catch { }
    await sleep(500 + a * 700);
  }
  return { code: "FAIL" };
};

const t0 = Date.now();
let idx = 0, ok = 0, notSold = 0, fail = 0, skus = 0, withMq = 0;
const catStat = new Map();

function checkpoint(final = false) {
  store._meta = {
    source: "ebooking hmall getProduct",
    city: 22249,
    startedAt: store._meta.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalPlanned: ids.length,
    totalItems: Object.keys(store.items).length,
    skus, withMq,
    ok200: ok, notSold, fail,
    finished: final
  };
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, OUT);
}

console.log("\n开始抓取…（保持浏览器窗口开着）");
while (idx < todo.length) {
  const batch = todo.slice(idx, idx + CONC);
  idx += batch.length;
  const rs = await Promise.all(batch.map(fetchOne));
  rs.forEach((v, i) => {
    const pid = batch[i];
    store.items[pid] = v;
    if (v.code === "200") {
      ok++;
      skus += (v.pk || []).length;
      if ((v.pk || []).some(x => x.mq != null)) withMq++;
      const leaf = (v.c || [])[(v.c || []).length - 1] || "(无类目)";
      catStat.set(leaf, (catStat.get(leaf) || 0) + 1);
    } else if (v.code === "500") notSold++;
    else fail++;
  });

  if (idx % 200 < CONC || idx === todo.length) {
    const sec = (Date.now() - t0) / 1000;
    const rate = idx / sec;
    const left = Math.round((todo.length - idx) / Math.max(rate, 0.1));
    console.log(`  ${idx}/${todo.length}  成功${ok} 未售卖${notSold} 失败${fail}  SKU${skus}  ` +
      `${rate.toFixed(1)}/s  剩余约${Math.floor(left / 60)}分${left % 60}秒`);
    checkpoint();
  }
}

checkpoint(true);
ws.close();

const sec = Math.round((Date.now() - t0) / 1000);
console.log(`\n===== 抓取完成 =====`);
console.log(`耗时 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒`);
console.log(`商品总数 ${Object.keys(store.items).length}（本次新抓 ${todo.length}）`);
console.log(`成功 code=200：${ok}   不在本城售卖 code=500：${notSold}   失败：${fail}`);
console.log(`套餐行总数 ${skus}，其中带 minQuantity 的商品 ${withMq}`);
console.log(`输出文件 ${OUT}`);

const top = [...catStat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
if (top.length) {
  console.log("\n本次覆盖类目 TOP14：");
  top.forEach(([k, v]) => console.log("  " + k.padEnd(18) + v));
}
