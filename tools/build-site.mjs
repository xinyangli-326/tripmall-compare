// 由原始抓取数据生成站点数据：data/site-summary.json + data/site-rows.json
// 用法：node tools/build-site.mjs [--raw=path]
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadRaw, loadProducts, foldSku, baseOf, cleanCat, classifyRow, specKey, parseMult, parseContent, isAccessoryTier } from "./fold.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));

const raw = loadRaw(argv.raw);
const db = loadProducts();
const ids = Object.keys(raw);

// 支付方式（免房/预付分期/客房分成/0元购），来自 tools/fetch-pay.mjs
let PAY = {}, PAYMETA = {};
try {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw-pay.json"), "utf8"));
  PAY = j.items || {}; PAYMETA = j._meta || {};
} catch { console.log("（没有 raw-pay.json，跳过支付方式）"); }

const catList = [], catIdx = new Map();
const catLv2 = new Map();       // leaf -> 二级类目 "客房用品 > 一次性耗品"
const supList = [], supIdx = new Map();
const prods = [];               // [name, supI, catI, img, sales]
const prodIdx = new Map();
const rows = [];                // [prodI, spec, price, cp, mq, unitVal, kind]
const trialProd = new Set();
const tags = [];                // [prodI, 营销标签名]

const cid = n => { if (!catIdx.has(n)) { catIdx.set(n, catList.length); catList.push(n); } return catIdx.get(n); };
const sid = n => { n = n || "(未知供应商)"; if (!supIdx.has(n)) { supIdx.set(n, supList.length); supList.push(n); } return supIdx.get(n); };

const stats = { products: 0, skus: 0, rankable: 0, trial: 0, nonGoods: 0, manual: 0, notSold: 0, noData: 0, accessory: 0 };

// ===== 预扫：每个商品的「单件价参照」（只用无歧义的档位：规格名无量，或 规格量=起订量）=====
const refByProd = new Map();
for (const pid of ids) {
  const v = raw[pid] || {};
  if (v.code !== "200") continue;
  const ps = [];
  for (const x of (v.pk || [])) {
    if (classifyRow(x.n, x.p) !== "ok") continue;
    const N = parseMult(x.n), mq = x.mq;
    if (N == null || (mq != null && N === mq)) {
      const p = parseFloat(x.p);
      if (isFinite(p) && p > 0) ps.push(p);
    }
  }
  if (ps.length) { ps.sort((a, b) => a - b); refByProd.set(pid, ps[Math.floor(ps.length / 2)]); }
}

for (const pid of ids) {
  const v = raw[pid] || {};
  if (v.code !== "200") { if (v.code === "500") stats.notSold++; else stats.noData++; continue; }
  const cc = cleanCat(v.c);
  const cI = cid(cc.leaf);
  if (!catLv2.has(cc.leaf)) {
    const raw = (v.c || []).map(x => String(x || "").trim()).filter(Boolean);
    catLv2.set(cc.leaf, raw.length >= 2 ? raw[0] + " > " + raw[1] : "其他");
  }
  const sI = sid(v.sup || (db[pid] && db[pid].supplier));
  const base = baseOf(cc.leaf);
  const pI = prods.length;
  // [名称, 供应商, 品类, 图, 销量, 携程商品ID, 支付方式位串, 适用酒店星级]
  const p = PAY[pid] || {};
  const payBits = (p.freeRoom ? "1" : "0") + (p.prepay ? "1" : "0") + (p.commission ? "1" : "0") + (p.zeroBuy ? "1" : "0");
  const starProp = (v.p || []).find(x => /适用酒店/.test(String(x[0] || "")));
  const star = starProp ? String(starProp[1] || "").trim() : "";
  prods.push([(db[pid] && db[pid].name) || v.n, sI, cI, v.img || (db[pid] && db[pid].image) || "", v.sales || (db[pid] && db[pid].sales) || "", pid, payBits, star, 0]);
  prodIdx.set(pid, pI);
  if (cc.tags.length) tags.push([pI, cc.tags[0]]);
  stats.products++;

  for (const x of (v.pk || [])) {
    stats.skus++;
    // 试用专区整类不参与比价
    const cls = cc.trialOnly ? "trial" : classifyRow(x.n, x.p);
    if (cls === "trial") { stats.trial++; trialProd.add(pI); rows.push([pI, x.n, x.p, x.cp || "", x.mq, null, "trial", null, x.pic || ""]); continue; }
    if (cls === "nonGoods") { stats.nonGoods++; rows.push([pI, x.n, x.p, x.cp || "", x.mq, null, "nonGoods", null, x.pic || ""]); continue; }
    const f = foldSku(cc.leaf, x.n, x.p, x.mq, refByProd.get(pid));
    // 行结构：[商品, 规格名, 接口原价, 券后价, 起订量, 换算单价, 类型, 每件实际价, 档位图]
    if (f.rankable) { stats.rankable++; rows.push([pI, x.n, x.p, x.cp || "", x.mq, +f.value.toFixed(6), "rank", +f.perPiece.toFixed(6), x.pic || ""]); }
    else { stats.manual++; rows.push([pI, x.n, x.p, x.cp || "", x.mq, null, "manual", null, x.pic || ""]); }
  }
}

// 商品级：最低折算单价 / 是否有可比价行
/* ---------- 配件档排查：只在「同一商品里既有配件又有主体」时才降级配件 ---------- */
const byProdRows = new Map();          // prodI -> [rowIdx]
for (let i = 0; i < rows.length; i++) {
  const p = rows[i][0];
  if (!byProdRows.has(p)) byProdRows.set(p, []);
  byProdRows.get(p).push(i);
}
const accAudit = [];
let accChanged = 0;
for (const [pI, idxs] of byProdRows) {
  const acc = [], main = [];
  for (const i of idxs) {
    const r = rows[i];
    if (r[6] !== "rank" && r[6] !== "manual") continue;   // 拿样/差价档不参与
    (isAccessoryTier(r[1], prods[pI][0], catList[prods[pI][2]]) ? acc : main).push(i);
  }
  if (!acc.length || !main.length) continue;               // 整件商品都是配件 → 它本身就是主体，不动
  for (const i of acc) {
    const r = rows[i];
    if (r[6] === "rank") { stats.rankable--; stats.accessory++; }
    else stats.manual--;
    r[6] = "accessory";
    accChanged++;
  }
  if (accAudit.length < 3000)
    accAudit.push({ p: prods[pI][5], name: prods[pI][0].slice(0, 28), cat: catList[prods[pI][2]],
      acc: acc.map(i => rows[i][1].slice(0, 22) + " ¥" + rows[i][2]),
      mainMin: Math.min.apply(null, main.map(i => rows[i][5] == null ? 1e9 : rows[i][5])) });
}

const prodMin = new Array(prods.length).fill(null);
const prodBase = new Array(prods.length).fill("");
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r[6] !== "rank") continue;
  if (prodMin[r[0]] == null || r[5] < prodMin[r[0]]) prodMin[r[0]] = r[5];
}
for (let i = 0; i < prods.length; i++) prodBase[i] = baseOf(catList[prods[i][2]]).label;

// 类目 × 供应商 聚合
const catAgg = catList.map(() => new Map());
const specCounter = catList.map(() => new Map());          // cat -> sup -> Map(specKey->count)
const catStats = catList.map(() => ({ skus: 0, rankable: 0, trial: 0, sups: new Set(), min: null }));
const supStat = supList.map(() => ({ catSet: new Set(), skus: 0, prods: 0, trial: 0 }));

for (let i = 0; i < prods.length; i++) {
  const p = prods[i], cI = p[2], sI = p[1];
  catStats[cI].sups.add(sI);
  supStat[sI].prods++; supStat[sI].catSet.add(cI);
  if (trialProd.has(i)) supStat[sI].trial++;
}

for (let i = 0; i < rows.length; i++) {
  const [pI, spec, price, cp, mq, val, kind] = rows[i];
  const p = prods[pI], cI = p[2], sI = p[1];
  catStats[cI].skus++; supStat[sI].skus++;
  if (kind === "trial") { catStats[cI].trial++; continue; }
  if (kind !== "rank") continue;
  catStats[cI].rankable++;
  if (catStats[cI].min == null || val < catStats[cI].min) catStats[cI].min = val;

  // 供应商在类目内的聚合
  let agg = catAgg[cI].get(sI);
  if (!agg) { agg = { min: null, skus: 0, prods: new Set(), bestP: -1, lowest: null }; catAgg[cI].set(sI, agg); }
  agg.skus++; agg.prods.add(pI);
  if (agg.min == null || val < agg.min) { agg.min = val; agg.bestP = pI; agg.lowest = { spec, price, mq, val }; }
  const k = specKey(spec, baseOf(catList[cI]).code);
  if (k) {
    let m = specCounter[cI].get(sI); if (!m) { m = new Map(); specCounter[cI].set(sI, m); }
    m.set(k, (m.get(k) || 0) + 1);
  }
}

// 类目 -> 可比价行索引（用于分位数）
const catRows = new Map();
for (let i = 0; i < rows.length; i++) {
  if (rows[i][6] !== "rank") continue;
  const cI = prods[rows[i][0]][2];
  if (!catRows.has(cI)) catRows.set(cI, []);
  catRows.get(cI).push(i);
}

const summary = {
  generatedAt: new Date().toISOString(),
  city: 22249,
  pay: { freeRoom: PAYMETA.stat ? PAYMETA.stat.freeRoom : 0, prepay: PAYMETA.stat ? PAYMETA.stat.prepay : 0,
         commission: PAYMETA.stat ? PAYMETA.stat.commission : 0, zeroBuy: PAYMETA.stat ? PAYMETA.stat.zeroBuy : 0,
         checked: PAYMETA.done || 0 },
  stats: { ...stats, products: stats.products, suppliers: supList.length, categories: catList.length },
  cats: catList.map((leaf, i) => {
    const st = catStats[i];
    const sups = [...catAgg[i].entries()].map(([sI, a]) => {
      const sp = specCounter[i].get(sI);
      const common = sp ? [...sp.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(x => x[0]) : [];
      const bp = a.bestP;
      return {
        s: sI, prods: a.prods.size, skus: a.skus, min: a.min,
        best: bp >= 0 ? { n: prods[bp][0], img: prods[bp][3], spec: a.lowest.spec, price: a.lowest.price, mq: a.lowest.mq } : null,
        common
      };
    }).sort((x, y) => (x.min ?? 1e9) - (y.min ?? 1e9));
    // 价差：用 SKU 级 P90/P10，避免被"定制服务"这类极端值带偏
    const vs = [];
    for (const ri of (catRows.get(i) || [])) { const v = rows[ri][5]; if (v != null) vs.push(v); }
    vs.sort((a, b) => a - b);
    const qf = p => vs.length ? vs[Math.min(vs.length - 1, Math.floor(vs.length * p))] : null;
    const spread = (vs.length >= 8 && qf(0.1) > 0) ? qf(0.9) / qf(0.1) : null;
    const spreadFull = vs.length >= 2 ? vs[vs.length - 1] / vs[0] : null;
    const p50 = qf(0.5);
    // 每个品类自带：代表图 / 是否有特殊支付 / 是否小批量可买 / 出现过的星级（供导航筛选，免加载明细）
    let thumb = "", hasPay = false, cheapStart = false;
    const starSet = new Set();
    for (const ri of (catRows.get(i) || [])) {
      const r = rows[ri], P = prods[r[0]];
      if (!thumb && P[3]) thumb = P[3];
      if (/[1]/.test(P[6] || "0000")) hasPay = true;
      if (r[6] === "rank" && r[4] != null && Number(r[4]) <= 50) cheapStart = true;
      if (P[7]) starSet.add(P[7]);
    }
    if (!thumb && sups.length && sups[0].best && sups[0].best.img) thumb = sups[0].best.img;
    return { i, leaf, lv2: catLv2.get(leaf) || "其他", base: baseOf(leaf).label, baseCode: baseOf(leaf).code,
      sups: st.sups.size, skus: st.skus, rankable: st.rankable, trial: st.trial, min: st.min,
      spread, spreadFull, p50, rows: sups, thumb, hasPay, cheapStart, stars: [...starSet] };
  }),
  sups: supList.map((name, i) => ({ name, prods: supStat[i].prods, skus: supStat[i].skus, cats: supStat[i].catSet.size, trial: supStat[i].trial })),
};

// 展示顺序按"能比价的规格数"降序；c.i 永远是原始编号，与 site-rows 的行索引保持一致
summary.cats.sort((a, b) => b.rankable - a.rankable);

/* ---------- 分片输出：首屏只加载汇总，每个品类一个小文件 ---------- */
const outDir = path.join(ROOT, "data");
const catDir = path.join(outDir, "cat");
fs.mkdirSync(catDir, { recursive: true });

// 每个品类：它自己的商品 + 行
const byCatRows = new Map(), byCatProds = new Map();
for (let i = 0; i < rows.length; i++) {
  const ci = prods[rows[i][0]][2];
  if (!byCatRows.has(ci)) { byCatRows.set(ci, []); byCatProds.set(ci, new Set()); }
  byCatRows.get(ci).push(rows[i]);
  byCatProds.get(ci).add(rows[i][0]);
}
let catBytes = 0, maxBytes = 0, maxCi = 0;
for (let ci = 0; ci < catList.length; ci++) {
  const rs = byCatRows.get(ci) || [];
  const pset = byCatProds.get(ci) || new Set();
  const pobj = {}; pset.forEach(pi => pobj[pi] = prods[pi]);
  const tp = [...trialProd].filter(pi => pset.has(pi));
  const p = path.join(catDir, ci + ".json");
  fs.writeFileSync(p, JSON.stringify({ prods: pobj, rows: rs, trialProd: tp }));
  const sz = fs.statSync(p).size; catBytes += sz;
  if (sz > maxBytes) { maxBytes = sz; maxCi = ci; }
}

// 搜索索引：商品名（紧凑 TSV，后台加载）。规格名搜索在品类内做，避免索引过大
const idxLines = [];
prods.forEach((P, pi) => { if (P[0]) idxLines.push(P[0] + "\t" + P[2] + "\t" + P[1] + "\t" + pi); });
fs.writeFileSync(path.join(outDir, "search.txt"), idxLines.join("\n"));

const w = (f, o) => { const p = path.join(outDir, f); fs.writeFileSync(p, JSON.stringify(o)); return [f, (fs.statSync(p).size / 1048576).toFixed(2) + "MB"]; };
const a = w("site-summary.json", summary);
const b = ["search.txt", (fs.statSync(path.join(outDir, "search.txt")).size / 1048576).toFixed(2) + "MB"];
fs.writeFileSync(path.join(outDir, "site-rows.json"), JSON.stringify({
  cats: catList, sups: supList, prods, rows, trialProd: [...trialProd], tags
}));   // 仍保留全量单文件，供本地/全量分析用（网页不再加载它）

console.log("===== 站点数据已生成 =====");
console.log(JSON.stringify(summary.stats, null, 1));
console.log(`${a[0]}  ${a[1]}    ← 首屏只加载这个`);
console.log(`data/cat/  ${catList.length} 个文件  平均 ${(catBytes / catList.length / 1024).toFixed(0)}KB  最大 ${(maxBytes / 1024).toFixed(0)}KB(${catList[maxCi]})`);
console.log(`${b[0]}  ${b[1]}    ← 全局搜索索引（后台加载）`);
console.log("\n类目 TOP10（按可比价行数）：");
summary.cats.slice(0, 10).forEach(c => console.log("  " + c.leaf.padEnd(14) + c.base.padEnd(9) + " 供应商" + String(c.sups).padStart(3) + " 可比价行" + String(c.rankable).padStart(5) + " 最低" + (c.min == null ? "-" : c.min.toFixed(4))));

/* ---------- 配件档审计：人工核对有没有误判 ---------- */
/* ---------- 校准审计：mq=1 且规格带 N 的档位，被判定为「单件价」还是「整包价」 ---------- */
const calAudit = [];
for (const pid of ids) {
  const v = raw[pid] || {}; if (v.code !== "200") continue;
  const ref = refByProd.get(pid);
  if (ref == null) continue;
  const hits = [];
  for (const x of (v.pk || [])) {
    if (classifyRow(x.n, x.p) !== "ok") continue;
    const N = parseMult(x.n), mq = x.mq, p = parseFloat(x.p);
    if (!(mq === 1 && N != null && N > 1 && isFinite(p) && p > 0)) continue;
    const asItem = Math.abs(p - ref) / ref, asPack = Math.abs(p / N - ref) / ref;
    hits.push({ spec: x.n.slice(0, 30), price: p, N, ref, pick: asItem <= asPack ? "单件价" : "整包价",
      item: p, pack: +(p / N).toFixed(4) });
  }
  if (hits.length) calAudit.push({ p: prods[prods.findIndex(x => x[5] === pid)][0].slice(0, 26), ref, hits });
}
console.log("\n====== 校准审计：起订1+规格带N 的档位判成什么（共 " + calAudit.length + " 个商品）======");
const pickCount = { 单件价: 0, 整包价: 0 };
calAudit.forEach(a => a.hits.forEach(h => pickCount[h.pick]++));
console.log("  判为单件价 (不÷N) = " + pickCount.单件价 + "   判为整包价 (÷N) = " + pickCount.整包价);
console.log("  样例：");
calAudit.slice(0, 18).forEach(a => a.hits.slice(0, 2).forEach(h =>
  console.log("   [" + h.pick + "] 参照" + h.ref + " | ¥" + h.price + " 规格量" + h.N + " → 单件¥" + h.item + " / 整包后¥" + h.pack + " | " + h.spec)));

console.log("\n====== 配件档审计（降级了 " + accChanged + " 行，涉及 " + accAudit.length + " 个商品）======");
const byCatAcc = new Map();
accAudit.forEach(a => byCatAcc.set(a.cat, (byCatAcc.get(a.cat) || 0) + 1));
console.log("涉及品类 TOP15：");
[...byCatAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log("  " + k.padEnd(16) + v));
console.log("\n全部样例（请核对降级的确实是配件、保留的才是主体）：");
accAudit.slice(0, 60).forEach(a => {
  console.log("  【" + a.cat + "】" + a.name);
  console.log("      降级为配件: " + a.acc.join(" / "));
  console.log("      保留主体最低: " + (a.mainMin < 1e9 ? a.mainMin.toFixed(4) : "-"));
});
