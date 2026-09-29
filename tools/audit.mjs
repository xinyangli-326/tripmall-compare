// 全库自检：把可疑的折算/分类都挖出来，写成 work/audit.md
// 用法：node tools/audit.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadRaw, foldSku, baseOf, cleanCat, classifyRow, isAccessoryTier, parseMult, parseContent, ACC_RE, ACC_WEAK_RE, WEAK_ACC_CATS, sharesLong } from "./fold.mjs";

const raw = loadRaw();
const ids = Object.keys(raw);
const out = [];
const P = (...a) => out.push(a.join(" "));

// 先按商品聚合
const prods = new Map();     // pid -> {name, cat, sup, tiers:[{spec,price,mq,cls,N,fold}]}
for (const pid of ids) {
  const v = raw[pid] || {};
  if (v.code !== "200") continue;
  const cc = cleanCat(v.c);
  const t = { pid, name: v.n || "", cat: cc.leaf, sup: v.sup || "", trialOnly: cc.trialOnly, tiers: [] };
  for (const x of (v.pk || [])) {
    const cls = cc.trialOnly ? "trial" : classifyRow(x.n, x.p);
    t.tiers.push({ spec: x.n || "", price: parseFloat(x.p) || 0, mq: x.mq, cls, N: parseMult(x.n || "") });
  }
  prods.set(pid, t);
}

/* ============ 1. 同商品内换算单价离散度 ============ */
P("# 全库自检报告", "");
P("商品数 " + prods.size, "");
P("## 1. 同商品内换算单价差异过大（>8×）—— 多半是某个档位口径错了", "");
let c1 = 0; const rows1 = [];
for (const t of prods.values()) {
  if (t.trialOnly) continue;
  const rank = t.tiers.filter(x => x.cls === "ok").map(x => ({ ...x, f: foldSku(t.cat, x.spec, x.price, x.mq) })).filter(x => x.f.rankable);
  if (rank.length < 2) continue;
  const vs = rank.map(x => x.f.value);
  const mn = Math.min(...vs), mx = Math.max(...vs);
  if (!(mn > 0) || mx / mn < 8) continue;
  c1++;
  if (rows1.length < 120) rows1.push({ t, mn, mx, rank: rank.sort((a, b) => a.f.value - b.f.value) });
}
P("命中 " + c1 + " 个商品", "");
rows1.slice(0, 40).forEach(({ t, mn, mx, rank }) => {
  P("- 【" + t.cat + "】" + t.name.slice(0, 30) + "  (差 " + (mx / mn).toFixed(1) + "×)");
  rank.slice(0, 5).forEach(x => P("    " + x.f.value.toFixed(4) + "  ¥" + x.price + " 起订" + x.mq + " 量N=" + x.N + " | " + x.spec.slice(0, 36)));
});

/* ============ 2. 疑似漏判的配件档 ============ */
P("", "## 2. 档位名像配件、但没被降级（可能漏判）", "");
const accWords = /支架|挂架|底座|配件|电池|充电线|数据线|滤芯|滤网|遥控器|耗材|补充装|替换装/;
let c2 = 0; const rows2 = [];
for (const t of prods.values()) {
  if (t.trialOnly) continue;
  const mains = t.tiers.filter(x => x.cls === "ok" && !isAccessoryTier(x.spec, t.name, t.cat));
  const maybe = t.tiers.filter(x => x.cls === "ok" && accWords.test(x.spec) && !isAccessoryTier(x.spec, t.name, t.cat));
  if (!maybe.length || !mains.length) continue;
  for (const x of maybe) {
    const f = foldSku(t.cat, x.spec, x.price, x.mq);
    const mf = mains.map(m => foldSku(t.cat, m.spec, m.price, m.mq)).filter(z => z.rankable).map(z => z.value);
    if (!f.rankable || !mf.length) continue;
    const med = mf.sort((a, b) => a - b)[Math.floor(mf.length / 2)];
    if (med > 0 && f.value < med / 3) {     // 明显低于同商品主体价 → 疑似配件漏判
      c2++;
      if (rows2.length < 80) rows2.push({ t, x, f, med });
    }
  }
}
P("命中 " + c2 + " 行", "");
rows2.slice(0, 50).forEach(({ t, x, f, med }) =>
  P("- 【" + t.cat + "】" + t.name.slice(0, 26) + "  配件?" + f.value.toFixed(4) + " vs 主体中位 " + med.toFixed(4) + " | " + x.spec.slice(0, 36)));

/* ============ 3. 单位与品类基准冲突 ============ */
P("", "## 3. 品类基准与实际解析量纲冲突", "");
const c3 = { ml100_but_g: 0, g100_but_ml: 0 };
const rows3 = [];
for (const t of prods.values()) {
  if (t.trialOnly) continue;
  const bc = baseOf(t.cat).code;
  for (const x of t.tiers) {
    if (x.cls !== "ok") continue;
    const c = parseContent(x.spec);
    if (!c) continue;
    if (bc === "ml100" && c.u === "g") { c3.ml100_but_g++; if (rows3.length < 30) rows3.push("【" + t.cat + "】" + x.spec.slice(0, 40)); }
    if (bc === "g100" && c.u === "ml") { c3.g100_but_ml++; if (rows3.length < 30) rows3.push("【" + t.cat + "】" + x.spec.slice(0, 40)); }
  }
}
P("元/100ml 品类里按克解析：" + c3.ml100_but_g + " 行；元/100g 品类里按毫升解析：" + c3.g100_but_ml + " 行（洗发水按克是常见写法，一般可接受）");
rows3.slice(0, 12).forEach(x => P("- " + x));

/* ============ 4. 规格量 N 疑似误读（尺寸/支数/床数） ============ */
P("", "## 4. 疑似把尺寸/支数/床数当成包装量 N", "");
const rows4 = [];
for (const t of prods.values()) {
  if (t.trialOnly) continue;
  for (const x of t.tiers) {
    if (x.cls !== "ok" || x.N == null) continue;
    const s = x.spec;
    if (/\d+\s*[*×xX]\s*\d+\s*支/.test(s) || /支\s*$/.test(x.N + "") === false && false) { }
    if (/\d+\s*[*×xX]\s*\d+\s*支/.test(s) || /\d+\.?\d*\s*床/.test(s) || /\d+\s*[Ss]\b/.test(s)) {
      rows4.push("【" + t.cat + "】N=" + x.N + " mq=" + x.mq + " | " + s.slice(0, 44));
    }
  }
}
P("命中 " + rows4.length + " 行（例：60*40支 → 把 40 当包装量）");
[...new Set(rows4)].slice(0, 30).forEach(x => P("- " + x));

/* ============ 5. 品类最低价是否由可疑档位拿下 ============ */
P("", "## 5. 各品类最低价档位抽样核对", "");
const byCat = new Map();
for (const t of prods.values()) {
  if (t.trialOnly) continue;
  for (const x of t.tiers) {
    if (x.cls !== "ok") continue;
    const f = foldSku(t.cat, x.spec, x.price, x.mq);
    if (!f.rankable) continue;
    if (!byCat.has(t.cat)) byCat.set(t.cat, []);
    byCat.get(t.cat).push({ t, x, v: f.value });
  }
}
const cats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [cat, arr] of cats.slice(0, 40)) {
  const lo = arr.reduce((a, b) => a.v <= b.v ? a : b);
  P("- " + cat + "  最低 " + lo.v.toFixed(4) + " | " + lo.t.sup.slice(0, 12) + " | " + lo.x.spec.slice(0, 40));
}

fs.writeFileSync(path.join(ROOT, "work", "audit.md"), out.join("\n"));
console.log("written work/audit.md  (" + out.length + " lines)");
console.log(out.slice(0, 20).join("\n"));
