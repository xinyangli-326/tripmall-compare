// 用本机调试 Edge 给页面截图：node tools/shoot.mjs --url=http://127.0.0.1:8811/ --w=1440 --h=1000 --out=work/shots/a.png [--full] [--script=js]
import fs from "node:fs";
import path from "node:path";

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? "1" : m[2]] : [a, "1"];
}));
const URL_ = argv.url || "http://127.0.0.1:8811/";
const W = Number(argv.w || 1440), H = Number(argv.h || 1000);
const OUT = path.resolve(argv.out || "work/shots/shot.png");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ver = await fetch("http://127.0.0.1:9333/json/version").then(r => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });

let id = 0; const pend = new Map();
ws.addEventListener("message", ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === "Runtime.exceptionThrown") console.log("[page error] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") console.log("[console] " + JSON.stringify(m.params.args.map(a => a.value ?? a.description).join(" ")));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
const call = (m, p = {}) => raw(m, p, sessionId);
await raw("Target.activateTarget", { targetId }).catch(() => {});

await call("Page.enable"); await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: W, height: H, deviceScaleFactor: 2, mobile: W <= 500,
  screenWidth: W, screenHeight: H,
});
await call("Page.navigate", { url: URL_ });

const ev = async e => {
  const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 1).slice(0, 1400));
  return r.result && r.result.value;
};

for (let i = 0; i < 60; i++) { if (await ev("document.body.dataset.ready==='1'")) break; await sleep(250); }
const SCRIPT = argv.scriptfile ? fs.readFileSync(path.resolve(argv.scriptfile), "utf8") : argv.script;
if (SCRIPT) { const r = await ev(SCRIPT); if (r !== undefined) console.log("script -> " + JSON.stringify(r)); }
await sleep(Number(argv.wait || 900));

// 截图专用：强制所有图片立即加载（后台标签页会推迟 lazy 图片）
if (argv.eager !== "0") {
  await ev(`(function(){var n=0;document.querySelectorAll('img').forEach(function(i){
    i.loading='eager'; if(!i.complete){var s=i.getAttribute('src');i.removeAttribute('src');i.src=s;n++;}});return n;})()`);
  for (let i = 0; i < 40; i++) {
    const left = await ev(`[...document.querySelectorAll('img')].filter(i=>!i.complete).length`);
    if (!left) break;
    await sleep(250);
  }
  const bad = await ev(`[...document.querySelectorAll('img')].filter(i=>!i.complete||i.naturalWidth===0).length`);
  if (bad) console.log("warn: " + bad + " 张图片未加载完成");
}

const shot = await call("Page.captureScreenshot", {
  format: "png", captureBeyondViewport: !!argv.full,
  ...(argv.full ? {} : {}),
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("saved " + OUT + "  (" + Math.round(fs.statSync(OUT).size / 1024) + " KB)");

await raw("Target.closeTarget", { targetId });
ws.close();
process.exit(0);
