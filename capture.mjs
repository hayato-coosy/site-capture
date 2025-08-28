// capture.mjs
import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const env = (k, d=null) => (process.env[k] ?? d);

// ★ 主要パラメータ（すべて Actions の inputs から渡せます）
const START_URLS = (env("START_URLS","")).split(",").map(s=>s.trim()).filter(Boolean);
if (!START_URLS.length) throw new Error("START_URLS を指定してください（カンマ区切り可）");

const FULL_PAGE = (env("FULL_PAGE","true").toLowerCase()==="true");
const DEVICES_RAW = (env("DEVICES","Desktop 1440x900,iPhone 13")).split(",").map(s=>s.trim()).filter(Boolean);

// クロール関連
const SAME_HOST_ONLY   = (env("SAME_HOST_ONLY","true").toLowerCase()==="true");
const PATH_PREFIX_MODE = (env("PATH_PREFIX_MODE","start").toLowerCase()); // "start" | "none"
const MAX_DEPTH = parseInt(env("MAX_DEPTH","2"),10);   // ← デフォで子ページまで
const MAX_PAGES = parseInt(env("MAX_PAGES","300"),10); // ← 暴走防止の総ページ上限
const WAIT_BETWEEN_MS = parseInt(env("WAIT_BETWEEN_MS","200"),10);

// 出力＆高DPI
const OUT_DIR = env("OUT_DIR","public");
const SCALE = Math.max(1, parseInt(env("SCALE","2"),10)); // ← 2で“2倍解像度”

// ---------- ユーティリティ ----------
const parseWxH = s => { const m = s.match(/(\d+)\s*x\s*(\d+)/i); return m?{w:+m[1],h:+m[2]}:null; };
function resolveViewports(list){
  return list.map(item=>{
    if (pwDevices[item]) return { kind:"preset", label:item, preset: pwDevices[item] };
    const wh = parseWxH(item) || parseWxH(item.replace(/[^\dx]/gi,""));
    if (wh) return { kind:"size", label:(item.replace(/\s+/g,"_")||`${wh.w}x${wh.h}`), viewport:{ width:wh.w, height:wh.h } };
    return { kind:"size", label:"Desktop_1440x900", viewport:{ width:1440, height:900 } };
  });
}
const VIEWPORTS = resolveViewports(DEVICES_RAW);

const normalizeUrl = (u,b)=>{ try{ return new URL(u,b).toString().replace(/#.*$/,""); }catch{ return null; } };
function shouldVisit(targetUrl, startUrl){
  const t = new URL(targetUrl), s = new URL(startUrl);
  if (!["http:","https:"].includes(t.protocol)) return false;
  if (SAME_HOST_ONLY && t.host !== s.host) return false;
  if (PATH_PREFIX_MODE==="start"){
    const prefix = s.pathname.endsWith("/") ? s.pathname : s.pathname + "/";
    if (prefix !== "/" && !(t.pathname + "/").startsWith(prefix)) return false;
  }
  return true;
}
const safeName = u => {
  const { host, pathname } = new URL(u);
  const p = pathname === "/" ? "root" : pathname.replace(/[^a-z0-9/_-]+/gi,"_").replace(/^_+|_+$/g,"");
  return (host + "__" + p).slice(0,180);
};
const sleep = ms => new Promise(r=>setTimeout(r, ms));

async function lazyLoadScroll(page){
  await page.evaluate(async () => {
    const h = document.body ? document.body.scrollHeight : 0;
    window.scrollTo(0, h);
    await new Promise(r=>setTimeout(r, 250));
    window.scrollTo(0, 0);
  });
}

// ---------- メイン ----------
async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();

  // ★ 高DPI（2xなど）でコンテキスト生成：CSSサイズはそのまま、deviceScaleFactor を上げる
  const contexts = [];
  for (const vp of VIEWPORTS){
    if (vp.kind === "preset"){
      const p = { ...vp.preset, deviceScaleFactor: (vp.preset.deviceScaleFactor ?? 1) * SCALE };
      const ctx = await browser.newContext(p);
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    } else {
      const ctx = await browser.newContext({
        viewport: vp.viewport,             // レイアウトは指定のCSSピクセル
        deviceScaleFactor: SCALE           // 実ピクセル密度だけ上げる（=2倍解像度）
      });
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    }
  }

  const visited = new Set();
  const queue = START_URLS.map(u=>({ start:u, url:u, depth:0 }));
  const captured = [];

  while (queue.length && visited.size < MAX_PAGES){
    const { start, url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    // 撮影
    for (const dev of contexts){
      try{
        await dev.page.goto(url, { waitUntil:"networkidle", timeout: 45000 });
        await lazyLoadScroll(dev.page);
        const base = safeName(url);
        const file = `${base}__${dev.label}${FULL_PAGE?"__full":""}@${SCALE}x.png`;
        const out = path.join(OUT_DIR, file);
        const buf = await dev.page.screenshot({ type:"png", fullPage: FULL_PAGE });
        await fs.writeFile(out, buf);
        captured.push({ url, device: dev.label, scale: SCALE, file });
        if (WAIT_BETWEEN_MS) await sleep(WAIT_BETWEEN_MS);
      } catch(e) {
        console.error(`[warn] ${dev.label} failed on ${url}:`, e.message || e);
      }
    }

    // 深さ制限
    if (depth >= MAX_DEPTH) continue;

    // リンク抽出（先頭のページからでOK）
    let links = [];
    try{
      links = await contexts[0].page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    }catch{}

    for (const raw of links){
      const abs = normalizeUrl(raw, url);
      if (!abs || visited.has(abs)) continue;
      if (!shouldVisit(abs, start)) continue;
      queue.push({ start, url: abs, depth: depth + 1 });
      if (queue.length + visited.size >= MAX_PAGES) break;
    }
  }

  for (const c of contexts) await c.ctx.close();
  await browser.close();

  await fs.writeFile(path.join(OUT_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), items: captured }, null, 2)
  );

  console.log(`Done: pages=${visited.size}, shots=${captured.length}, out=${OUT_DIR}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
