// capture.mjs
// - 配下ページのクロール
// - 2xなどの高DPI撮影 (SCALE)
// - lazy-load起動のためのゆっくりオートスクロール
// - <img> と background-image の実読み込み完了を待機
// - ファイル名はフラット化（/ を _ に置換）

import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const env = (k, d=null) => (process.env[k] ?? d);

// ====== 設定（環境変数で上書き） ======
const START_URLS = (env("START_URLS","")).split(",").map(s=>s.trim()).filter(Boolean);
if (!START_URLS.length) throw new Error("START_URLS を指定してください（カンマ区切り可）");

const FULL_PAGE       = (env("FULL_PAGE","true").toLowerCase()==="true");
const DEVICES_RAW     = (env("DEVICES","Desktop 1440x900,iPhone 13")).split(",").map(s=>s.trim()).filter(Boolean);

const SAME_HOST_ONLY   = (env("SAME_HOST_ONLY","true").toLowerCase()==="true");
const PATH_PREFIX_MODE = (env("PATH_PREFIX_MODE","start").toLowerCase()); // "start" | "none"
const MAX_DEPTH        = parseInt(env("MAX_DEPTH","2"),10);
const MAX_PAGES        = parseInt(env("MAX_PAGES","300"),10);
const WAIT_BETWEEN_MS  = parseInt(env("WAIT_BETWEEN_MS","200"),10);

const OUT_DIR = env("OUT_DIR","public");
const SCALE   = Math.max(1, parseInt(env("SCALE","2"),10));
const EXTRA_WAIT_MS = parseInt(env("EXTRA_WAIT_MS","0"),10); // 任意の余裕待ち

// ====== ユーティリティ ======
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

// ハッシュは落として正規化（SPAで # を別ページにしたいなら .replace を外す）
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

// ファイル名をフラット化（/ を _ に）
const safeName = u => {
  const { host, pathname } = new URL(u);
  const p = pathname === "/" ? "root" : pathname.replace(/[^a-z0-9_-]+/gi,"_"); // "/" も "_" に
  return (host + "__" + p).slice(0,180);
};

const sleep = ms => new Promise(r=>setTimeout(r, ms));

// ====== 遅延読み込みを発火させる：ゆっくりオートスクロール ======
async function autoScroll(page, { step=600, pause=200 } = {}) {
  await page.evaluate(async ({step, pause}) => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
    let y = 0, h = document.body?.scrollHeight || 0;
    while (y < h - 1) {
      y = Math.min(y + step, h);
      window.scrollTo(0, y);
      await sleep(pause);
      const newH = document.body?.scrollHeight || h;
      if (newH > h) h = newH; // 伸びたら追従
    }
    await sleep(pause);
    window.scrollTo(0, 0);
    await sleep(150);
  }, {step, pause});
}

// ====== 画像の実読み込み完了を待つ（<img> と background-image） ======
async function waitForImages(page, timeoutMs = 30000) {
  await page.waitForFunction(async () => {
    // <img> が全て読み込み済みかチェック
    const imgs = Array.from(document.images || []);
    const allImgOk = imgs.every(img => img.complete && img.naturalWidth > 0);

    // background-image の url() を拾ってロード
    const urls = new Set();
    const nodes = Array.from(document.querySelectorAll("*"));
    for (const el of nodes) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) urls.add(m[2]);
    }

    const loadOne = (src) => new Promise(res => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(true); // エラーでも先に進む
      im.src = src;
    });

    if (urls.size) {
      await Promise.all(Array.from(urls).map(loadOne));
    }

    return allImgOk;
  }, { timeout: timeoutMs });
}

// ====== メイン ======
async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();

  // 高DPIでコンテキスト作成（CSSレイアウトはそのまま、deviceScaleFactorだけ上げる）
  const contexts = [];
  for (const vp of VIEWPORTS){
    if (vp.kind === "preset"){
      const p = { ...vp.preset, deviceScaleFactor: (vp.preset.deviceScaleFactor ?? 1) * SCALE };
      const ctx = await browser.newContext(p);
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    } else {
      const ctx = await browser.newContext({
        viewport: vp.viewport,
        deviceScaleFactor: SCALE
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

    for (const dev of contexts){
      try{
        await dev.page.goto(url, { waitUntil:"networkidle", timeout: 60000 });

        // 画像の取りこぼし対策（順番が大事）
        await dev.page.waitForLoadState('networkidle');
        await autoScroll(dev.page, { step: 600, pause: 200 });
        await dev.page.waitForLoadState('networkidle'); // 二重アイドル待ち
        await waitForImages(dev.page, 45000);
        if (EXTRA_WAIT_MS) await sleep(EXTRA_WAIT_MS);

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

    // 深さ制御
    if (depth >= MAX_DEPTH) continue;

    // <a href> を収集（先頭ページからでOK）
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
