// capture.mjs
import { chromium, devices as pwDevices } from "playwright";
import fs from "fs/promises";
import path from "path";

const START_URLS = (process.env.START_URLS ?? "").split(",").map(s=>s.trim()).filter(Boolean);
if (!START_URLS.length) throw new Error("START_URLS を指定してください（カンマ区切り可）");

const FULL_PAGE = (process.env.FULL_PAGE ?? "true").toLowerCase()==="true";
const DEVICES = (process.env.DEVICES ?? "Desktop 1440x900,iPhone 13").split(",").map(s=>s.trim()).filter(Boolean);
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH ?? "0", 10);   // シンプル版なので既定0=開始URLのみ
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "50", 10);
const OUT_DIR = process.env.OUT_DIR ?? "public"; // ← Pagesでそのまま配れるよう public に

const parseWxH = s => { const m = s.match(/(\d+)\s*x\s*(\d+)/i); return m?{w:+m[1],h:+m[2]}:null; };
const vpList = DEVICES.map(d=>{
  if (pwDevices[d]) return {label:d, preset: pwDevices[d]};
  const wh=parseWxH(d)||parseWxH(d.replace(/[^\dx]/gi,""));
  return wh?{label:d.replace(/\s+/g,"_"), viewport:{width:wh.w, height:wh.h}}:{label:"Desktop_1440x900", viewport:{width:1440,height:900}};
});

const norm = (u,b)=>{ try{ return new URL(u,b).toString().replace(/#.*$/,""); }catch{ return null; } };
const safe = u => { const {host,pathname}=new URL(u); const p=pathname==="/"?"root":pathname.replace(/[^a-z0-9/_-]+/gi,"_"); return (host+"__"+p).slice(0,180); };

async function main(){
  await fs.mkdir(OUT_DIR,{recursive:true});
  const browser = await chromium.launch();
  const ctxs = [];
  for(const v of vpList){
    const ctx = v.preset ? await browser.newContext(v.preset) : await browser.newContext({viewport:v.viewport});
    ctxs.push({label:v.label, page: await ctx.newPage(), close: ()=>ctx.close()});
  }

  const q = START_URLS.map(u=>({url:u, depth:0}));
  const visited = new Set();
  const captured = []; // manifest用

  while(q.length && captured.length<MAX_PAGES){
    const {url, depth} = q.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    for(const dev of ctxs){
      try{
        await dev.page.goto(url,{waitUntil:"networkidle", timeout:45000});
        await dev.page.evaluate(async()=>{ const h=document.body?.scrollHeight||0; window.scrollTo(0,h); await new Promise(r=>setTimeout(r,250)); window.scrollTo(0,0); });
        const base = safe(url);
        const file = `${base}__${dev.label}${FULL_PAGE?"__full":""}.png`;
        const out = path.join(OUT_DIR, file);
        await fs.writeFile(out, await dev.page.screenshot({fullPage:FULL_PAGE}));
        captured.push({ url, device: dev.label, file: file });
      }catch(e){ console.error(`[warn] ${dev.label}: ${url}`, e.message); }
    }

    if (depth<MAX_DEPTH){
      try{
        const links = await ctxs[0].page.$$eval("a[href]", as => as.map(a=>a.getAttribute("href")));
        for(const l of links){
          const abs = norm(l, url);
          if (abs && !visited.has(abs)) q.push({url:abs, depth:depth+1});
        }
      }catch{}
    }
  }

  for(const c of ctxs) await c.close();
  await browser.close();

  await fs.writeFile(path.join(OUT_DIR,"manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), items: captured }, null, 2));
}
main();