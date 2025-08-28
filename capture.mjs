// capture.mjs
import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const env = (k, d=null) => (process.env[k] ?? d);
const START_URLS = (env("START_URLS", "")).split(",").map(s=>s.trim()).filter(Boolean);
if (START_URLS.length === 0) throw new Error("環境変数 START_URLS に開始URLを指定してください（カンマ区切り可）");

const FULL_PAGE = (env("FULL_PAGE", "true").toLowerCase() === "true");
const DEVICES_RAW = env("DEVICES", "Desktop 1440x900,iPhone 13,iPad Air")
  .split(",").map(s=>s.trim()).filter(Boolean);
const SAME_HOST_ONLY = (env("SAME_HOST_ONLY", "true").toLowerCase() === "true");
const MAX_DEPTH = parseInt(env("MAX_DEPTH", "2"), 10);
const MAX_PAGES = parseInt(env("MAX_PAGES", "50"), 10);
const WAIT_BETWEEN_MS = parseInt(env("WAIT_BETWEEN_MS", "300"), 10);
const OUT_DIR = env("OUT_DIR", "screenshots");
const PATH_PREFIX_MODE = (env("PATH_PREFIX_MODE","start").toLowerCase()); // "start" | "none"
// start: 開始URLのパス配下のみ（例: /docs/ 以下だけ） / none: 制限なし（ホスト制限はSAME_HOST_ONLYに従う）

// 文字列 "1280x800" or "375x812" をパース
function parseWxH(s){
  const m = s.match(/(\d+)\s*x\s*(\d+)/i);
  return m ? {width:+m[1], height:+m[2]} : null;
}

// デバイスコンテキスト用の定義を用意
function resolveViewports(list){
  return list.map(item=>{
    if (pwDevices[item]) return { kind:"preset", label:item, preset: pwDevices[item] };
    const wh = parseWxH(item);
    if (wh) return { kind:"size", label:`${wh.width}x${wh.height}`, viewport: wh };
    // 文言付き "Desktop 1440x900" など
    const wh2 = parseWxH(item.replace(/[^\dx]/gi,""));
    if (wh2) return { kind:"size", label:item.replace(/\s+/g,"_"), viewport: wh2 };
    // デフォルト
    return { kind:"size", label:"Desktop_1440x900", viewport:{width:1440,height:900} };
  });
}

const VIEWPORTS = resolveViewports(DEVICES_RAW);

// URL正規化＆フィルタ
function normalizeUrl(u, base){
  try { return new URL(u, base).toString().replace(/#.*$/,""); }
  catch { return null; }
}

function shouldVisit(targetUrl, startUrl){
  const t = new URL(targetUrl);
  const s = new URL(startUrl);
  if (SAME_HOST_ONLY && t.host !== s.host) return false;

  if (PATH_PREFIX_MODE === "start"){
    // 開始URLのパスをprefixとして扱う
    const prefix = s.pathname.endsWith("/") ? s.pathname : s.pathname + "/";
    // 例: start=/docs/ のとき /docs/ か /docs で始まるのみ許可
    if (prefix !== "/" && !(t.pathname + "/").startsWith(prefix)) return false;
  }
  return ["http:", "https:"].includes(t.protocol);
}

function safeNameFromUrl(u) {
  const { host, pathname } = new URL(u);
  const p = pathname === "/" ? "root" : pathname.replace(/[^a-z0-9/_-]+/gi, "_").replace(/^_+|_+$/g,"");
  return (host + "__" + p).slice(0,180);
}

async function ensureDir(dir){ await fs.mkdir(dir, { recursive: true }); }

async function scrollForLazyLoad(page){
  await page.evaluate(async () => {
    const h = document.body ? document.body.scrollHeight : 0;
    window.scrollTo(0, h);
    await new Promise(r => setTimeout(r, 250));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 150));
  });
}

// メイン
async function main(){
  await ensureDir(OUT_DIR);

  // ブラウザ1つを共有し、デバイスごとにContext/Pageを再利用
  const browser = await chromium.launch();

  const contexts = [];
  for (const vp of VIEWPORTS){
    if (vp.kind === "preset"){
      const ctx = await browser.newContext(vp.preset);
      contexts.push({ ...vp, ctx, page: await ctx.newPage() });
    } else {
      const ctx = await browser.newContext({ viewport: vp.viewport });
      contexts.push({ ...vp, ctx, page: await ctx.newPage() });
    }
  }

  const visited = new Set();
  const queue = [];

  // 開始URLごとに、パスプレフィックス判定基準として保持
  const startEntries = START_URLS.map(u => ({ start:u, depth:0 }));
  for (const e of startEntries) queue.push(e);

  let visitedCount = 0;

  while (queue.length && visitedCount < MAX_PAGES){
    const current = queue.shift(); // { start, url?, depth }
    const currentUrl = current.url ?? current.start;
    const depth = current.depth;

    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    // ページへ移動してスクショ
    for (const dev of contexts){
      try{
        await dev.page.goto(currentUrl, { waitUntil: "networkidle", timeout: 45000 });
        await scrollForLazyLoad(dev.page);

        const name = safeNameFromUrl(currentUrl);
        const file = path.join(OUT_DIR, `${name}__${dev.label}${FULL_PAGE ? "__full" : ""}.png`);
        await ensureDir(path.dirname(file));

        await dev.page.screenshot({ path: file, fullPage: FULL_PAGE });
        // 少し待つ（負荷＆ブロック回避）
        if (WAIT_BETWEEN_MS) await new Promise(r => setTimeout(r, WAIT_BETWEEN_MS));
      }catch(err){
        console.error(`[warn] ${dev.label} failed on ${currentUrl}:`, err.message || err);
      }
    }

    visitedCount++;

    // 深さ制限
    if (depth >= MAX_DEPTH) continue;

    // リンク抽出（同一ページから一度だけ抽出すればよい→先頭のコンテキストでOK）
    let links = [];
    try{
      links = await contexts[0].page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    }catch{}

    // キューに追加
    const base = currentUrl;
    for (const raw of links){
      const abs = normalizeUrl(raw, base);
      if (!abs) continue;
      if (visited.has(abs)) continue;

      // どの開始URLセットに属するかを決定（最初にマッチしたstartを使う）
      let startForThis = null;
      for (const se of startEntries){
        if (shouldVisit(abs, se.start)){
          startForThis = se.start;
          break;
        }
      }
      if (!startForThis) continue;

      queue.push({ start: startForThis, url: abs, depth: depth + 1 });
      if (queue.length + visited.size >= MAX_PAGES) break;
    }
  }

  // 後片付け
  for (const dev of contexts){
    await dev.ctx.close();
  }
  await browser.close();

  console.log(`Done. visited=${visitedCount}, out=${OUT_DIR}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});