// 折算引擎：规格名 + 起订量 → 可比单价
//   node tools/fold.mjs report   → 折算验证报告
//   node tools/fold.mjs build    → 生成站点数据
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
export const SRC = "C:\\Users\\yuri0618\\Documents\\Codex\\2026-09-02\\tripmall-c-users-yuri0618-documents-codex";

// ---------- 1. 样品/试用档：不进比价，改挂「可0元试用」标记 ----------
// 方案原名单 + 实测补漏（拿样 / 寄样 / 体验装），不加裸「样」以免误杀「花样/式样」
export const TRIAL_RE = /样品|拿样|寄样|试用|试样|体验装|补差|运费|邮费|一分|咨询|改价/;
export function isTrial(name, price) {
  if (TRIAL_RE.test(String(name || ""))) return true;
  const p = parseFloat(price);
  return isFinite(p) && p > 0 && p <= 0.02;   // 实测：¥0.01/0.02 档全部是拿样
}

// 非商品档：差价 / 协议价 / 专拍 / 店铺公告 —— 同样不进比价，但**不挂**「可0元试用」
// 注意「专拍」要放这里：有卖家拿它挂 ¥7000 的定制单，标成"可0元试用"是错的
export const NONGOODS_RE = /差价|路费|协议价|请勿直接拍|勿拍|专拍|押金|定金|补款|改价链接|占位/;
// 店铺公告 / 发货通知（例：国庆期间1-5号休息 6号开始发货）
export const NOTICE_RE = /(期间|假期|节假).{0,12}(休息|放假|不发货|发货)|休息.{0,10}(发货|放假)|放假.{0,10}发货|停发|恢复发货|开始发货|发货时间|暂停发货|排班|排单|歇业|请假/;
export function isNonGoods(name, price) {
  const n = String(name || "");
  if (NONGOODS_RE.test(n) || NOTICE_RE.test(n)) return true;
  const p = parseFloat(price);
  return isFinite(p) && p >= 999999;          // 占位价
}

/** 行分类：trial（可0元试用） | nonGoods（非商品） | ok */
export function classifyRow(name, price) {
  if (isTrial(name, price)) return "trial";
  if (isNonGoods(name, price)) return "nonGoods";
  return "ok";
}

/* ---------- 配件档：同一商品里混进来的电池/线材/滤芯等，不能当主体比价 ---------- */
// 只收「几乎不可能是酒店采购主体」的词，宁少勿滥
/* 强配件词：这些出现在一个商品的某个档位里，基本可以断定是"配着买的附件"，不是主体
   后面不能跟容器字（遥控器盒 / 电池仓 / 支架座 本身就是主体）
   刻意不收「补充装 / 替换装」—— 5L 补充装往往只是更大包装，价格是可比的 */
const ACC_STRONG = "干电池|电池组|纽扣电池|充电电池|充电线|数据线|电源线|连接线|转接线|延长线|滤芯|滤网|滤棉|遥控器|配件包|耗材";
const ACC_WEAK = "支架|挂架|底座|壁挂件";
const NOT_CONTAINER = "(?!盒|座|架|收纳|包|箱|托|槽|仓|盖|套)";
export const ACC_RE = new RegExp("(?:" + ACC_STRONG + ")" + NOT_CONTAINER);
export const ACC_WEAK_RE = new RegExp("(?:" + ACC_WEAK + ")" + NOT_CONTAINER);
// 洗护类品类里，支架/底座是挂墙附件；别的品类里它可能就是主体（如电视支架）
export const WEAK_ACC_CATS = new Set(["大瓶洗沐", "小支洗沐", "洗手液", "洗沐液体", "洗沐液",
  "香氛精油", "清洁用品", "保养/除味", "消杀水剂", "全套洗漱"]);

/**
 * 判断某个规格档是不是"配件档"
 * @param tierName 规格名
 * @param prodName 商品名（商品名前 10 个字里已经出现同类词 → 商品本身就是这种东西，不算配件）
 * @param catLeaf  三级类目
 */
export function isAccessoryTier(tierName, prodName, catLeaf) {
  const t = String(tierName || "");
  const p = String(prodName || "");
  const hitStrong = ACC_RE.test(t);
  const hitWeak = ACC_WEAK_RE.test(t);
  if (!hitStrong && !hitWeak) return false;
  // 商品名开头就点明它是这类东西 → 商品本身就是主体
  const head = p.slice(0, 12);
  if (hitStrong && (ACC_RE.test(head) || /电池|充电器|插头|线材/.test(head))) return false;
  if (hitWeak && !WEAK_ACC_CATS.has(String(catLeaf || ""))) return false;
  if (hitWeak && ACC_WEAK_RE.test(head)) return false;
  // 档位名与商品名有 6 字以上重合 → 是同一产品线的变体，不是配着买的附件
  if (sharesLong(t, p, 6)) return false;
  return true;
}

/** 两个字符串是否共享长度 ≥ k 的公共子串（用于判断"是不是同一个东西的不同说法"） */
export function sharesLong(a, b, k = 6) {
  a = String(a || ""); b = String(b || "");
  if (a.length < k || b.length < k) return false;
  for (let i = 0; i + k <= a.length; i++) if (b.includes(a.slice(i, i + k))) return true;
  return false;
}

// ---------- 2. 三级类目 → 基准单位 ----------
const BASE_ML = new Set(["大瓶洗沐", "小支洗沐", "洗手液", "洗沐液体", "洗沐液", "消杀水剂", "去污水剂",
  "化油剂", "织物去污", "香氛精油", "饮用水", "饮料类", "乳制品", "食用油", "清洁用品", "保养/除味"]);
const BASE_G = new Set(["香皂", "客房茶包", "咖啡类", "大米", "调味料", "面", "方便食品", "早餐食材", "大堂用茶"]);
const BASE_ROLL = new Set(["卷纸", "卷纸抽纸"]);
const BASE_PULL = new Set(["抽纸/擦手纸", "办公用纸"]);
const BASE_SHEET = new Set(["湿巾/棉片", "一次性巾类"]);
const BASE_PAGE = new Set(["马桶垫纸"]);
const BASE_PAIR = new Set(["拖鞋", "浴室凉拖", "拖鞋试用"]);

export function baseOf(cat) {
  const c = String(cat || "").replace(/[_]+$/, "").trim();
  if (BASE_ML.has(c)) return { code: "ml100", label: "元/100ml" };
  if (BASE_G.has(c)) return { code: "g100", label: "元/100g" };
  if (BASE_ROLL.has(c)) return { code: "roll", label: "元/卷" };
  if (BASE_PULL.has(c)) return { code: "pull", label: "元/抽" };
  if (BASE_SHEET.has(c)) return { code: "sheet", label: "元/片" };
  if (BASE_PAGE.has(c)) return { code: "page", label: "元/张" };
  if (BASE_PAIR.has(c)) return { code: "pair", label: "元/双" };
  return { code: "piece", label: "元/件" };
}

// ---------- 3. 类目清洗：营销标签型叶子 ----------
export const TAG_LEAF = /^(三星高级推荐|经济实用推荐|高星豪华推荐|同城拼单特惠|试用专区)$/;
export const TRIAL_CAT = "试用专区";
export function cleanCat(chain) {
  const c = (chain || []).map(x => String(x || "").trim()).filter(Boolean);
  if (!c.length) return { leaf: "(无类目)", tags: [], trialOnly: false };
  if (c[c.length - 1] === TRIAL_CAT) return { leaf: TRIAL_CAT, tags: ["试用专区"], trialOnly: true };
  if (TAG_LEAF.test(c[c.length - 1])) {
    const up = c.slice(0, -1).filter(x => !TAG_LEAF.test(x));
    return { leaf: up[up.length - 1] || c[c.length - 1], tags: [c[c.length - 1]], trialOnly: false };
  }
  return { leaf: c[c.length - 1].replace(/[_]+$/, ""), tags: [], trialOnly: false };
}

// ---------- 4. 规格名解析 ----------
const U = "瓶|支|条|包|卷|个|只|双|袋|盒|抽|张|片|桶|提|件|套|块|罐|听|颗";
const NUM = "(\\d+(?:\\.\\d+)?)";
const MULT_PATTERNS = [
  new RegExp(`[【\\[(]\\s*${NUM}\\s*[*×xX]\\s*(?:${U})`),          // 【100*套】
  new RegExp(`[【\\[(]\\s*${NUM}\\s*(?:${U})`),                     // 【100瓶】
  new RegExp(`[*×xX]\\s*${NUM}\\s*(?:${U})`),                       // *24瓶
  new RegExp(`(?:整箱|整包|整件|一箱|每箱)\\s*${NUM}`),              // 整箱1000
  new RegExp(`${NUM}\\s*(?:${U})\\s*[/／]\\s*(?:箱|件|包|提)`),      // 1000只/箱
  new RegExp(`${NUM}\\s*(?:${U})\\s*(?:起订|起售|更优惠|批发价|优惠价|装)`), // 1000*瓶更优惠
];

export function parseMult(name) {
  const s = String(name || "");
  for (const re of MULT_PATTERNS) {
    const m = s.match(re);
    if (m) { const v = parseFloat(m[1]); if (isFinite(v) && v > 0) return v; }
  }
  return null;
}

// 一件的基本量：容量 / 克重（取**最后一个**，规格通常写在末尾；
// 例：`20L补充液【5L*4桶】` → 每桶 5L，而不是总量 20L）
export function parseContent(name) {
  const s = String(name || "");
  const hits = [];
  for (const m of s.matchAll(new RegExp(`${NUM}\\s*(ml|ML|mL|毫升|kg|KG|Kg|公斤|千克|L|升|公升)`, "g"))) {
    hits.push(m);
  }
  const ok = r => r && isFinite(r.v) && r.v > 0 ? r : null;
  if (!hits.length) {
    const m = s.match(new RegExp(`${NUM}\\s*(?:g|G|克)`));
    return ok(m ? { v: parseFloat(m[1]), u: "g", raw: m[0].trim() } : null);
  }
  const m = hits[hits.length - 1];
  const v = parseFloat(m[1]);
  if (!isFinite(v) || v <= 0) return null;      // 例：`系列00g洗发水` → 00g 是脏数据
  const u0 = m[2];
  const raw = m[0].trim();
  if (/^(g|G|克)$/.test(u0)) return { v, u: "g", raw };
  if (/^(ml|ML|mL|毫升)$/.test(u0)) return { v, u: "ml", raw };
  if (/^(kg|KG|Kg|公斤|千克)$/.test(u0)) return { v: v * 1000, u: "g", raw };
  return { v: v * 1000, u: "ml", raw };   // L / 升
}

// 每「件」的抽/片/张数。注意「层」是层数不是张数，必须排除。
export function parsePerPack(name) {
  const s = String(name || "");
  // 形态1：`50盒/1500片`、`3盒/90片` → 每件 = 总量 ÷ 件数
  let m = s.match(new RegExp(`${NUM}\\s*(?:盒|包|袋|桶|提)\\s*[/／]\\s*${NUM}\\s*(?:抽|片|张)`));
  if (m) {
    const per = parseFloat(m[2]), box = parseFloat(m[1]);
    if (box > 0 && per > 0) return per / box;
  }
  // 形态2：单包 `64抽` / `272张` / `10片`（取第一个）
  m = s.match(new RegExp(`${NUM}\\s*(?:抽|片|张)`));
  return m ? parseFloat(m[1]) : null;
}

/** 规格摘要（用于「常见规格」列）：按件/包/卷/抽 语境取最关键的量 */
export function specKey(name, code) {
  const s = String(name || "");
  if (code === "pull" || code === "sheet" || code === "page") {
    const m = s.match(new RegExp(`${NUM}\\s*(抽|片|张)`));
    if (m) return m[1] + m[2];
  }
  if (code === "roll") {
    const m = s.match(new RegExp(`${NUM}\\s*(?:克|g|G)`));
    if (m) return m[1] + "克/卷";
  }
  const c = parseContent(s);
  if (c) return c.raw.replace(/\s/g, "").replace(/毫升/g, "ml").replace(/公斤|千克|KG|Kg/g, "kg").replace(/公升/g, "L");
  const N = parseMult(s);
  if (N != null) {
    const m = s.match(new RegExp(`${NUM}\\s*[*×xX]?\\s*(${U})`));
    return m ? `${N}${m[2]}装` : `${N}件装`;
  }
  return "";
}

/**
 * 一件（瓶/包/卷/双/套/块…）的到手价：识别「整包价」
 *
 * 方案原文 4.1 的分支是「N > minQuantity → N 是包装量，price ÷ N」。
 * 实测发现该分支**只有在 minQuantity = 1 时才成立**：
 *   ✔ 【1000*只】垃圾袋 ¥26.00 起订1   → 26 是整包价 → 0.026/只
 *   ✘ 【整包1000*双】拖鞋 ¥0.69 起订100 → 0.69 是每双价 → 若 ÷1000 得 0.00069，荒谬且会霸榜
 * 故收窄触发条件为 minQuantity === 1。
 */
export function perPiecePrice(name, priceRaw, mq, ref) {
  const price = parseFloat(priceRaw);
  const N = parseMult(name);
  const out = { perPiece: price, N, kind: "", note: "" };
  if (mq != null && isFinite(mq) && mq === 1 && N != null && N > 1) {
    // 「起订1 + 规格里有 N」有两种可能：整包价(÷N)，或"1件就是1个、N 只是箱规"。
    // 用同商品里无歧义的档位(ref = 单件价)来判定，取更接近的那种解释。
    if (ref && isFinite(ref) && ref > 0) {
      const asItem = Math.abs(price - ref) / ref;
      const asPack = Math.abs(price / N - ref) / ref;
      if (asItem <= asPack) {
        out.perPiece = price; out.kind = "minOrder"; out.note = `起订1件、单价就是${price}（与同商品其它档位一致）`;
      } else {
        out.perPiece = price / N; out.kind = "pack"; out.note = `起订1件=${N}个的整包价 ÷${N}`;
      }
    } else {
      out.perPiece = price / N;
      out.kind = "pack";
      out.note = `起订1件=${N}个的整包价 ÷${N}`;
    }
  } else if (N != null && mq != null && N === mq) {
    out.kind = "minOrder"; out.note = `规格量=起订量(${N})，price 即单价`;
  } else if (N != null && mq != null && N > mq) {
    out.kind = "minOrderBig"; out.note = `规格量${N}>起订量${mq}，按起订量计价(单价)`;
  } else if (N != null && mq != null && N < mq) {
    out.kind = "minOrderSmall"; out.note = `规格量${N}<起订量${mq}，按起订量计价(单价)`;
  } else if (N == null) {
    out.kind = "plain"; out.note = "规格名无量，按起订量计价";
  } else {
    out.kind = "noMq"; out.note = "无起订量";
  }
  return out;
}

/**
 * 核心折算
 * @returns {{rankable:boolean, label:string, value:number|null, reason:string, perPiece:number, basis:string}}
 */
export function foldSku(base, name, priceRaw, mq, ref) {
  const price = parseFloat(priceRaw);
  const cat = baseOf(base);
  const out = { rankable: false, label: cat.label, value: null, reason: "", perPiece: price, basis: "" };
  if (!isFinite(price) || price <= 0) { out.reason = "价格无效"; return out; }

  const pp = perPiecePrice(name, priceRaw, mq, ref);
  const perPiece = pp.perPiece;
  out.perPiece = perPiece;
  out.basis = pp.note;

  const c = parseContent(name);
  switch (cat.code) {
    case "ml100": {
      if (!c) { out.reason = "未能解析容量"; return out; }
      const ml = c.v;                        // 液体：kg 与 ml 按 1:1 近似
      out.value = perPiece / (ml / 100); break;
    }
    case "g100": {
      if (!c) { out.reason = "未能解析克重"; return out; }
      out.value = perPiece / (c.v / 100); break;
    }
    case "roll": case "piece": case "pair": {
      out.value = perPiece; break;
    }
    case "pull": case "sheet": case "page": {
      const per = parsePerPack(name);
      if (!per) { out.reason = "未能解析每包张数"; return out; }
      out.value = perPiece / per; break;
    }
    default: { out.value = perPiece; break; }
  }
  if (!isFinite(out.value) || out.value <= 0) { out.value = null; out.reason = "折算结果异常"; return out; }
  out.rankable = true;
  return out;
}

// ---------- 5. 载入原始数据 ----------
export function loadRaw(rawPath) {
  const p = rawPath || path.join(ROOT, "data", "raw-specs.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j.items || j;
}
export function loadProducts() {
  return JSON.parse(fs.readFileSync(path.join(SRC, "data", "products.json"), "utf8"));
}
