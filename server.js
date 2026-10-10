// NFC Masa Sipariş Sunucusu — ek paket gerektirmez (Node 18+)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PASS = process.env.KASA_SIFRE || "1234";          // KASA ŞİFRESİNİ DEĞİŞTİRİN
const MPASS = process.env.MUTFAK_SIFRE || "";                 // isteğe bağlı: yalnızca mutfak ekranı
const SECRET = process.env.MASA_ANAHTARI || (PASS + "|masa");   // masa kodlarını üretir (sabit kalmalı)
const KEEP = (Number(process.env.GECMIS_GUN) || 30) * 86400e3;  // ödenen/iptal siparişlerin saklanma süresi
const FILE = process.env.DATA_FILE || path.join(__dirname, "orders.json");

// ───── Kalıcı kayıt (önerilir): Supabase REST. SUPABASE_URL + SUPABASE_KEY verilirse tüm veri orada saklanır ─────
// Yoksa dosyaya yazılır; Render ücretsiz planda dosyalar sunucu yeniden başlayınca silinir.
const clean = s => (s || "").trim().replace(/^["']|["']$/g, "").trim();
const DB_URL = clean(process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, "").replace(/\/$/, ""), DB_KEY = clean(process.env.SUPABASE_KEY);
const useDb = !!(DB_URL && DB_KEY);
const dirty = { settings: false, menu: false };
const snap = new Map();                                        // sipariş id → en son kaydedilen JSON
async function db(p, opt = {}) {
  const h = { apikey: DB_KEY, "Content-Type": "application/json", ...(opt.headers || {}) };
  if (DB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + DB_KEY;   // yeni "sb_secret_" anahtarları JWT değildir
  const r = await fetch(DB_URL + "/rest/v1/" + p, { ...opt, headers: h });
  if (!r.ok) throw new Error("DB " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json().catch(() => null);
}
const dbPut = rows => db("kv?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
async function dbLoad() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const part = await db("kv?select=key,value&order=key", { headers: { "Range-Unit": "items", Range: off + "-" + (off + 999) } });
    rows.push(...part); if (part.length < 1000) break;
  }
  return rows;
}
let flushQ = Promise.resolve(), flushTimer = null;
const persist = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 150); };
function flush() {                                             // yalnızca değişenleri yazar; hata olursa yeniden dener
  clearTimeout(flushTimer);
  flushQ = flushQ.then(async () => {
    const wasS = dirty.settings, wasM = dirty.menu, rows = [], ids = [];
    const cur = new Map(orders.map(o => [o.id, JSON.stringify(o)]));
    if (wasS) rows.push({ key: "settings", value: settings });
    if (wasM) rows.push({ key: "menu", value: MENU });
    dirty.settings = dirty.menu = false;
    for (const [id, j] of cur) if (snap.get(id) !== j) { rows.push({ key: "order:" + id, value: JSON.parse(j) }); ids.push(id); }
    const gone = [...snap.keys()].filter(id => !cur.has(id));
    try {
      if (rows.length) await dbPut(rows);
      for (let i = 0; i < gone.length; i += 50)
        await db("kv?key=in.(" + gone.slice(i, i + 50).map(id => encodeURIComponent('"order:' + id + '"')).join(",") + ")", { method: "DELETE", headers: { Prefer: "return=minimal" } });
      ids.forEach(id => snap.set(id, cur.get(id))); gone.forEach(id => snap.delete(id));
    } catch (e) {
      console.error("Kayıt hatası, 5 sn sonra yeniden denenecek:", e.message);
      dirty.settings = dirty.settings || wasS; dirty.menu = dirty.menu || wasM;
      clearTimeout(flushTimer); flushTimer = setTimeout(flush, 5000);
    }
  });
  return flushQ;
}
let ready = !useDb, dbErr = "";
function dbExplain(e) {
  const m = String((e && e.message) || e);
  if (/DB 40[13]/.test(m)) return "SUPABASE_KEY kabul edilmedi veya yazma yetkisi yok. Supabase > Project Settings > API Keys bölümünden service_role (secret) anahtarını kopyalayın; anon/publishable anahtar çalışmaz.";
  if (/DB 404|PGRST205|does not exist/.test(m)) return "Veritabanında 'kv' tablosu yok. supabase-kurulum.sql dosyasını Supabase > SQL Editor'da çalıştırın.";
  if (/fetch failed|ENOTFOUND|ECONN|timeout|Invalid URL/i.test(m)) return "Supabase'e ulaşılamıyor: SUPABASE_URL yanlış olabilir ya da proje duraklatılmış (Supabase panelinde Restore deyin).";
  return m;
}
async function init() {              // veritabanı hazır olana kadar API kapalı kalır; hazır olmadan asla yazmaz
  if (!useDb) return;
  for (;;) {
    try {
      const rows = await dbLoad();
      await dbPut([{ key: "ping", value: { ts: Date.now() } }]);     // yazma yetkisi testi (anon anahtar burada elenir)
      for (const { key, value } of rows) {
        if (key === "settings") Object.assign(settings, value);
        else if (key === "menu") { try { setMenu(cleanMenu(value)); } catch (e) { console.error("Kayıtlı menü okunamadı:", e.message); } }
        else if (key.startsWith("order:")) orders.push(value);
      }
      orders.sort((a, b) => a.ts - b.ts); orders.forEach(o => snap.set(o.id, JSON.stringify(o)));
      if (!rows.some(r => r.key === "settings")) { dirty.settings = true; persist(); }   // ilk kurulum
      ready = true; dbErr = "";
      console.log("Kalıcı kayıt: Supabase (" + rows.length + " kayıt yüklendi)");
      return;
    } catch (e) {
      dbErr = dbExplain(e); console.error("Veritabanı:", dbErr);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (useDb && ready ? flush() : Promise.resolve()).finally(() => process.exit(0)));

const DEFAULT_MENU = [
  { c: "Sıcak İçecekler", i: [["Türk Kahvesi", 90], ["Çay", 30], ["Latte", 120], ["Filtre Kahve", 100]] },
  { c: "Soğuk İçecekler", i: [["Limonata", 85], ["Ayran", 35], ["Kola", 55]] },
  { c: "Yemekler", i: [["Köfte Tabağı", 280], ["Tavuk Dürüm", 190], ["Karışık Pizza", 260], ["Mercimek Çorbası", 90]] },
  { c: "Tatlılar", i: [["Künefe", 160], ["Sütlaç", 95], ["Baklava", 180]] },
];
let MENU, PRICE;
function setMenu(m) {
  MENU = m; PRICE = Object.create(null);
  m.forEach(g => g.i.forEach(([n, p]) => (PRICE[n] = p)));
}
// Metin biçimi: "# Kategori" satırı, ardından "Ürün; fiyat" satırları
function parseMenu(text) {
  const menu = [], seen = new Set(); let cur = null, n = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const c = line.replace(/^#+\s*/, "").slice(0, 40);
      if (c) { cur = { c, i: [] }; menu.push(cur); }
      continue;
    }
    const m = line.match(/^(.+?)\s*[;|\t]\s*(\d+(?:[.,]\d+)?)\s*(?:₺|TL|tl)?$/) ||
              line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:₺|TL|tl)?$/);
    if (!m) throw new Error("Anlaşılmayan satır: " + line.slice(0, 40));
    if (!cur) { cur = { c: "Menü", i: [] }; menu.push(cur); }
    const name = m[1].replace(/[-:–]+$/, "").trim().slice(0, 60);
    const price = Number(m[2].replace(",", "."));
    if (!name || !(price >= 0 && price < 100000)) throw new Error("Geçersiz satır: " + line.slice(0, 40));
    if (seen.has(name)) throw new Error("Ürün iki kez var: " + name);
    seen.add(name); cur.i.push([name, price]);
    if (++n > 300) throw new Error("En fazla 300 ürün");
  }
  const out = menu.filter(g => g.i.length);
  if (!out.length) throw new Error("Menü boş");
  return out;
}
// Ekrandaki düzenleyiciden gelen menüyü doğrula/temizle
function cleanMenu(arr) {
  if (!Array.isArray(arr)) throw new Error("Geçersiz menü");
  const out = [], seen = new Set(); let n = 0;
  for (const g of arr) {
    const c = String((g && g.c) || "").replace(/[\r\n]/g, " ").trim().slice(0, 40);
    const items = [];
    for (const it of (g && g.i) || []) {
      const name = String((it && it[0]) || "").replace(/[;|\t\r\n]/g, " ").replace(/^#+\s*/, "").trim().slice(0, 60);
      if (!name) continue;
      const price = Math.round(Number(it[1]) * 100) / 100;
      if (!(price >= 0 && price < 100000)) throw new Error("Geçersiz fiyat: " + name);
      if (seen.has(name)) throw new Error("Ürün iki kez var: " + name);
      seen.add(name); items.push([name, price]);
      if (++n > 300) throw new Error("En fazla 300 ürün");
    }
    if (items.length) out.push({ c: c || "Menü", i: items });
  }
  if (!out.length) throw new Error("Menü boş");
  return out;
}
setMenu(DEFAULT_MENU);
if (process.env.MENU_METNI) {                                  // yalnızca başlangıç değeri; ekrandan kaydedilen menü bunun önüne geçer
  try { setMenu(parseMenu(process.env.MENU_METNI)); } catch (e) { console.error("MENU_METNI hatalı:", e.message); }
}
if (!useDb) { try { setMenu(cleanMenu(JSON.parse(fs.readFileSync(FILE + ".menu.json", "utf8")))); } catch (e) {} }
const HTML = "<!DOCTYPE html>\n<html lang=\"tr\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>NFC Masa Sipariş</title>\n<link rel=\"manifest\" href=\"/manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#c2410c\">\n<style>\n:root{--bg:#faf7f2;--card:#fff;--ink:#2a2018;--mute:#7a6c5f;--line:#e8dfd3;--acc:#c2410c;--acc2:#fff;--ok:#15803d;--warn:#b45309;\nbox-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#17130f;--card:#241e18;--ink:#f3ece4;--mute:#a89a8c;--line:#3a3128;--acc:#f97316;--acc2:#1a1209;--ok:#4ade80;--warn:#fbbf24}}\n:root[data-theme=\"dark\"]{--bg:#17130f;--card:#241e18;--ink:#f3ece4;--mute:#a89a8c;--line:#3a3128;--acc:#f97316;--acc2:#1a1209;--ok:#4ade80;--warn:#fbbf24}\nhtml{scroll-padding-top:env(safe-area-inset-top,0px)}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.w{max-width:960px;margin:0 auto;padding:16px 16px 160px}\nh1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}\n.top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}\n.badge{font-size:12px;padding:3px 9px;border-radius:99px;border:1px solid var(--line);color:var(--mute)}\n.badge.live{color:var(--ok);border-color:var(--ok)}\n.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}\n.row{display:flex;justify-content:space-between;align-items:center;gap:10px}\n.mute{color:var(--mute);font-size:14px}\nbutton{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px}\nbutton.p{background:var(--acc);color:var(--acc2);border-color:var(--acc);font-weight:600}\nbutton.q{width:38px;height:38px;padding:0;font-size:20px}\n.qty{display:flex;align-items:center;gap:10px}.qty b{min-width:18px;text-align:center}\n.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}\n.bar>div{max-width:960px;margin:0 auto}\ntextarea,input,select{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg);color:var(--ink)}\n.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}\n.st{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:99px;background:var(--line)}\n.st.Yeni{background:var(--acc);color:var(--acc2)}.st.Hazırlanıyor{color:var(--warn)}.st.Servis{color:var(--ok)}\nul{margin:6px 0;padding-left:18px}\n.toast{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);background:var(--ok);color:#fff;padding:10px 18px;border-radius:99px;z-index:9}\n.links{overflow-x:auto}.links .row{padding:6px 0;border-bottom:1px solid var(--line)}\n.links code{font-size:12px;word-break:break-all}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;margin-top:10px}\n.tile{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:10px;text-align:left;min-height:78px;font-size:14px}\n.tile span{font-size:12px;color:var(--mute)}\n.tile.tN{background:var(--acc);color:var(--acc2);border-color:var(--acc)}.tile.tN span{color:var(--acc2)}\n.tile.tH{border-color:var(--warn)}.tile.tS{border-color:var(--ok)}\n.tile.sel{outline:3px solid var(--ink)}\n.mi{gap:8px;margin-top:6px}.mi input:first-child{flex:1;min-width:0}.mi button{flex:none}.pr{width:92px!important;flex:none}\ndetails summary{cursor:pointer;font-weight:600}\n.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{padding:6px 12px;border-radius:99px}.chip.off{background:var(--line);text-decoration:line-through;color:var(--mute)}\n.late{color:#b91c1c;font-weight:700}\n.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}\n.hrs{display:flex;align-items:flex-end;gap:2px;height:64px;margin-top:6px}.hrs i{flex:1;background:var(--acc);border-radius:3px;min-height:2px}\na.badge{text-decoration:none;color:inherit}button.badge{background:none;color:inherit}\n.st.İptal{color:#b91c1c}\na{color:var(--acc)}\n</style>\n</head>\n<body>\n<div class=\"w\" id=\"app\"></div>\n<script>\nlet MENU=[],PRICE={};\nconst STAT=[\"Yeni\",\"Hazırlanıyor\",\"Servis edildi\",\"Ödendi\"];\nconst NEXT={\"Yeni\":\"Hazırlamaya başla\",\"Hazırlanıyor\":\"Servis edildi\",\"Servis edildi\":\"Ödendi\"};\nconst TL=n=>n.toLocaleString(\"tr-TR\")+\" ₺\";\nconst esc=s=>String(s).replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\n\nlet orders=[],cart={},note=\"\",tables=10,lastCount=-1,pass=\"\",sel=\"\",mdraft=null,mobj=null,lastMenu=0,mopen=false,me=\"\",st={ordering:true,banner:\"\",requireKey:false},calls=[],keys={},rep=null,rdays=1,lastRep=0,called={},disc={},bad=false,seen=new Set(),primed=false,streaming=false;\ntry{pass=sessionStorage.getItem(\"kp\")||\"\"}catch(e){}\nasync function api(p,o={}){\n  const r=await fetch(p,{...o,headers:{\"Content-Type\":\"application/json\",\"x-pass\":pass}});\n  if(r.status===401){pass=\"\";try{sessionStorage.removeItem(\"kp\")}catch(e){}render();throw new Error(\"auth\")}\n  if(!r.ok){let m=\"\";try{m=(await r.json()).error}catch(e){}throw new Error(m||r.status)}return r.json();\n}\nasync function addOrder(o){const r=await api(\"/api/orders\",{method:\"POST\",body:JSON.stringify({table:o.table,k:route().k,items:o.items.map(i=>({n:i.n,q:i.q})),note:o.note})});await poll();return r}\nasync function setStatus(id,s){await api(\"/api/orders/\"+id+\"/status\",{method:\"POST\",body:JSON.stringify({status:s})});await poll()}\nconst wait=o=>Math.floor((Date.now()-o.ts)/60000);\nconst call=async(p,body,okMsg)=>{try{const r=await api(p,{method:\"POST\",body:JSON.stringify(body)});if(okMsg)toast(okMsg);await poll();return r}catch(err){if(err.message!==\"auth\")toast(err.message||\"Hata\")}};\nasync function poll(){\n  const r=route();\n  try{\n    st=await api(\"/api/settings\");tables=st.tables;\n    if(r.v===\"m\"){\n      bad=false;\n      if(Date.now()-lastMenu>15000){lastMenu=Date.now();setMenuC(await api(\"/api/menu\"));pruneCart()}\n      orders=await api(\"/api/orders?table=\"+encodeURIComponent(r.t)+\"&k=\"+encodeURIComponent(r.k));\n    }else if((r.v===\"k\"||r.v===\"mut\")&&pass){\n      if(!me)me=(await api(\"/api/me\")).role;\n      orders=await api(\"/api/orders\");\n      calls=me===\"admin\"?await api(\"/api/calls\"):[];\n      if(me===\"admin\"&&r.v===\"k\"){\n        if(!keys[tables])keys=await api(\"/api/keys\");\n        if(Date.now()-lastRep>30000){lastRep=Date.now();rep=await api(\"/api/report?days=\"+rdays)}\n      }\n      alertNew();stream();\n    }else return;\n    const a=document.activeElement;\n    if(!a||(![\"note\",\"tc\",\"pw\",\"mt\",\"mf\",\"rd\"].includes(a.id)&&!/^(d-|s-|v-)/.test(a.id||\"\")&&!(a.closest&&a.closest(\"#medit\"))))render();\n  }catch(e){if(e.message===\"geçersiz kart\"){bad=true;render()}}\n}\n/* Anlık bağlantı: sunucu yeni sipariş/çağrı bildirince hemen poll() çalışır (arka planda zamanlayıcı yavaşlasa bile) */\nasync function stream(){\n  if(streaming||!pass)return;streaming=true;\n  try{const r=await fetch(\"/api/stream\",{headers:{\"x-pass\":pass}});if(!r.ok||!r.body)throw 0;\n    const rd=r.body.getReader();while(true){const x=await rd.read();if(x.done)break;poll()}}catch(e){}\n  streaming=false;setTimeout(()=>{const v=route().v;if(pass&&(v===\"k\"||v===\"mut\"))stream()},3000);\n}\nsetInterval(poll,3000);\nwindow.addEventListener(\"hashchange\",()=>{lastCount=-1;poll()});\nfetch(\"/api/menu\").then(r=>r.json()).then(m=>{MENU=m;MENU.forEach(g=>g.i.forEach(([n,p])=>PRICE[n]=p));return fetch(\"/api/settings\").then(r=>r.json()).then(x=>{st=x;tables=x.tables;render();poll()})});\n\n/* ---------- bildirim: zil + sesli okuma + sistem bildirimi + titreşim ---------- */\nlet actx=null,wl=null,ft=null;const baseTitle=document.title;\nfunction unlockAudio(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state===\"suspended\")actx.resume()}catch(e){}}\ndocument.addEventListener(\"pointerdown\",()=>{unlockAudio();keepAwake()});\nconst notifyOn=()=>{try{return \"Notification\" in window&&Notification.permission===\"granted\"&&localStorage.getItem(\"bildirim\")===\"1\"}catch(e){return false}};\nasync function keepAwake(){try{if(notifyOn()&&document.visibilityState===\"visible\"&&!wl&&navigator.wakeLock){wl=await navigator.wakeLock.request(\"screen\");wl.addEventListener(\"release\",()=>{wl=null})}}catch(e){}}\n/* Profesyonel zil: üç notalı, çan tınılı, yumuşak başlangıçlı; iki kez çalar */\nfunction chime(){try{unlockAudio();if(!actx)return;\n  const t0=actx.currentTime+.02,comp=actx.createDynamicsCompressor();comp.connect(actx.destination);\n  const bell=(f,t,vol)=>[[1,1,1.3],[2.01,.35,.9],[2.76,.18,.6]].forEach(([m,a,len])=>{\n    const o=actx.createOscillator(),g=actx.createGain();o.type=\"sine\";o.frequency.value=f*m;o.connect(g);g.connect(comp);\n    g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(vol*a,t+.012);g.gain.exponentialRampToValueAtTime(.0001,t+len);o.start(t);o.stop(t+len+.05)});\n  [0,1.5].forEach(d=>[1046.5,1318.5,1568].forEach((f,i)=>bell(f,t0+d+i*.16,.2)))}catch(e){}}\nconst lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}},lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}};\nconst trVoices=()=>{try{return speechSynthesis.getVoices().filter(v=>/^tr/i.test(v.lang))}catch(e){return[]}};\nconst voiceScore=v=>(/natural|neural|premium|enhanced|gelişmiş/i.test(v.name)?100:0)+(/online/i.test(v.name)?80:0)+(/google/i.test(v.name)?60:0)+(v.localService?0:5);\nfunction pickVoice(){const vs=trVoices();if(!vs.length)return null;const sv=lsGet(\"ses\");\n  return vs.find(v=>v.voiceURI===sv)||vs.slice().sort((a,b)=>voiceScore(b)-voiceScore(a))[0]}\nfunction speak(text,force){try{if(!(\"speechSynthesis\" in window)||(!force&&lsGet(\"sesli\")===\"0\"))return;\n  const u=new SpeechSynthesisUtterance(text);u.lang=\"tr-TR\";const v=pickVoice();if(v)u.voice=v;u.rate=.95;u.pitch=1;u.volume=1;\n  speechSynthesis.cancel();speechSynthesis.speak(u)}catch(e){}}\ntry{speechSynthesis.onvoiceschanged=()=>{if(route().v!==\"m\")render()}}catch(e){}\nfunction flashTitle(n){if(!document.hidden)return;clearInterval(ft);let on=false;ft=setInterval(()=>{on=!on;document.title=on?\"🔔 (\"+n+\") YENİ SİPARİŞ\":baseTitle},900)}\ndocument.addEventListener(\"visibilitychange\",()=>{if(!document.hidden){clearInterval(ft);document.title=baseTitle}});\nasync function showNote(x){try{const reg=await navigator.serviceWorker.getRegistration();if(!reg||Notification.permission!==\"granted\")return;\n  reg.showNotification(x.t,{body:x.b,tag:\"n-\"+Date.now()+Math.random(),renotify:true,requireInteraction:true,silent:false,vibrate:[300,120,300],icon:\"/icon.svg\",badge:\"/icon.svg\"})}catch(e){}}\nfunction ring(list,force){\n  chime();toast(\"🔔 \"+list.map(x=>x.b).join(\" • \"));flashTitle(list.length);\n  if(notifyOn()&&(document.hidden||force)){list.forEach(showNote);speak(list.map(x=>x.say||x.b).join(\" \"))}\n}\nfunction alertNew(){   // bildirim: \"Masa 1: 3 Çay\" · konuşma: \"Masa 1. 3 Çay.\"\n  const fresh=[];\n  orders.forEach(o=>{if(!seen.has(o.id)){seen.add(o.id);if(primed&&o.status===\"Yeni\")fresh.push({t:\"Yeni sipariş #\"+(o.no||\"\"),\n    b:\"Masa \"+o.table+\": \"+o.items.map(i=>i.q+\" \"+i.n).join(\", \")+(o.note?\" — Not: \"+o.note:\"\"),\n    say:\"Masa \"+o.table+\". \"+o.items.map(i=>i.q+\" \"+i.n).join(\", \")+\".\"+(o.note&&o.note.length<=60?\" Not: \"+o.note+\".\":\"\")})}});\n  calls.forEach(c=>{if(!seen.has(c.id)){seen.add(c.id);if(primed)fresh.push({t:\"Garson çağrısı\",b:\"Masa \"+c.table+\" garson çağırıyor\",say:\"Masa \"+c.table+\", garson çağırıyor.\"})}});\n  primed=true;if(fresh.length)ring(fresh);\n}\nasync function enableNotify(){\n  unlockAudio();\n  if(!(\"Notification\" in window)||!(\"serviceWorker\" in navigator)){toast(\"Bu tarayıcı bildirimi desteklemiyor. iPhone/iPad'de önce 'Ana ekrana ekle' yapın.\");return}\n  if(await Notification.requestPermission()!==\"granted\"){toast(\"Bildirim izni verilmedi\");return}\n  try{await navigator.serviceWorker.register(\"/sw.js\");await navigator.serviceWorker.ready}catch(e){toast(\"Bildirim kurulamadı\");return}\n  try{localStorage.setItem(\"bildirim\",\"1\")}catch(e){}\n  keepAwake();ring([{t:\"Bildirimler açık ✓\",b:\"Test: Masa 1: 3 Çay\",say:\"Bildirimler açık. Masa 1. 3 Çay.\"}],true);render();\n}\nif(notifyOn()&&\"serviceWorker\" in navigator)navigator.serviceWorker.register(\"/sw.js\").catch(()=>{});\n\n/* ---------- yönlendirme ---------- */\nfunction route(){\n  const h=location.hash.slice(1);\n  if(h.startsWith(\"masa=\")){let t=\"\";try{t=decodeURIComponent(h.slice(5))}catch(e){}const[tt,k]=t.split(\".\");return{v:\"m\",t:(tt||\"\").slice(0,20)||\"?\",k:k||\"\"}}\n  if(h===\"kasa\")return{v:\"k\"};\n  if(h===\"mutfak\")return{v:\"mut\"};\n  return{v:\"home\"};\n}\nwindow.addEventListener(\"hashchange\",render);\n\nconst badge=()=>`<span class=\"badge live\">● Canlı</span>`;\nconst menuText=()=>MENU.map(g=>\"# \"+g.c+\"\\n\"+g.i.map(([n,p])=>n+\"; \"+p).join(\"\\n\")).join(\"\\n\\n\");\nconst setMenuC=m=>{MENU=m;PRICE={};m.forEach(g=>g.i.forEach(([n,p])=>PRICE[n]=p))};\nconst pruneCart=()=>Object.keys(cart).forEach(n=>{if(!(n in PRICE))delete cart[n]});\nconst ens=()=>{if(!mobj)mobj=JSON.parse(JSON.stringify(MENU))};\nfunction editor(){\n  const m=mobj||MENU;\n  return m.map((g,gi)=>`<div class=\"card\"><div class=\"row mi\" style=\"margin-top:0\"><input data-f=\"c\" data-g=\"${gi}\" value=\"${esc(g.c)}\" style=\"font-weight:700\"><button data-a=\"gdel\" data-g=\"${gi}\">Kategoriyi sil</button></div>\n  ${g.i.map(([n,p],ii)=>`<div class=\"row mi\"><input data-f=\"n\" data-g=\"${gi}\" data-i=\"${ii}\" value=\"${esc(n)}\" placeholder=\"Ürün adı\"><input class=\"pr\" data-f=\"p\" data-g=\"${gi}\" data-i=\"${ii}\" type=\"number\" step=\"any\" min=\"0\" value=\"${esc(p)}\"><button class=\"q\" data-a=\"idel\" data-g=\"${gi}\" data-i=\"${ii}\">✕</button></div>`).join(\"\")}\n  <button data-a=\"iadd\" data-g=\"${gi}\" style=\"margin-top:8px\">+ Ürün ekle</button></div>`).join(\"\")+`<button data-a=\"gadd\">+ Kategori ekle</button>`;\n}\nconst base=()=>location.href.split(\"#\")[0];\n\n/* ---------- görünümler ---------- */\nfunction home(){\n  return `<div class=\"top\"><h1>🍽️ NFC Masa Sipariş</h1>${badge()}</div>\n  <p class=\"mute\">Demo: bir masa seçip müşteri ekranını deneyin, sonra kasa ekranında siparişi görün.</p>\n  <div class=\"card\"><div class=\"row\"><b>Müşteri ekranı</b><select id=\"pick\" style=\"width:auto\">${Array.from({length:tables},(_,i)=>`<option>${i+1}</option>`).join(\"\")}</select></div>\n  <button class=\"p\" data-a=\"goT\" style=\"margin-top:10px\">Masaya git</button></div>\n  <div class=\"card\"><b>Kasa ekranı</b><br><button class=\"p\" data-a=\"goK\" style=\"margin-top:10px\">Kasaya git</button></div>`;\n}\nfunction qtyRow(n,p,out){\n  const q=cart[n]||0;\n  if(out)return `<div class=\"card row\" style=\"opacity:.55\"><div><b>${esc(n)}</b><div class=\"mute\">${TL(p)}</div></div><span class=\"st\">Tükendi</span></div>`;\n  return `<div class=\"card row\"><div><b>${esc(n)}</b><div class=\"mute\">${TL(p)}</div></div>\n  <div class=\"qty\"><button class=\"q\" data-a=\"dec\" data-n=\"${esc(n)}\">−</button><b>${q}</b><button class=\"q\" data-a=\"inc\" data-n=\"${esc(n)}\">+</button></div></div>`;\n}\nfunction customer(t){\n  if(bad)return `<div class=\"top\"><h1>Masa ${esc(t)}</h1></div><div class=\"card\"><b>Bu kart geçerli değil.</b><div class=\"mute\">Lütfen masadaki NFC kartını yeniden okutun veya personele danışın.</div></div>`;\n  const mine=orders.filter(o=>String(o.table)===t&&(o.status===\"İptal\"?Date.now()-o.ts<1800e3:o.status!==\"Ödendi\")).sort((a,b)=>a.ts-b.ts);\n  const total=Object.entries(cart).reduce((s,[n,q])=>s+(PRICE[n]||0)*q,0);\n  const cnt=Object.values(cart).reduce((a,b)=>a+b,0);\n  const hot=ty=>called[ty]&&Date.now()-called[ty]<60000;\n  return `<div class=\"top\"><h1>Masa ${esc(t)}</h1>${badge()}</div>\n  ${st.banner?`<div class=\"card\" style=\"border-color:var(--acc)\">📢 ${esc(st.banner)}</div>`:\"\"}\n  ${st.ordering?\"\":`<div class=\"card\"><b>Şu an sipariş alınmıyor.</b><div class=\"mute\">Lütfen personele danışın.</div></div>`}\n  <div class=\"row\" style=\"gap:8px;margin:10px 0\"><button data-a=\"call\" data-ty=\"garson\" style=\"flex:1;height:48px\">${hot(\"garson\")?\"✓ Garson çağrıldı\":\"🛎 Garson çağır\"}</button></div>\n  ${mine.length?`<h2>Siparişleriniz</h2>`+mine.map(o=>`<div class=\"card\"><div class=\"row\"><span class=\"mute\">#${o.no||\"\"} · ${new Date(o.ts).toLocaleTimeString(\"tr-TR\",{hour:\"2-digit\",minute:\"2-digit\"})}</span><span class=\"st ${o.status.split(\" \")[0]}\">${esc(o.status)}</span></div>\n  <ul>${o.items.map(i=>`<li>${i.q}× ${esc(i.n)}</li>`).join(\"\")}</ul><b>${TL(o.total)}</b></div>`).join(\"\"):\"\"}\n  ${MENU.map(g=>`<h2>${esc(g.c)}</h2>`+g.i.map(([n,p,o])=>qtyRow(n,p,o)).join(\"\")).join(\"\")}\n  <div class=\"bar\"><div>\n   ${cnt?`<textarea id=\"note\" rows=\"1\" placeholder=\"Sipariş notu (isteğe bağlı)\">${esc(note)}</textarea>`:\"\"}\n   <div class=\"row\" style=\"margin-top:${cnt?8:0}px\"><div><b>${TL(total)}</b><div class=\"mute\">${cnt} ürün</div></div>\n   <button class=\"p\" data-a=\"send\" ${cnt&&st.ordering?\"\":\"disabled style='opacity:.5'\"}>Siparişi Gönder</button></div></div></div>`;\n}\nfunction kasa(){\n  const all=orders.filter(o=>o.status!==\"Ödendi\"&&o.status!==\"İptal\").sort((a,b)=>a.ts-b.ts);\n  const act=sel?all.filter(o=>String(o.table)===sel):all;\n  const byT={};all.forEach(o=>{(byT[o.table]=byT[o.table]||[]).push(o)});\n  const ids=[...Array.from({length:tables},(_,i)=>String(i+1)),...Object.keys(byT).filter(t=>!(+t>=1&&+t<=tables))];\n  const tile=t=>{const os=byT[t]||[],tot=os.reduce((s,o)=>s+o.total,0);\n   const k=!os.length?\"t0\":os.some(o=>o.status===\"Yeni\")?\"tN\":os.some(o=>o.status===\"Hazırlanıyor\")?\"tH\":\"tS\";\n   const lb={t0:\"Boş\",tN:\"Yeni sipariş\",tH:\"Hazırlanıyor\",tS:\"Hesap bekliyor\"}[k];\n   return `<button class=\"tile ${k}${sel===t?\" sel\":\"\"}\" data-a=\"sel\" data-t=\"${esc(t)}\"><b>Masa ${esc(t)}${calls.some(c=>c.table===t)?\" 🔔\":\"\"}</b><span>${lb}</span>${tot?`<span>${TL(tot)}</span>`:\"\"}</button>`};\n  const col=s=>act.filter(o=>o.status===s);\n  const card=o=>{const w=wait(o),late=(o.status===\"Yeni\"||o.status===\"Hazırlanıyor\")&&w>10;return `<div class=\"card\"><div class=\"row\"><b>#${o.no||\"\"} · Masa ${esc(o.table)}</b><span class=\"${late?\"late\":\"mute\"}\">${w} dk · ${new Date(o.ts).toLocaleTimeString(\"tr-TR\",{hour:\"2-digit\",minute:\"2-digit\"})}</span></div>\n   <ul>${o.items.map(i=>`<li>${i.q}× ${esc(i.n)}</li>`).join(\"\")}</ul>${o.note?`<div class=\"mute\">📝 ${esc(o.note)}</div>`:\"\"}\n   <div class=\"row\" style=\"margin-top:8px\"><b>${TL(o.total)}</b><span><button data-a=\"cancel\" data-id=\"${esc(o.id)}\">İptal</button>${NEXT[o.status]?` <button class=\"p\" data-a=\"next\" data-id=\"${esc(o.id)}\">${NEXT[o.status]}</button>`:\"\"}</span></div></div>`};\n  const bills={};act.forEach(o=>bills[o.table]=(bills[o.table]||0)+o.total);\n  return `<div class=\"top\"><h1>🧾 Kasa</h1><span style=\"display:flex;gap:6px;flex-wrap:wrap;align-items:center\"><button data-a=\"notify\" class=\"badge\">${notifyOn()?\"🔔 Bildirim açık\":\"🔕 Bildirimleri aç\"}</button><a href=\"#mutfak\" class=\"badge\">Mutfak ekranı</a><button data-a=\"logout\" class=\"badge\">Çıkış</button>${badge()}</span></div>\n  ${st.persist||/^(localhost|127\\.|192\\.168\\.)/.test(location.hostname)?\"\":`<p class=\"alert\" style=\"margin-top:12px\">⚠ Veritabanı bağlı değil: sunucu yeniden başlarsa menü, ayarlar ve siparişler silinebilir. Kurulum için “Kalıcı kayıt” adımlarına bakın (Supabase).</p>`}\n  ${calls.length?`<div class=\"card\" style=\"border-color:var(--acc);margin-top:12px\"><b>🔔 Çağrılar</b>${calls.map(c=>`<div class=\"row\" style=\"margin-top:6px\"><span>Masa ${esc(c.table)} — garson çağırıyor</span><button class=\"p\" data-a=\"clr\" data-id=\"${esc(c.id)}\">Tamam</button></div>`).join(\"\")}</div>`:\"\"}\n  <div class=\"row\" style=\"margin-top:14px\"><h2 style=\"margin:0\">Masalar</h2><span class=\"mute\">Masa sayısı <input id=\"tc\" type=\"number\" min=\"1\" max=\"200\" value=\"${tables}\" style=\"width:80px;display:inline-block\"></span></div>\n  <div class=\"grid\">${ids.map(tile).join(\"\")}</div>\n  ${sel?`<div class=\"mute\" style=\"margin-top:8px\">Masa ${esc(sel)} gösteriliyor · <a href=\"#kasa\" data-a=\"sel\" data-t=\"\">Tümünü göster</a></div>`:\"\"}\n  <div class=\"cols\">${STAT.slice(0,3).map(s=>`<div><h2>${s} (${col(s).length})</h2>${col(s).map(card).join(\"\")||'<div class=\"mute\">—</div>'}</div>`).join(\"\")}</div>\n  <h2>Açık hesaplar</h2>\n  ${Object.keys(bills).length?Object.entries(bills).map(([t,v])=>`<div class=\"card\"><div class=\"row\"><b>Masa ${esc(t)}</b><b>${TL(v)}</b></div><div class=\"row\" style=\"margin-top:8px;gap:8px;flex-wrap:wrap\"><input id=\"d-${esc(t)}\" data-d=\"${esc(t)}\" type=\"number\" min=\"0\" max=\"100\" placeholder=\"İndirim %\" value=\"${esc(disc[t]||\"\")}\" style=\"width:110px\"><span><button class=\"p\" data-a=\"close\" data-m=\"nakit\" data-t=\"${esc(t)}\">Nakit</button> <button class=\"p\" data-a=\"close\" data-m=\"kart\" data-t=\"${esc(t)}\">Kart</button> <button data-a=\"move\" data-t=\"${esc(t)}\">Taşı</button></span></div></div>`).join(\"\"):'<div class=\"mute\">Açık hesap yok.</div>'}\n  ${reportBox()}${stockBox()}${settingsBox()}${voiceBox()}\n  <h2>Menü</h2>\n  <div id=\"medit\">${editor()}</div>\n  <div class=\"row\" style=\"margin:10px 0;flex-wrap:wrap;gap:8px\"><span class=\"mute\">${mobj?\"⚠ Kaydedilmemiş değişiklikler var\":\"Fiyat ve adları değiştirip kaydedin\"}</span>\n  <span>${mobj?`<button data-a=\"ereset\">Vazgeç</button> `:\"\"}<button class=\"p\" data-a=\"esave\">Menüyü kaydet</button></span></div>\n  <details class=\"card\" id=\"mdet\"${mopen?\" open\":\"\"}><summary>Toplu düzenle: metin / .txt dosyası</summary>\n  <p class=\"mute\">Kategori satırı <code>#</code> ile başlar, ürün satırları <code>Ürün; fiyat</code> biçimindedir. UTF-8 kaydedilmiş bir .txt dosyası yükleyebilirsiniz.</p>\n  <textarea id=\"mt\" rows=\"12\">${esc(mdraft===null?menuText():mdraft)}</textarea>\n  <div class=\"row\" style=\"margin-top:8px;flex-wrap:wrap\"><input id=\"mf\" type=\"file\" accept=\".txt,text/plain\" style=\"width:auto\"><span><button data-a=\"mcopy\">Metni kopyala</button> <button class=\"p\" data-a=\"msave\">Metinden kaydet</button></span></div></details>\n  <p class=\"mute\">Render ücretsiz planda sunucu yeniden başlayınca menü eski haline döner. Kalıcı olması için kaydettikten sonra <button data-a=\"acopy\" style=\"padding:3px 10px\">Menü metnini kopyala</button> deyip Render → Environment → <code>MENU_METNI</code> alanına yapıştırın.</p>\n  <h2>NFC kart bağlantıları</h2>\n  <div class=\"card\">\n  <p class=\"mute\">Her bağlantıyı ilgili masanın NFC kartına “URL/Web bağlantısı” olarak yazın (NFC Tools vb. uygulamayla). Adresin sonundaki kod, masa kodudur; “Masa kodu zorunlu” açıksa kodsuz adresler çalışmaz.</p>\n  <div class=\"links\">${Array.from({length:tables},(_,i)=>{const u=base()+\"#masa=\"+(i+1)+(keys[i+1]?\".\"+keys[i+1]:\"\");return `<div class=\"row\"><span>Masa ${i+1}<br><code>${esc(u)}</code></span><button data-a=\"copy\" data-u=\"${esc(u)}\">Kopyala</button></div>`}).join(\"\")}</div></div>`;\n}\n\nconst kcard=o=>{const w=wait(o);return `<div class=\"card\"><div class=\"row\"><b style=\"font-size:20px\">#${o.no||\"\"} · Masa ${esc(o.table)}</b><span class=\"${w>10?\"late\":\"mute\"}\">${w} dk</span></div>\n  <ul style=\"font-size:18px\">${o.items.map(i=>`<li>${i.q}× ${esc(i.n)}</li>`).join(\"\")}</ul>${o.note?`<div class=\"mute\" style=\"font-size:16px\">📝 ${esc(o.note)}</div>`:\"\"}\n  <button class=\"p\" data-a=\"next\" data-id=\"${esc(o.id)}\" style=\"width:100%;margin-top:8px;height:52px\">${o.status===\"Yeni\"?\"Hazırlamaya başla\":\"Servis edildi\"}</button></div>`};\nfunction mutfak(){\n  const os=orders.filter(o=>o.status===\"Yeni\"||o.status===\"Hazırlanıyor\").sort((a,b)=>a.ts-b.ts);\n  return `<div class=\"top\"><h1>👨‍🍳 Mutfak</h1><span style=\"display:flex;gap:6px;flex-wrap:wrap;align-items:center\"><button data-a=\"notify\" class=\"badge\">${notifyOn()?\"🔔 Bildirim açık\":\"🔕 Bildirimleri aç\"}</button>${me===\"admin\"?'<a href=\"#kasa\" class=\"badge\">Kasa</a>':\"\"}<button data-a=\"logout\" class=\"badge\">Çıkış</button>${badge()}</span></div>\n  <div class=\"cols\">${[\"Yeni\",\"Hazırlanıyor\"].map(s=>`<div><h2>${s} (${os.filter(o=>o.status===s).length})</h2>${os.filter(o=>o.status===s).map(kcard).join(\"\")||'<div class=\"mute\">—</div>'}</div>`).join(\"\")}</div>${voiceBox()}`;\n}\nfunction reportBox(){\n  const r=rep,mx=r?Math.max(1,...r.hours):1;\n  return `<div class=\"row\"><h2 style=\"margin:22px 0 8px\">Rapor</h2><select id=\"rd\" style=\"width:auto\">${[[1,\"Bugün\"],[7,\"Son 7 gün\"],[30,\"Son 30 gün\"]].map(([v,l])=>`<option value=\"${v}\"${rdays===v?\" selected\":\"\"}>${l}</option>`).join(\"\")}</select></div>\n  <div class=\"card\">${r?`<div class=\"stats\"><div><div class=\"mute\">Ciro</div><b>${TL(r.revenue)}</b></div><div><div class=\"mute\">Sipariş</div><b>${r.orders}</b></div><div><div class=\"mute\">İptal</div><b>${r.cancelled}</b></div><div><div class=\"mute\">Nakit</div><b>${TL(r.nakit)}</b></div><div><div class=\"mute\">Kart</div><b>${TL(r.kart)}</b></div><div><div class=\"mute\">Ort. sipariş</div><b>${TL(r.avg)}</b></div></div>\n  <div class=\"mute\" style=\"margin-top:12px\">En çok satanlar</div>${r.top.length?`<ol style=\"margin:4px 0\">${r.top.map(([n,q])=>`<li>${esc(n)} — ${q} adet</li>`).join(\"\")}</ol>`:'<div class=\"mute\">Veri yok</div>'}\n  <div class=\"mute\" style=\"margin-top:10px\">Saate göre sipariş</div><div class=\"hrs\">${r.hours.map((h,i)=>`<i title=\"${i}:00 · ${h}\" style=\"height:${h/mx*100}%\"></i>`).join(\"\")}</div>`:'<span class=\"mute\">Yükleniyor…</span>'}\n  <button data-a=\"csv\" style=\"margin-top:12px\">CSV indir</button></div>`;\n}\nfunction stockBox(){\n  return `<h2>Stok (tükenenleri işaretleyin)</h2><div class=\"card\"><div class=\"chips\">${MENU.flatMap(g=>g.i).map(([n,,o])=>`<button class=\"chip${o?\" off\":\"\"}\" data-a=\"stock\" data-n=\"${esc(n)}\" data-o=\"${o?0:1}\">${esc(n)}${o?\" · tükendi\":\"\"}</button>`).join(\"\")}</div></div>`;\n}\nfunction settingsBox(){\n  return `<h2>Sipariş ayarları</h2><div class=\"card\" style=\"display:grid;gap:12px\">\n  <div class=\"mute\">Kayıt: ${st.persist?\"veritabanı ✓ (kalıcı)\":\"geçici dosya\"}</div>\n  <label class=\"row\"><span>Sipariş alımı açık</span><input type=\"checkbox\" id=\"s-ord\" ${st.ordering?\"checked\":\"\"} style=\"width:auto\"></label>\n  <div><div class=\"mute\">Müşterilerin en üstte göreceği duyuru</div><input id=\"s-ban\" maxlength=\"160\" value=\"${esc(st.banner||\"\")}\" placeholder=\"Örn: Bugün çorba mercimek\"></div>\n  <label class=\"row\"><span>Masa kodu zorunlu</span><input type=\"checkbox\" id=\"s-key\" ${st.requireKey?\"checked\":\"\"} style=\"width:auto\"></label>\n  <p class=\"mute\" style=\"margin:0\">Açıkken yalnızca kodlu NFC adresleri sipariş verebilir; başkası adresi tahmin edip başka masadan sipariş veremez. Önce kartları aşağıdaki kodlu adreslerle yazın, sonra açın.</p></div>`;\n}\nfunction voiceBox(){\n  const vs=trVoices(),sel=pickVoice(),on=lsGet(\"sesli\")!==\"0\";\n  return `<h2>Sesli okuma</h2><div class=\"card\" style=\"display:grid;gap:10px\">\n  <label class=\"row\"><span>Siparişleri sesli oku</span><input type=\"checkbox\" id=\"v-on\" ${on?\"checked\":\"\"} style=\"width:auto\"></label>\n  ${vs.length?`<select id=\"v-sel\">${vs.map(v=>`<option value=\"${esc(v.voiceURI)}\"${sel&&sel.voiceURI===v.voiceURI?\" selected\":\"\"}>${esc(v.name)}</option>`).join(\"\")}</select>`:'<p class=\"mute\" style=\"margin:0\">Bu cihazda Türkçe ses bulunamadı. Cihaz ayarlarından Türkçe ses paketini yükleyin.</p>'}\n  <button data-a=\"vtest\">Sesi dene</button>\n  <p class=\"mute\" style=\"margin:0\">Sesler cihaza göre değişir. Genelde en doğal olanlar: Edge'de “Natural” sesler, Android'de “Google Türkçe”, iPhone'da “Yelda (Gelişmiş)”.</p></div>`;\n}\nfunction login(){return `<h1>🧾 Personel girişi</h1><div class=\"card\"><input id=\"pw\" type=\"password\" placeholder=\"Şifre\"><button class=\"p\" data-a=\"login\" style=\"margin-top:10px\">Giriş</button></div>`}\nfunction render(){\n  const r=route(),app=document.getElementById(\"app\");\n  const keep=document.activeElement&&document.activeElement.id===\"note\";\n  app.innerHTML=r.v===\"m\"?customer(r.t):(r.v===\"k\"||r.v===\"mut\")?(!pass?login():!me?'<p class=\"mute\">Yükleniyor…</p>':(r.v===\"mut\"||me===\"mutfak\")?mutfak():kasa()):home();\n  if(keep){const n=document.getElementById(\"note\");if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length)}}\n}\n\nfunction toast(m){const d=document.createElement(\"div\");d.className=\"toast\";d.textContent=m;document.body.appendChild(d);setTimeout(()=>d.remove(),2500)}\n\n/* ---------- olaylar ---------- */\ndocument.addEventListener(\"click\",async e=>{\n  const b=e.target.closest(\"[data-a]\");if(!b)return;\n  const a=b.dataset.a;\n  if(a===\"inc\"){cart[b.dataset.n]=(cart[b.dataset.n]||0)+1;render()}\n  else if(a===\"dec\"){const n=b.dataset.n;if(cart[n]>1)cart[n]--;else delete cart[n];render()}\n  else if(a===\"send\"){\n    const t=route().t;\n    const items=Object.entries(cart).map(([n,q])=>({n,q,p:PRICE[n]||0}));\n    if(!items.length||!st.ordering)return;\n    b.disabled=true;\n    try{const res=await addOrder({table:t,items,note:note.trim().slice(0,200)});cart={};note=\"\";toast(\"Siparişiniz alındı ✓ #\"+res.no);render()}\n    catch(err){b.disabled=false;const m=err.message;\n      if(m===\"geçersiz ürün\"||m.startsWith(\"Tükendi\")){try{setMenuC(await api(\"/api/menu\"));pruneCart();toast(m.startsWith(\"Tükendi\")?m:\"Menü güncellenmiş, sepeti kontrol edip tekrar deneyin\")}catch(e2){toast(\"Gönderilemedi\")}render()}\n      else if(m===\"kapalı\"){toast(\"Şu an sipariş alınmıyor\");await poll()}\n      else if(m===\"geçersiz kart\"){bad=true;render()}\n      else toast(\"Gönderilemedi, tekrar deneyin\")}\n  }\n  else if(a===\"next\"){const o=orders.find(x=>x.id===b.dataset.id);if(o)await setStatus(o.id,STAT[STAT.indexOf(o.status)+1])}\n  else if(a===\"close\"){const t=b.dataset.t;if(confirm(\"Masa \"+t+\" hesabı \"+b.dataset.m+\" ile kapatılsın mı?\")){if(await call(\"/api/close\",{table:t,method:b.dataset.m,discount:Number(disc[t])||0},\"Hesap kapatıldı ✓\"))delete disc[t]}}\n  else if(a===\"copy\"){try{await navigator.clipboard.writeText(b.dataset.u);toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"login\"){pass=document.getElementById(\"pw\").value;try{sessionStorage.setItem(\"kp\",pass)}catch(err){}me=\"\";seen.clear();primed=false;unlockAudio();await poll();if(!pass)toast(\"Şifre hatalı\");render()}\n  else if(a===\"sel\"){sel=sel===b.dataset.t?\"\":b.dataset.t;render()}\n  else if(a===\"msave\"){\n    try{const r=await api(\"/api/menu\",{method:\"POST\",body:JSON.stringify({text:document.getElementById(\"mt\").value})});setMenuC(r);mobj=null;mdraft=null;toast(\"Menü kaydedildi ✓\");render()}\n    catch(err){if(err.message!==\"auth\")toast(err.message)}\n  }\n  else if(a===\"mcopy\"){try{await navigator.clipboard.writeText(document.getElementById(\"mt\").value);toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"gdel\"){ens();mobj.splice(+b.dataset.g,1);render()}\n  else if(a===\"idel\"){ens();mobj[+b.dataset.g].i.splice(+b.dataset.i,1);render()}\n  else if(a===\"iadd\"){ens();mobj[+b.dataset.g].i.push([\"\",0]);render()}\n  else if(a===\"gadd\"){ens();mobj.push({c:\"Yeni kategori\",i:[[\"\",0]]});render()}\n  else if(a===\"ereset\"){mobj=null;render()}\n  else if(a===\"acopy\"){try{await navigator.clipboard.writeText(menuText());toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"esave\"){\n    try{const r=await api(\"/api/menu\",{method:\"POST\",body:JSON.stringify({menu:mobj||MENU})});setMenuC(r);mobj=null;mdraft=null;toast(\"Menü kaydedildi ✓\");render()}\n    catch(err){if(err.message!==\"auth\")toast(err.message)}\n  }\n  else if(a===\"call\"){const ty=b.dataset.ty;try{await api(\"/api/call\",{method:\"POST\",body:JSON.stringify({table:route().t,k:route().k,type:ty})});called[ty]=Date.now();toast(\"Garson çağrıldı ✓\");render()}catch(err){toast(err.message===\"çok fazla istek\"?\"Biraz sonra tekrar deneyin\":err.message===\"geçersiz kart\"?\"Kart geçerli değil\":\"Gönderilemedi\")}}\n  else if(a===\"clr\")await call(\"/api/calls/clear\",{id:b.dataset.id});\n  else if(a===\"cancel\"){const why=prompt(\"İptal nedeni (isteğe bağlı)\");if(why!==null)await call(\"/api/orders/\"+b.dataset.id+\"/status\",{status:\"İptal\",why})}\n  else if(a===\"move\"){const to=prompt(\"Masa \"+b.dataset.t+\" hangi masaya taşınsın? (numara)\");if(to){await call(\"/api/move\",{from:b.dataset.t,to:to.trim()},\"Taşındı ✓\");sel=\"\"}}\n  else if(a===\"stock\"){const r=await call(\"/api/soldout\",{name:b.dataset.n,out:b.dataset.o===\"1\"});if(r){setMenuC(r);render()}}\n  else if(a===\"csv\"){try{const r=await fetch(\"/api/export?days=\"+rdays,{headers:{\"x-pass\":pass}});if(!r.ok)throw 0;const u=URL.createObjectURL(await r.blob()),l=document.createElement(\"a\");l.href=u;l.download=\"siparisler.csv\";l.click();URL.revokeObjectURL(u)}catch(err){toast(\"İndirilemedi\")}}\n  else if(a===\"logout\"){pass=\"\";me=\"\";seen.clear();primed=false;try{sessionStorage.removeItem(\"kp\")}catch(err){}render()}\n  else if(a===\"notify\")await enableNotify();\n  else if(a===\"vtest\")speak(\"Masa 1. 3 Çay, 1 Latte.\",true);\n  else if(a===\"goT\"){location.hash=\"masa=\"+document.getElementById(\"pick\").value}\n  else if(a===\"goK\"){location.hash=\"kasa\"}\n});\ndocument.addEventListener(\"toggle\",e=>{if(e.target.id===\"mdet\")mopen=e.target.open},true);\ndocument.addEventListener(\"input\",e=>{\n  if(e.target.id===\"note\")note=e.target.value;\n  if(e.target.id===\"mt\")mdraft=e.target.value;\n  if(e.target.dataset&&e.target.dataset.d)disc[e.target.dataset.d]=e.target.value;\n  const t=e.target;\n  if(t.dataset&&t.dataset.f){\n    ens();const g=mobj[+t.dataset.g];if(!g)return;\n    if(t.dataset.f===\"c\")g.c=t.value;\n    else{const it=g.i[+t.dataset.i];if(!it)return;if(t.dataset.f===\"n\")it[0]=t.value;else it[1]=Number(t.value)||0}\n  }\n});\ndocument.addEventListener(\"change\",async e=>{\n  if(e.target.id===\"v-on\")lsSet(\"sesli\",e.target.checked?\"1\":\"0\");\n  if(e.target.id===\"v-sel\"){lsSet(\"ses\",e.target.value);speak(\"Masa 1. 3 Çay.\",true)}\n  if(e.target.id===\"rd\"){rdays=+e.target.value;lastRep=0;poll()}\n  if(e.target.id===\"s-ord\")await call(\"/api/settings\",{ordering:e.target.checked},e.target.checked?\"Sipariş alımı açıldı\":\"Sipariş alımı kapatıldı\");\n  if(e.target.id===\"s-ban\")await call(\"/api/settings\",{banner:e.target.value},\"Duyuru kaydedildi\");\n  if(e.target.id===\"s-key\"){\n    if(e.target.checked&&!confirm(\"Kodsuz (eski) NFC kartları çalışmayı bırakır. Kartları kodlu adreslerle yazdınız mı?\")){e.target.checked=false;return}\n    await call(\"/api/settings\",{requireKey:e.target.checked},\"Kaydedildi\");\n  }\n  if(e.target.id===\"mf\"){\n    const f=e.target.files[0];if(!f)return;\n    if(f.size>40000){toast(\"Dosya çok büyük\");return}\n    mdraft=(await f.text()).replace(/^\\uFEFF/,\"\");mopen=true;render();toast(\"Dosya yüklendi, kaydetmeyi unutmayın\");\n  }\n  if(e.target.id===\"tc\"){\n    const v=Math.max(1,Math.min(200,parseInt(e.target.value)||1));\n    try{const r=await api(\"/api/settings\",{method:\"POST\",body:JSON.stringify({tables:v})});tables=r.tables;toast(\"Masa sayısı: \"+tables)}\n    catch(err){toast(\"Kaydedilemedi\")}\n    render();\n  }\n});\nrender();\n</script>\n</body>\n</html>\n";
const STAT = ["Yeni", "Hazırlanıyor", "Servis edildi", "Ödendi", "İptal"];

let orders = [];
if (!useDb) { try { orders = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {} }
let settings = { tables: Number(process.env.MASA_SAYISI) || 10, ordering: true, banner: "", requireKey: false, soldOut: [], counter: { day: "", n: 0 } };
let calls = [];
if (!useDb) { try { Object.assign(settings, JSON.parse(fs.readFileSync(FILE + ".ayar", "utf8"))); } catch (e) {} }
const saveSettings = () => { if (useDb) { dirty.settings = true; persist(); } else fs.writeFile(FILE + ".ayar", JSON.stringify(settings), () => {}); };
const saveMenu = () => { if (useDb) { dirty.menu = true; persist(); } else fs.writeFile(FILE + ".menu.json", JSON.stringify(MENU), () => {}); };
const pubSettings = () => ({ tables: settings.tables, ordering: settings.ordering, banner: settings.banner, requireKey: settings.requireKey, persist: useDb });
const menuOut = () => MENU.map(g => ({ c: g.c, i: g.i.map(([n, p]) => [n, p, settings.soldOut.includes(n)]) }));
const validTable = t => { const n = parseInt(t); return n >= 1 && n <= settings.tables && String(n) === t; };
const keyFor = t => crypto.createHmac("sha256", SECRET).update("masa:" + t).digest("hex").slice(0, 8);
const keyOk = (t, k) => {          // masa kodu zorunlu değilse herkese açık
  if (!settings.requireKey) return true;
  const a = Buffer.from(String(k || "")), b = Buffer.from(keyFor(t));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const TR = 3 * 3600e3;             // Türkiye UTC+3 (yaz saati yok)
const dayStr = ts => new Date(ts + TR).toISOString().slice(0, 10);
const startOf = days => Date.parse(dayStr(Date.now()) + "T00:00:00+03:00") - (days - 1) * 86400e3;
function nextNo() {
  const d = dayStr(Date.now());
  if (settings.counter.day !== d) settings.counter = { day: d, n: 0 };
  settings.counter.n++; saveSettings();
  return settings.counter.n;
}
const isOpen = o => o.status !== "Ödendi" && o.status !== "İptal";
function report(days) {
  const os = orders.filter(o => o.ts >= startOf(days));
  const live = os.filter(o => o.status !== "İptal"), paid = os.filter(o => o.status === "Ödendi");
  const amt = o => o.paid ?? o.total, sum = a => Math.round(a.reduce((s, o) => s + amt(o), 0) * 100) / 100;
  const top = {}; live.forEach(o => o.items.forEach(i => (top[i.n] = (top[i.n] || 0) + i.q)));
  const hours = Array(24).fill(0); live.forEach(o => hours[new Date(o.ts + TR).getUTCHours()]++);
  const revenue = sum(paid);
  return { days, orders: live.length, cancelled: os.length - live.length, revenue,
    nakit: sum(paid.filter(o => o.method === "nakit")), kart: sum(paid.filter(o => o.method === "kart")),
    avg: paid.length ? Math.round(revenue / paid.length * 100) / 100 : 0,
    top: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5), hours };
}
function csv(days) {
  const cell = v => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };  // Excel formül enjeksiyonuna karşı
  const rows = [["No", "Tarih", "Masa", "Ürünler", "Not", "Tutar", "Ödenen", "Yöntem", "Durum"]];
  orders.filter(o => o.ts >= startOf(days)).sort((a, b) => a.ts - b.ts).forEach(o => rows.push([
    o.no ?? "", new Date(o.ts + TR).toISOString().slice(0, 16).replace("T", " "), o.table,
    o.items.map(i => i.q + "x " + i.n).join("; "), o.note, o.total, o.paid ?? "", o.method ?? "", o.status]));
  return "\ufeff" + rows.map(r => r.map(cell).join(";")).join("\n");
}
const streams = new Set();                                   // canlı bağlı kasa/mutfak ekranları
const push = type => { for (const r of streams) { try { r.write("data: " + type + "\n\n"); } catch (e) {} } };
const SW_JS = `self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick",e=>{e.notification.close();
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>{
    for(const c of l){if("focus" in c)return c.focus()}return self.clients.openWindow("/#kasa")}))});`;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#c2410c"/><text x="256" y="350" font-size="300" text-anchor="middle">🍽️</text></svg>`;
const MANIFEST = JSON.stringify({ name: "NFC Masa Kasa", short_name: "Kasa", start_url: "/#kasa", display: "standalone",
  background_color: "#c2410c", theme_color: "#c2410c", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] });
const save = () => { if (useDb) persist(); else fs.writeFile(FILE, JSON.stringify(orders), () => {}); };

// Saklama süresinden eski ödenmiş/iptal siparişleri temizle
setInterval(() => {
  const lim = Date.now() - KEEP;
  orders = orders.filter(o => !(!isOpen(o) && o.ts < lim));
  save();
}, 3600e3);

// Basit hız sınırı: IP başına dakikada 8 sipariş
const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60e3);
  a.push(now); hits.set(ip, a);
  return a.length > 8;
}

const send = (res, code, data, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};
const body = req => new Promise((ok, no) => {
  let s = "";
  req.on("data", c => { s += c; if (s.length > 40000) { req.destroy(); no(); } });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { no(e); } });
});
const role = req => { const p = req.headers["x-pass"]; return p === PASS ? "admin" : (MPASS && p === MPASS ? "mutfak" : null); };
const isKasa = req => role(req) === "admin";

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  try {
    if (u.pathname === "/api/saglik") return send(res, 200, { veritabani: useDb, hazir: ready, hata: dbErr });
    if (!ready) {
      if (u.pathname.startsWith("/api/")) return send(res, 503, { error: "hazırlanıyor" });
      return send(res, 503, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="8"><body style="font-family:system-ui;padding:28px;max-width:520px;margin:auto"><h2>Sistem hazırlanıyor…</h2><p>Birkaç saniye içinde otomatik yenilenir.</p></body>', "text/html");
    }
    if (u.pathname === "/" ) return send(res, 200, HTML, "text/html");
    if (u.pathname === "/sw.js") return send(res, 200, SW_JS, "application/javascript");
    if (u.pathname === "/manifest.webmanifest") return send(res, 200, MANIFEST, "application/manifest+json");
    if (u.pathname === "/icon.svg") return send(res, 200, ICON, "image/svg+xml");
    if (u.pathname === "/api/stream") {                       // anlık bildirim: yeni sipariş/çağrı olunca ekranı uyandırır
      if (!role(req)) return send(res, 401, { error: "auth" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n"); streams.add(res);
      const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch (e) {} }, 20000);
      req.on("close", () => { clearInterval(ka); streams.delete(res); });
      return;
    }
    if (u.pathname === "/api/menu" && req.method === "GET") return send(res, 200, menuOut());
    if (u.pathname === "/api/menu" && req.method === "POST") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req); let m;
      try { m = Array.isArray(b.menu) ? cleanMenu(b.menu) : parseMenu(b.text); } catch (e) { return send(res, 400, { error: e.message }); }
      setMenu(m);
      saveMenu();
      return send(res, 200, menuOut());
    }
    if (u.pathname === "/api/settings" && req.method === "GET") return send(res, 200, pubSettings());
    if (u.pathname === "/api/settings" && req.method === "POST") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req);
      if ("tables" in b) { const n = parseInt(b.tables); if (!(n >= 1 && n <= 200)) return send(res, 400, { error: "geçersiz" }); settings.tables = n; }
      if ("ordering" in b) settings.ordering = !!b.ordering;
      if ("requireKey" in b) settings.requireKey = !!b.requireKey;
      if ("banner" in b) settings.banner = String(b.banner).slice(0, 160);
      saveSettings();
      return send(res, 200, pubSettings());
    }
    if (u.pathname === "/api/me") { const r = role(req); return r ? send(res, 200, { role: r }) : send(res, 401, { error: "auth" }); }
    if (u.pathname === "/api/keys") {                       // masa kodlu NFC adresleri için
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const k = {}; for (let i = 1; i <= settings.tables; i++) k[i] = keyFor(String(i));
      return send(res, 200, k);
    }
    if (u.pathname === "/api/call" && req.method === "POST") {   // garson çağır / hesap iste
      if (limited("c" + ip)) return send(res, 429, { error: "çok fazla istek" });
      const b = await body(req), table = String(b.table || "").slice(0, 20);
      if (!validTable(table)) return send(res, 400, { error: "geçersiz masa" });
      if (!keyOk(table, b.k)) return send(res, 403, { error: "geçersiz kart" });
      if (b.type !== "garson") return send(res, 400, { error: "geçersiz" });
      if (!calls.some(c => c.table === table && c.type === b.type))
        calls.push({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), table, type: b.type, ts: Date.now() });
      push("call");
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/calls" && req.method === "GET") {
      if (!role(req)) return send(res, 401, { error: "auth" });
      calls = calls.filter(c => Date.now() - c.ts < 1800e3);
      return send(res, 200, calls);
    }
    if (u.pathname === "/api/calls/clear" && req.method === "POST") {
      if (!role(req)) return send(res, 401, { error: "auth" });
      const b = await body(req); calls = calls.filter(c => c.id !== b.id);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/close" && req.method === "POST") {  // hesabı kapat: yöntem + indirim, tek işlemde
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), table = String(b.table || "").slice(0, 20);
      if (!["nakit", "kart"].includes(b.method)) return send(res, 400, { error: "geçersiz yöntem" });
      const d = Math.min(100, Math.max(0, Number(b.discount) || 0)); let n = 0;
      for (const o of orders) if (o.table === table && isOpen(o)) {
        o.status = "Ödendi"; o.method = b.method; o.discount = d; o.paid = Math.round(o.total * (100 - d)) / 100; o.paidAt = Date.now(); n++;
      }
      save(); return send(res, 200, { closed: n });
    }
    if (u.pathname === "/api/move" && req.method === "POST") {   // masa taşı
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), from = String(b.from || "").slice(0, 20), to = String(b.to || "").slice(0, 20);
      if (!validTable(to)) return send(res, 400, { error: "Geçersiz hedef masa" });
      let n = 0; for (const o of orders) if (o.table === from && isOpen(o)) { o.table = to; n++; }
      save(); return send(res, 200, { moved: n });
    }
    if (u.pathname === "/api/soldout" && req.method === "POST") {  // stok: tükendi işaretle
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), name = String(b.name || "");
      if (!(name in PRICE)) return send(res, 400, { error: "geçersiz ürün" });
      const s = new Set(settings.soldOut); b.out ? s.add(name) : s.delete(name);
      settings.soldOut = [...s]; saveSettings();
      return send(res, 200, menuOut());
    }
    if (u.pathname === "/api/report") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, report([1, 7, 30].includes(+u.searchParams.get("days")) ? +u.searchParams.get("days") : 1));
    }
    if (u.pathname === "/api/export") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, csv([1, 7, 30].includes(+u.searchParams.get("days")) ? +u.searchParams.get("days") : 30), "text/csv");
    }

    if (u.pathname === "/api/orders" && req.method === "GET") {
      const t = u.searchParams.get("table");
      if (t) {                                                // müşteri: yalnızca kendi masası
        if (!keyOk(t.slice(0, 20), u.searchParams.get("k"))) return send(res, 403, { error: "geçersiz kart" });
        return send(res, 200, orders.filter(o => o.table === t.slice(0, 20)));
      }
      if (!role(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, orders);
    }

    if (u.pathname === "/api/orders" && req.method === "POST") {
      if (limited(ip)) return send(res, 429, { error: "çok fazla istek" });
      const b = await body(req);
      const table = String(b.table || "").slice(0, 20);
      if (!validTable(table)) return send(res, 400, { error: "geçersiz masa" });
      if (!keyOk(table, b.k)) return send(res, 403, { error: "geçersiz kart" });
      if (!settings.ordering) return send(res, 403, { error: "kapalı" });
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return send(res, 400, { error: "geçersiz" });
      const items = [];
      for (const i of b.items) {
        const q = Number(i.q);
        if (!(i.n in PRICE) || !Number.isInteger(q) || q < 1 || q > 20) return send(res, 400, { error: "geçersiz ürün" });
        if (settings.soldOut.includes(i.n)) return send(res, 409, { error: "Tükendi: " + i.n });
        items.push({ n: i.n, q, p: PRICE[i.n] });          // fiyat HER ZAMAN sunucudan
      }
      const o = {
        id: "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        no: nextNo(), table, items, note: String(b.note || "").slice(0, 200),
        total: items.reduce((s, i) => s + i.p * i.q, 0), status: "Yeni", ts: Date.now(),
      };
      orders.push(o); save(); push("order");
      return send(res, 200, o);
    }

    const m = u.pathname.match(/^\/api\/orders\/([\w-]+)\/status$/);
    if (m && req.method === "POST") {
      const r = role(req);
      if (!r) return send(res, 401, { error: "auth" });
      const b = await body(req), o = orders.find(x => x.id === m[1]);
      if (!o || !STAT.includes(b.status)) return send(res, 400, { error: "geçersiz" });
      if (r === "mutfak" && !(["Hazırlanıyor", "Servis edildi"].includes(b.status) && ["Yeni", "Hazırlanıyor"].includes(o.status)))
        return send(res, 403, { error: "yetkisiz" });          // mutfak: ödeme/iptal yapamaz
      o.status = b.status;
      if (b.status === "İptal") o.why = String(b.why || "").slice(0, 80);
      save();
      return send(res, 200, o);
    }
    send(res, 404, { error: "yok" });
  } catch (e) { console.error(e); send(res, 500, { error: "hata" }); }
});
server.listen(PORT, () => console.log("Çalışıyor: http://localhost:" + PORT + "  (kasa şifresi: " + PASS + (PASS === "1234" ? " — VARSAYILAN, DEĞİŞTİRİN" : "") + ")"));
init();
