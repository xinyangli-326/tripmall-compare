// 用 GitHub Git Data API 一次性推送整个站点（不依赖本机 git）
// 用法：node tools/push-github.mjs [--msg="提交说明"] [--repo=owner/name] [--dry]
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./fold.mjs";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));
const REPO = argv.repo || "xinyangli-326/tripmall-compare";
const BRANCH = argv.branch || "main";
const TOKEN_FILE = argv.token || "C:\\Users\\yuri0618\\Documents\\Codex\\2026-09-02\\tripmall-c-users-yuri0618-documents-codex\\_ghtoken.txt";
const TOKEN = (process.env.GHTOKEN || fs.readFileSync(TOKEN_FILE, "utf8")).trim();

// 要推送的文件（相对路径 → 绝对路径）；跳过 work/ 等中间物
const INCLUDE = [
  "index.html", "README.md", ".gitignore", "server.mjs",
  "data/site-summary.json", "data/search.json",
  "tools/fold.mjs", "tools/build-site.mjs", "tools/fetch-specs-full.mjs",
  "tools/fetch-pay.mjs", "tools/audit.mjs", "tools/report.mjs", "tools/shoot.mjs",
  "tools/push-github.mjs",
];
// 品细分片（data/cat/*.json）自动全部带上
const catDir = path.join(ROOT, "data", "cat");
if (fs.existsSync(catDir)) fs.readdirSync(catDir).filter(f => f.endsWith(".json"))
  .forEach(f => INCLUDE.push("data/cat/" + f));

const API = "https://api.github.com";
const H = { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "tripmall-compare" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body, tries = 4) {
  for (let a = 0; a < tries; a++) {
    const r = await fetch(API + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (r.ok) return t ? JSON.parse(t) : null;
    if (r.status >= 500 || r.status === 429) { await sleep(800 * (a + 1)); continue; }
    throw new Error(method + " " + url + " → " + r.status + " " + t.slice(0, 300));
  }
  throw new Error(method + " " + url + " 重试后仍失败");
}

// 1) 当前分支头
const ref = await api("GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`).catch(async e => {
  if (/404/.test(e.message)) return null; throw e;
});
const parentSha = ref ? ref.object.sha : null;
const baseTree = parentSha ? (await api("GET", `/repos/${REPO}/git/commits/${parentSha}`)).tree.sha : undefined;
console.log(`仓库 ${REPO}  分支 ${BRANCH}  当前提交 ${parentSha ? parentSha.slice(0, 7) : "(空仓库)"}`);

// 2) 上传 blobs
const tree = [];
for (const rel of INCLUDE) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log("  跳过（不存在） " + rel); continue; }
  const buf = fs.readFileSync(abs);
  if (argv.dry) { console.log(`  [dry] ${rel}  ${(buf.length / 1024).toFixed(0)}KB`); continue; }
  const blob = await api("POST", `/repos/${REPO}/git/blobs`, { content: buf.toString("base64"), encoding: "base64" });
  tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  console.log(`  上传 ${rel.padEnd(34)} ${(buf.length / 1024).toFixed(0)}KB`);
}
if (argv.dry) { console.log("dry run，未推送"); process.exit(0); }

// 3) 建 tree + commit + 移动分支
const newTree = await api("POST", `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
const msg = argv.msg || `比价小助手：全量数据 + 页面（${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}）`;
const commit = await api("POST", `/repos/${REPO}/git/commits`, { message: msg, tree: newTree.sha, parents: parentSha ? [parentSha] : [] });
if (parentSha) await api("PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha });
else await api("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });

console.log("\n✅ 已推送");
console.log("   commit " + commit.sha.slice(0, 7));
console.log("   https://github.com/" + REPO + "/commit/" + commit.sha);
