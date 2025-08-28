// capture.mjs
// 安全＆高品質スクショ収集（Playwright）
// - クロール: MAX_DEPTH / SAME_HOST_ONLY / PATH_PREFIX_MODE / SITEMAP_URL
// - 画質: SCALE(@2x等) / FULL_PAGE
// - 遅延対策: オートスクロール＋画像ロード待ち
// - 省略: 同一レイアウト検知で自動スキップ（LAYOUT_DEDUP）
// - 安全: robots.txt尊重 / 除外URL / 要素マスク / セーフモードの控えめ設定
// - 失敗耐性: networkidle→domcontentloaded フォールバック / 429,503のRetry-After
// - 保存: flat / tree の切替（FILENAME_MODE）/ manifest.json 出力

import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const env = (k, d=null) => (process.env[k] ?? d);

// ========= 基本設定 =========
const START_URLS = (env("START_URLS","")).split(",").map(s=>s.trim()).filter(Boolean);
if (!START_URLS.length) throw new Error("START_URLS を指定してください（カンマ区切り可）");

const FULL_PAGE        = (env("FULL_PAGE","true").toLowerCase()==="true");
const DEVICES_RAW      = (env("DEVICES","Desktop 1440x900,iPhone 13")).split(",").map(s=>s.trim()).filter(Boolean);
const OUT_DIR          = env("OUT_DIR","public");
const SCALE            = Math.max(1, parseInt(env("SCALE","2"),10));
const FILENAME_MODE    = (env("FILENAME_MODE","flat").toLowerCase()); // flat | tree

// ========= 範囲・安全 =========
const SAME_HOST_ONLY   = (env("SAME_HOST_ONLY","true").toLowerCase()==="true");
const PATH_PREFIX_MODE = (env("PATH_PREFIX_MODE","start").toLowerCase()); // start | none
const MAX_DEPTH        = parseInt(env("MAX_DEPTH","1"),10);
const MAX_PAGES        = parseInt(env("MAX_PAGES","100"),10);
const SAFE_MODE        = (env("SAFE_MODE","true").toLowerCase()==="true");
const RESPECT_ROBOTS   = (env("RESPECT_ROBOTS","true").toLowerCase()==="true");
const SITEMAP_URL      = env("SITEMAP_URL","").trim();
const EXTRA_WAIT_MS    = parseInt(env("EXTRA_WAIT_MS","0"),10);

let WAIT_BETWEEN_MS    = parseInt(env("WAIT_BETWEEN_MS", SAFE_MODE ? "1000" : "200"),10);

const SKIP_URL_PATTERNS = (env("SKIP_URL_PATTERNS",
  "login,logout,signin,signup,cart,checkout,account,mypage,admin,settings,profile"))
  .split(",").map(s=>s.trim()).filter(Boolean);

const MASK_SELECTORS = (env("MASK_SELECTORS",
  "input[type='password'],input[type='email'],input[name*='mail'],input[name*='phone'],.email,.tel,.phone,[data-sensitive]"))
  .split(",").map(s=>s.trim()).filter(Boolean);

// ========= ナビゲーション耐性 =========
const GOTO_TIMEOUT_MS  = parseInt(env("GOTO_TIMEOUT_MS","120000"),10);
const RETRIES          = Math.max(0, parseInt(env("RETRIES","1"),10));

// ========= レイアウト重複スキップ =========
const LAYOUT_DEDUP     = (env("LAYOUT_DEDUP","true").toLowerCase()==="true");
const LAYOUT_SAMPLE_LIMIT = parseInt(env("LAYOUT_SAMPLE_LIMIT","200"),10); // DOM先頭何要素を見るか
const LAYOUT_IGNORE_URL_PATTERNS = (env("LAYOUT_IGNORE_URL_PATTERNS","").trim() || "")
  .split(",").map(s=>s.trim()).filter(Boolean); // ここに一致するURLはデデュプ対象外（例：/lp/ のA/B違い等）

// ========= ユーティリティ =========
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

// URL正規化（#を同一ページ扱い：SPAで分けたいなら .replace を外す）
const normalizeUrl = (u,b)=>{ try{ return new URL(u,b).toString().replace(/#.*$/,""); }catch{ return null; } };

// 保存パス（flat / tree）
function buildSavePath(u, deviceLabel, scale, fullPage, mode="flat") {
  const { host, pathname } = new URL(u);
  if (mode === "tree") {
    let dir = path.join(OUT_DIR, host, pathname);
    if (pathname === "/") dir = path.join(OUT_DIR, host);
    else if (dir.endsWith("/")) dir = dir.slice(0, -1);
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

const sleep = ms => new Promise(r=>setTimeout(r, ms));
const jitter = ms => Math.max(0, ms + Math.round((Math.random()*2-1) * ms * 0.2)); // ±20%

// 遅延読み込み支援
async function autoScroll(page, { step=600, pause=200 } = {}) {
  await page.evaluate(async ({step, pause}) => {
    const zzz = (ms)=>new Promise(r=>setTimeout(r, ms));
    let y = 0, h = document.body?.scrollHeight || 0;
    while (y < h - 1) {
      y = Math.min(y + step, h);
      window.scrollTo(0, y);
      await zzz(pause);
      const newH = document.body?.scrollHeight || h;
      if (newH > h) h = newH;
    }
    await zzz(pause);
    window.scrollTo(0, 0);
    await zzz(150);
  }, {step, pause});
}

// 画像ロード待ち（<img> / background-image）
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

// robots.txt（User-agent: * の簡易解釈）
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

function shouldVisit(targetUrl, startUrl, robots) {
  if (SKIP_URL_PATTERNS.some(p => new RegExp(p, "i").test(targetUrl))) return false;
  const t = new URL(targetUrl), s = new URL(startUrl);
  if (!["http:","https:"].includes(t.protocol)) return false;
  if (SAME_HOST_ONLY && t.host !== s.host) return false;
  if (PATH_PREFIX_MODE==="start"){
    const prefix = s.pathname.endsWith("/") ? s.pathname : s.pathname + "/";
    if (prefix !== "/" && !(t.pathname + "/").startsWith(prefix)) return false;
  }
  if (RESPECT_ROBOTS && robots && blockedByRobots(t.pathname, robots.disallow)) return false;
  return true;
}

// ========= レイアウト指紋（重複検知） =========
const seenLayouts = new Set();
function hashString(s){ // 簡易ハッシュ（djb2）
  let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h) + s.charCodeAt(i);
  return (h>>>0).toString(36);
}
async function layoutSignature(page, limit = 200){
  return await page.evaluate((limit) => {
    const els = Array.from(document.querySelectorAll("body *")).slice(0, limit);
    return els.map(el => {
      const tag = el.tagName;
      const classes = (el.className || "").toString().trim().split(/\s+/).slice(0,2).join(".");
      const attrRole = el.getAttribute?.("role") || "";
      const idShort = (el.id || "").slice(0,10);
      return `${tag}${classes?'.'+classes:''}${attrRole?'[role='+attrRole+']':''}${idShort?`#${idShort}`:''}`;
    }).join("|");
  }, limit);
}
function shouldSkipByLayout(sig, url){
  if (!LAYOUT_DEDUP) return false;
  if (LAYOUT_IGNORE_URL_PATTERNS.some(p => p && new RegExp(p,"i").test(url))) return false;
  const key = hashString(sig);
  if (seenLayouts.has(key)) return true;
  seenLayouts.add(key);
  return false;
}

// ========= ナビゲーション（フォールバック/429等） =========
async function gotoSmart(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: GOTO_TIMEOUT_MS });
    return res;
  } catch {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  }
}

// ========= main =========
async function main(){
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"]
  });

  // robots
  const robots = RESPECT_ROBOTS ? await loadRobots(new URL(START_URLS[0]).origin) : { disallow: [], delay: 0 };
  WAIT_BETWEEN_MS = Math.max(WAIT_BETWEEN_MS, robots.delay || 0);

  // contexts
  const contexts = [];
  for (const vp of VIEWPORTS){
    const common = { userAgent: `SiteCaptureBot/1.0 (+https://example.com/contact)` };
    if (vp.kind === "preset"){
      const p = { ...vp.preset, deviceScaleFactor: (vp.preset.deviceScaleFactor ?? 1) * SCALE, ...common };
      const ctx = await browser.newContext(p);
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    } else {
      const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: SCALE, ...common });
      contexts.push({ label: vp.label, ctx, page: await ctx.newPage() });
    }
  }

  const visited = new Set();
  const queue = START_URLS.map(u=>({ start:u, url:u, depth:0 }));

  // sitemap 追加投入（任意）
  if (SITEMAP_URL) {
    try {
      const xml = await (await fetch(SITEMAP_URL)).text();
      const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1].trim());
      for (const u of locs) if (shouldVisit(u, START_URLS[0], robots)) queue.push({ start: START_URLS[0], url: u, depth: 0 });
    } catch (e) { console.error("sitemap load failed:", e.message || e); }
  }

  const captured = [];

  while (queue.length && visited.size < MAX_PAGES){
    const { start, url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (!shouldVisit(url, start, robots)) continue;
    visited.add(url);

    for (const dev of contexts){
      try{
        // リトライループ
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

        // ---- レイアウト重複チェック ----
        const sig = await layoutSignature(dev.page, LAYOUT_SAMPLE_LIMIT);
        if (shouldSkipByLayout(sig, url)) {
          console.log(`[skip-layout] Duplicate layout detected: ${url}`);
          continue;
        }

        // ---- スクショ ----
        const out = buildSavePath(url, dev.label, SCALE, FULL_PAGE, FILENAME_MODE);
        await fs.mkdir(path.dirname(out), { recursive: true });

        const masks = MASK_SELECTORS.map(sel => dev.page.locator(sel));
        const buf = await dev.page.screenshot({
          type:"png",
          fullPage: FULL_PAGE,
          mask: masks.length ? masks : undefined
        });
        await fs.writeFile(out, buf);

        captured.push({ url, device: dev.label, scale: SCALE, file: path.relative(OUT_DIR, out) });

        if (WAIT_BETWEEN_MS) await sleep(jitter(WAIT_BETWEEN_MS));
      } catch(e) {
        console.error(`[warn] ${dev.label} failed on ${url}:`, e.message || e);
      }
    }

    // 深さ
    if (depth >= MAX_DEPTH) continue;

    // 次リンク
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
