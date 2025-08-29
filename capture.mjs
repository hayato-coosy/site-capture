// capture.mjs
// 安全寄り・高機能スクショ収集 (Playwright)
//
// 機能概要:
// - 高DPI撮影 (SCALE) / fullPage 切替
// - クロール (MAX_DEPTH / MAX_PAGES / SAME_HOST_ONLY / PATH_PREFIX_MODE)
// - lazy-load対策: オートスクロール + 画像ロード待ち
// - タイムアウト耐性: networkidle→domcontentloaded フォールバック + リトライ + Retry-After
// - robots.txt 準拠 (Disallow / Crawl-delay)
// - 保存パスモード: flat / tree (FILENAME_MODE)
// - 個人情報対策: URL除外 / 要素マスク (Playwright mask) / 任意の blur CSS
// - 記事テンプレ大量ページの抑制: SKIP_URL_PATTERNS による除外 +
//   「blog/news/articles/posts は原則スキップだが、各カテゴリで詳細 1 件のみ例外的に許可」
//
// 使い方:
// - 環境変数は GitHub Actions の workflow_dispatch 入力から渡す（下の yml 例を参照）

import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const env = (k, d=null) => (process.env[k] ?? d);

// ====== 基本設定 ======
const START_URLS = (env("START_URLS","")).split(",").map(s=>s.trim()).filter(Boolean);
if (!START_URLS.length) throw new Error("START_URLS を指定してください（カンマ区切り可）");

const FULL_PAGE        = (env("FULL_PAGE","true").toLowerCase()==="true");
const DEVICES_RAW      = (env("DEVICES","Desktop 1440x900,iPhone 13")).split(",").map(s=>s.trim()).filter(Boolean);

const SAME_HOST_ONLY   = (env("SAME_HOST_ONLY","true").toLowerCase()==="true");
const PATH_PREFIX_MODE = (env("PATH_PREFIX_MODE","start").toLowerCase()); // "start" | "none"
const MAX_DEPTH        = parseInt(env("MAX_DEPTH","1"),10);
const MAX_PAGES        = parseInt(env("MAX_PAGES","100"),10);

const OUT_DIR          = env("OUT_DIR","public");
const SCALE            = Math.max(1, parseInt(env("SCALE","2"),10));
const EXTRA_WAIT_MS    = parseInt(env("EXTRA_WAIT_MS","0"),10);

const FILENAME_MODE    = (env("FILENAME_MODE","flat").toLowerCase()); // "flat" | "tree"
const SAFE_MODE        = (env("SAFE_MODE","true").toLowerCase()==="true");
const RESPECT_ROBOTS   = (env("RESPECT_ROBOTS","true").toLowerCase()==="true");
const SITEMAP_URL      = env("SITEMAP_URL","").trim();

const GOTO_TIMEOUT_MS  = parseInt(env("GOTO_TIMEOUT_MS","120000"),10);
const RETRIES          = Math.max(0, parseInt(env("RETRIES","1"),10));

// セーフモードなら控えめ設定
let WAIT_BETWEEN_MS    = parseInt(env("WAIT_BETWEEN_MS", SAFE_MODE ? "1000" : "200"),10);

// ====== 除外・マスク ======
const SKIP_URL_PATTERNS = (env("SKIP_URL_PATTERNS","login,logout,signin,signup,cart,checkout,account,mypage,admin,settings,profile,blog,news,articles,posts"))
  .split(",").map(s=>s.trim()).filter(Boolean);

const MASK_SELECTORS = (env("MASK_SELECTORS","input[type='password'],input[type='email'],input[name*='mail'],input[name*='phone'],.email,.tel,.phone,[data-sensitive]"))
  .split(",").map(s=>s.trim()).filter(Boolean);

// ====== 「カテゴリ1件だけ許可」設定 ======
const SAMPLE_DETAIL_ALLOW = (env("SAMPLE_DETAIL_ALLOW","true").toLowerCase()==="true");
const SAMPLE_DETAIL_PATTERNS = (env("SAMPLE_DETAIL_PATTERNS","blog,news,articles,posts"))
  .split(",").map(s=>s.trim()).filter(Boolean);
const sampleTaken = new Map(SAMPLE_DETAIL_PATTERNS.map(p => [p, false]));

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

// SPAで # を別ページ扱いにしたい場合は replace を外す
const normalizeUrl = (u,b)=>{ try{ return new URL(u,b).toString().replace(/#.*$/,""); }catch{ return null; } };

const sleep = ms => new Promise(r=>setTimeout(r, ms));
const jitter = (ms) => Math.max(0, ms + Math.round((Math.random()*2-1) * ms * 0.2)); // ±20%

// 保存パス（flat / tree）
function buildSavePath(u, deviceLabel, scale, fullPage, mode="flat") {
  const { host, pathname } = new URL(u);
  if (mode === "tree") {
    let dir = path.join(OUT_DIR, host, pathname);
    if (pathname === "/") {
      dir = path.join(OUT_DIR, host);
    } else if (dir.endsWith("/")) {
      dir = dir.slice(0, -1);
    }
    const base = pathname === "/" ? "root" : path.basename(pathname);
    const fileName = `${base}__${deviceLabel}${fullPage ? "__full" : ""}@${scale}x.png`;
    return path.join(dir, fileName);
  } else {
    const safePath = (pathname === "/" ? "root" : pathname.replace(/[^a-z0-9_-]+/gi,"_"));
    const base = (host + "__" + safePath).slice(0,180);
    const fileName = `${base}__${deviceLabel}${fullPage ? "__full" : ""}@${scale}x.png`;
    return path.join(OUT_DIR, fileName);
  }
}

// 遅延読み込み支援: ゆっくり下までスクロール→先頭へ戻る
async function autoScroll(page, { step=600, pause=200 } = {}) {
  await page.evaluate(async ({step, pause}) => {
    const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
    let y = 0, h = document.body?.scrollHeight || 0;
    while (y < h - 1) {
      y = Math.min(y + step, h);
      window.scrollTo(0, y);
      await sleep(pause);
      const newH = document.body?.scrollHeight || h;
      if (newH > h) h = newH;
    }
    await sleep(pause);
    window.scrollTo(0, 0);
    await sleep(150);
  }, {step, pause});
}

// 画像ロード待ち（<img> / CSS background-image）
async function waitForImages(page, timeoutMs = 30000) {
  await page.waitForFunction(async () => {
    const imgs = Array.from(document.images || []);
    const allImgOk = imgs.every(img => img.complete && img.naturalWidth > 0);

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
      im.onerror = () => res(true);
      im.src = src;
    });
    if (urls.size) await Promise.all(Array.from(urls).map(loadOne));

    return allImgOk;
  }, { timeout: timeoutMs });
}

// robots.txt 読み込み (User-agent: * を簡易解釈)
async function loadRobots(baseOrigin) {
  try {
    const res = await fetch(new URL("/robots.txt", baseOrigin).href);
    if (!res.ok) return { disallow: [], delay: 0 };
    const txt = await res.text();
    const sections = txt.split(/(?=User-agent:\s*)/i);
    let block = sections.find(s => /^User-agent:\s*\*$/im.test(s)) || txt;
    const disallow = [...block.matchAll(/^Disallow:\s*(.*)$/gmi)].map(m => (m[1]||"").trim()).filter(Boolean);
    const delayMatch = block.match(/^Crawl-delay:\s*(\d+)/im);
    const delay = delayMatch ? Math.min(5000, parseInt(delayMatch[1],10) * 1000) : 0; // 上限5s
    return { disallow, delay };
  } catch { return { disallow: [], delay: 0 }; }
}

function blockedByRobots(pathname, disallow) {
  return disallow.some(rule => rule && pathname.startsWith(rule));
}

// ====== 「カテゴリ詳細1件だけ許可」ロジック ======
function getMatchedCategory(pathname) {
  const seg = pathname.split("/").filter(Boolean)[0] || "";
  if (SAMPLE_DETAIL_PATTERNS.includes(seg)) return seg;
  return null;
}
function isListingPathAfterCategory(pathname, category) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts[0] !== category) return false;
  if (parts.length === 1) return true; // /blog → 一覧
  const k = (parts[1] || "").toLowerCase();
  if (["page","category","categories","tag","tags","archive","archives","topics","topic","label","labels","feed","index"].includes(k)) {
    return true;
  }
  return false; // それ以外は詳細の可能性が高い
}
function allowSampleDetailIfFirst(urlObj) {
  const cat = getMatchedCategory(urlObj.pathname);
  if (!cat) return false;
  if (isListingPathAfterCategory(urlObj.pathname, cat)) return false;
  if (sampleTaken.has(cat) && sampleTaken.get(cat) === false) {
    sampleTaken.set(cat, true);
    return true;
  }
  return false;
}

// ====== URL訪問可否 ======
function shouldVisit(targetUrl, startUrl, robots) {
  const t = new URL(targetUrl), s = new URL(startUrl);

  if (!["http:","https:"].includes(t.protocol)) return false;
  if (SAME_HOST_ONLY && t.host !== s.host) return false;
  if (PATH_PREFIX_MODE==="start"){
    const prefix = s.pathname.endsWith("/") ? s.pathname : s.pathname + "/";
    if (prefix !== "/" && !(t.pathname + "/").startsWith(prefix)) return false;
  }

  // 通常スキップ（正規表現含む）
  const hitSkip = SKIP_URL_PATTERNS.some(p => new RegExp(p, "i").test(targetUrl));
  if (hitSkip) {
    // ただしサンプル許可がONなら、各カテゴリで最初の詳細1件だけ救済
    if (SAMPLE_DETAIL_ALLOW && allowSampleDetailIfFirst(t)) return true;
    return false;
  }

  if (RESPECT_ROBOTS && robots && blockedByRobots(t.pathname, robots.disallow)) return false;

  return true;
}

// ====== ナビゲーション（フォールバック＋リトライ） ======
async function gotoSmart(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: GOTO_TIMEOUT_MS });
    return res;
  } catch {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  }
}

// ====== メイン ======
async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const robots = RESPECT_ROBOTS ? await loadRobots(new URL(START_URLS[0]).origin) : { disallow: [], delay: 0 };
  WAIT_BETWEEN_MS = Math.max(WAIT_BETWEEN_MS, robots.delay || 0);

  // コンテキスト（高DPI / UA）
  const contexts = [];
  for (const vp of resolveViewports(DEVICES_RAW)){
    const common = {
      userAgent: `SiteCaptureBot/1.0 (+https://example.com/contact)`
    };
    if (vp.kind === "preset"){
      const p = { ...vp.preset, deviceScaleFactor: (vp.preset.deviceScaleFactor ?? 1) * SCALE, ...common };
      const ctx = await browser.newContext(p);
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    } else {
      const ctx = await browser.newContext({
        viewport: vp.viewport,
        deviceScaleFactor: SCALE,
        ...common
      });
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    }
  }

  // blurCSS を視覚的に効かせたい場合は有効化（マスクは後述で実画像にも反映）
  // const blurCSS = `${MASK_SELECTORS.join(",")} { filter: blur(10px) !important; }`;
  // await Promise.all(contexts.map(c => c.page.addStyleTag({ content: blurCSS })));

  // キュー: 開始URL + 任意で sitemap.xml
  const visited = new Set();
  const queue = START_URLS.map(u=>({ start:u, url:u, depth:0 }));

  if (SITEMAP_URL) {
    try {
      const xml = await (await fetch(SITEMAP_URL)).text();
      const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1].trim());
      for (const u of locs) {
        if (shouldVisit(u, START_URLS[0], robots)) queue.push({ start: START_URLS[0], url: u, depth: 0 });
      }
    } catch (e) {
      console.error("sitemap load failed:", e.message || e);
    }
  }

  const captured = [];

  while (queue.length && visited.size < MAX_PAGES){
    const { start, url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (!shouldVisit(url, start, robots)) continue;
    visited.add(url);

    for (const dev of contexts){
      try{
        // リトライ付き遷移
        for (let attempt=0; attempt<=RETRIES; attempt++){
          const res = await gotoSmart(dev.page, url);
          const status = res?.status?.() || 200;
          if ([429,503].includes(status)) {
            const ra = res?.headers?.()["retry-after"];
            const ms = ra ? (isNaN(+ra) ? 5000 : +ra*1000) : 5000;
            await sleep(ms);
            if (attempt < RETRIES) continue;
          }
          break;
        }

        await dev.page.waitForLoadState('networkidle');
        await autoScroll(dev.page, { step: 600, pause: 200 });
        await dev.page.waitForLoadState('networkidle');
        await waitForImages(dev.page, 45000);
        if (EXTRA_WAIT_MS) await sleep(EXTRA_WAIT_MS);

        const out = buildSavePath(url, dev.label, SCALE, FULL_PAGE, FILENAME_MODE);
        await fs.mkdir(path.dirname(out), { recursive: true });

        const masks = MASK_SELECTORS.map(sel => dev.page.locator(sel));
        const buf = await dev.page.screenshot({
          type:"png",
          fullPage: FULL_PAGE,
          mask: masks.length ? masks : undefined
        });
        await fs.writeFile(out, buf);

        captured.push({
          url,
          device: dev.label,
          scale: SCALE,
          file: path.relative(OUT_DIR, out)
        });

        if (WAIT_BETWEEN_MS) await sleep(jitter(WAIT_BETWEEN_MS));
      } catch(e) {
        console.error(`[warn] ${dev.label} failed on ${url}:`, e.message || e);
      }
    }

    // 深さ制御
    if (depth >= MAX_DEPTH) continue;

    // <a href> 抽出（先頭のページから）
    let links = [];
    try{
      links = await contexts[0].page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    }catch{}
    for (const raw of links){
      const abs = normalizeUrl(raw, url);
      if (!abs || visited.has(abs)) continue;
      if (!shouldVisit(abs, start, robots)) continue;
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
