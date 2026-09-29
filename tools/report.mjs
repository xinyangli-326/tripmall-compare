// 折算验证报告：node tools/report.mjs [--top=12]
import { loadRaw, loadProducts, foldSku, baseOf, cleanCat, isTrial, parseMult } from "./fold.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));
const TOP = Number(argv.top || 12);

const raw = loadRaw(argv.raw);
const db = loadProducts();
const ids = Object.keys(raw);
console.log("原始数据商品数 = " + ids.length + "\n");

const stat = { sku: 0, trial: 0, rankable: 0, noRank: 0, noMq: 0 };
const failReason = new Map();
const perCat = new Map();   // leaf -> {base, sku, trial, rankable, noRank, rows:[{sup,item,spec,price,mq,val,reason}]}
const prodTrial = new Set();

for (const pid of ids) {
  const v = raw[pid] || {};
  if (v.code !== "200") { if (v.code === "500") stat.noMq++; continue; }
  const { leaf, trialOnly } = cleanCat(v.c);
  const sup = v.sup || (db[pid] && db[pid].supplier) || "(未知)";
  const pk = (v.pk || []);
  const base = baseOf(leaf);
  let entry = perCat.get(leaf);
  if (!entry) { entry = { base, sku: 0, trial: 0, rankable: 0, noRank: 0, rows: [] }; perCat.set(leaf, entry); }
  let anyTrial = false;
  for (const x of pk) {
    stat.sku++; entry.sku++;
    const t = trialOnly || isTrial(x.n, x.p);
    if (t) { stat.trial++; entry.trial++; anyTrial = true; continue; }
    const f = foldSku(leaf, x.n, x.p, x.mq);
    if (f.rankable) {
      stat.rankable++; entry.rankable++;
      entry.rows.push({ sup, item: (db[pid] && db[pid].name) || v.n, id: pid, spec: x.n, price: x.p, cp: x.cp, mq: x.mq, val: f.value, label: f.label, basis: f.basis });
    } else {
      stat.noRank++; entry.noRank++;
      failReason.set(f.reason, (failReason.get(f.reason) || 0) + 1);
      if (entry.rows.length < 400) entry.rows.push({ sup, item: (db[pid] && db[pid].name) || v.n, id: pid, spec: x.n, price: x.p, cp: x.cp, mq: x.mq, val: null, label: "按件", reason: f.reason });
    }
  }
  if (anyTrial) prodTrial.add(pid);
}

console.log("===== 总览 =====");
console.log(`套餐行总数        ${stat.sku}`);
console.log(`  拿样/试用档     ${stat.trial}  (${(stat.trial / stat.sku * 100).toFixed(1)}%)  → 不进比价，商品挂「可0元试用」`);
console.log(`  可比价行        ${stat.rankable}  (${(stat.rankable / stat.sku * 100).toFixed(1)}%)`);
console.log(`  按件不参与排名   ${stat.noRank}  (${(stat.noRank / stat.sku * 100).toFixed(1)}%)`);
console.log(`标记「可0元试用」的商品 = ${prodTrial.size}`);

// 试用档触发原因拆分（确认没有正则过度匹配）
const trigger = { "名称关键词": 0, "价格0.01或0.02": 0, "试用专区类目": 0 };
for (const pid of ids) {
  const v = raw[pid] || {}; if (v.code !== "200") continue;
  const tOnly = cleanCat(v.c).trialOnly;
  for (const x of (v.pk || [])) {
    const byName = /样品|拿样|寄样|试用|试样|体验装|专拍|补差|运费|邮费|一分|咨询|改价/.test(x.n || "");
    const p = parseFloat(x.p);
    const byPrice = isFinite(p) && p > 0 && p <= 0.02;
    if (tOnly) trigger["试用专区类目"]++;
    else if (byName) trigger["名称关键词"]++;
    else if (byPrice) trigger["价格0.01或0.02"]++;
  }
}
console.log("  触发原因：" + Object.entries(trigger).map(([k, v]) => k + " " + v).join("  |  "));

console.log("\n===== 不参与排名的原因分布 =====");
[...failReason.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log("  " + String(v).padStart(6) + "  " + k));

const cats = [...perCat.entries()].filter(([, e]) => e.rankable > 0)
  .sort((a, b) => b[1].rankable - a[1].rankable);
console.log("\n===== 可折算类目：" + cats.length + " 个（按可比价行数排序，前 " + TOP + "）=====");
console.log("类目".padEnd(16) + "基准".padEnd(10) + "行数".padStart(7) + "可折算".padStart(8) + "按件".padStart(7) + "试用".padStart(7) + "  可折算率");
cats.slice(0, TOP).forEach(([k, e]) => {
  console.log(k.padEnd(16) + e.base.label.padEnd(10) +
    String(e.sku).padStart(7) + String(e.rankable).padStart(8) + String(e.noRank).padStart(7) + String(e.trial).padStart(7) +
    "  " + (e.rankable / e.sku * 100).toFixed(0) + "%");
});

// 逐类目抽查：每个供应商的最低价 + 全局最低 5 行
console.log("\n\n★★★★★ 人工抽查：各类目最低价 TOP5（请逐条核对是否合理）★★★★★");
for (const [k, e] of cats.slice(0, TOP)) {
  const ranked = e.rows.filter(r => r.val != null).sort((a, b) => a.val - b.val);
  console.log("\n── " + k + "  [" + e.base.label + "]  可比价 " + e.rankable + " 行");
  ranked.slice(0, 5).forEach(r => {
    console.log("   " + r.val.toFixed(4).padStart(10) + " " + e.base.label.padEnd(9) +
      " ¥" + String(r.price).padEnd(8) + " 起订" + String(r.mq == null ? "-" : r.mq).padEnd(6) +
      " | " + r.sup.slice(0, 14).padEnd(16) + " | " + r.spec.slice(0, 40));
  });
}

// 异常检查
console.log("\n\n===== 异常自查 =====");
const allRanked = [];
for (const [k, e] of cats) for (const r of e.rows) if (r.val != null) allRanked.push({ cat: k, ...r });
allRanked.sort((a, b) => a.val - b.val);
console.log("-- 折算单价最低 8 行（检查是否有异常小值）--");
allRanked.slice(0, 8).forEach(r => console.log("   " + r.val.toFixed(5).padStart(12) + " " + r.label.padEnd(9) + " ¥" + r.price + " 起订" + r.mq + " | " + r.cat + " | " + r.spec.slice(0, 42)));
console.log("-- 折算单价最高 5 行 --");
allRanked.slice(-5).reverse().forEach(r => console.log("   " + r.val.toFixed(2).padStart(12) + " " + r.label.padEnd(9) + " ¥" + r.price + " 起订" + r.mq + " | " + r.cat + " | " + r.spec.slice(0, 42)));

// 同类目内价差
console.log("\n-- 同类目内 最高/最低 折算单价倍数 ≥5 的（同基准才算）--");
const spread = cats.map(([k, e]) => {
  const vs = e.rows.filter(r => r.val != null).map(r => r.val);
  if (vs.length < 4) return null;
  const mn = Math.min(...vs), mx = Math.max(...vs);
  return { k, mn, mx, label: e.base.label, ratio: mx / mn, n: vs.length };
}).filter(Boolean).filter(x => x.ratio >= 5).sort((a, b) => b.ratio - a.ratio);
spread.slice(0, 12).forEach(x => console.log("   " + x.k.padEnd(16) + x.label.padEnd(9) + " 最低" + x.mn.toFixed(3) + " 最高" + x.mx.toFixed(3) + "  = " + x.ratio.toFixed(1) + "x  (" + x.n + "行)"));
console.log("\n价差≥5倍的类目共 " + spread.length + " 个");

// ---------- 审计：把方案 4.1 的「N > minQuantity → 包装量」分支收窄到 minQuantity===1，是否站得住？ ----------
console.log("\n\n===== 审计：minQuantity>1 且 规格量>起订量 的行，实际是单价还是整包价？=====");
const audit = { 单价: 0, 整包价: 0, 不明: 0, 无基准: 0 };
const auditSample = { 单价: [], 整包价: [], 不明: [] };
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const pid of ids) {
  const v = raw[pid] || {}; if (v.code !== "200") continue;
  if (cleanCat(v.c).trialOnly) continue;
  const rows = (v.pk || []).filter(x => !isTrial(x.n, x.p) && parseFloat(x.p) > 0)
    .map(x => ({ n: x.n, p: parseFloat(x.p), mq: x.mq, N: parseMult(x.n) }));
  const ref = rows.filter(r => r.N == null || (r.mq != null && r.N === r.mq)).map(r => r.p);
  const sus = rows.filter(r => r.mq != null && r.mq > 1 && r.N != null && r.N > r.mq);
  if (!sus.length) continue;
  if (ref.length < 2) { audit.无基准 += sus.length; continue; }
  const scale = med(ref);
  for (const r of sus) {
    const asUnit = Math.abs(r.p - scale) / scale;
    const asPack = Math.abs(r.p / r.N - scale) / scale;
    if (asUnit <= 0.6 && asUnit <= asPack) {
      audit.单价++;
      if (auditSample.单价.length < 5) auditSample.单价.push(`¥${r.p} 起订${r.mq} 规格量${r.N} | 同商品单价基准¥${scale} | ${r.n.slice(0, 40)}`);
    } else if (asPack < asUnit) {
      audit.整包价++;
      if (auditSample.整包价.length < 5) auditSample.整包价.push(`¥${r.p} 起订${r.mq} 规格量${r.N} | 同商品单价基准¥${scale} | ${r.n.slice(0, 40)}`);
    } else {
      audit.不明++;
      if (auditSample.不明.length < 5) auditSample.不明.push(`¥${r.p} 起订${r.mq} 规格量${r.N} | 同商品单价基准¥${scale} | ${r.n.slice(0, 40)}`);
    }
  }
}
console.log("  判为「单价」（= 我采用的规则）  = " + audit.单价);
console.log("  判为「整包价」（若按原方案 ÷N） = " + audit.整包价 + "   ← 这个数若很大，说明收窄条件不对");
console.log("  口径不明                        = " + audit.不明);
console.log("  同商品内无基准，无法判定          = " + audit.无基准);
for (const k of ["整包价", "不明"]) {
  if (auditSample[k].length) {
    console.log("  [" + k + "] 样例：");
    auditSample[k].forEach(s => console.log("     " + s));
  }
}
