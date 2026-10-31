// NFC Masa Sipariş Sunucusu — ek paket gerektirmez (Node 18+)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const PASS = process.env.KASA_SIFRE || "1234";          // KASA ŞİFRESİNİ DEĞİŞTİRİN
const MPASS = process.env.MUTFAK_SIFRE || "";                 // isteğe bağlı: yalnızca mutfak ekranı
const SECRET = process.env.MASA_ANAHTARI || (PASS + "|masa");   // masa kodlarını üretir (sabit kalmalı)
const KEEP = (Number(process.env.GECMIS_GUN) || 30) * 86400e3;  // ödenen/iptal siparişlerin saklanma süresi
const FILE = process.env.DATA_FILE || path.join(__dirname, "orders.json");

// ───── Kalıcı kayıt: Supabase REST ─────
const clean = s => (s || "").trim().replace(/^["']|["']$/g, "").trim();
const DB_URL = clean(process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, "").replace(/\/$/, ""), DB_KEY = clean(process.env.SUPABASE_KEY);
const useDb = !!(DB_URL && DB_KEY);
const dirty = { settings: false, menu: false, calls: false };
const snap = new Map();                                        // sipariş id → en son kaydedilen JSON
async function db(p, opt = {}) {
  const h = { apikey: DB_KEY, "Content-Type": "application/json", ...(opt.headers || {}) };
  if (DB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + DB_KEY;   
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
function flush() {                                             
  clearTimeout(flushTimer);
  flushQ = flushQ.then(async () => {
    const wasS = dirty.settings, wasM = dirty.menu, wasC = dirty.calls, rows = [], ids = [];
    const cur = new Map(orders.map(o => [o.id, JSON.stringify(o)]));
    if (wasS) rows.push({ key: "settings", value: settings });
    if (wasM) rows.push({ key: "menu", value: MENU });
    if (wasC) rows.push({ key: "calls", value: calls });
    dirty.settings = dirty.menu = dirty.calls = false;
    for (const [id, j] of cur) if (snap.get(id) !== j) { rows.push({ key: "order:" + id, value: JSON.parse(j) }); ids.push(id); }
    const gone = [...snap.keys()].filter(id => !cur.has(id));
    try {
      if (rows.length) await dbPut(rows);
      for (let i = 0; i < gone.length; i += 50)
        await db("kv?key=in.(" + gone.slice(i, i + 50).map(id => encodeURIComponent('"order:' + id + '"')).join(",") + ")", { method: "DELETE", headers: { Prefer: "return=minimal" } });
      ids.forEach(id => snap.set(id, cur.get(id))); gone.forEach(id => snap.delete(id));
    } catch (e) {
      console.error("Kayıt hatası, 5 sn sonra yeniden denenecek:", e.message);
      dirty.settings = dirty.settings || wasS; dirty.menu = dirty.menu || wasM; dirty.calls = dirty.calls || wasC;
      clearTimeout(flushTimer); flushTimer = setTimeout(flush, 5000);
    }
  });
  return flushQ;
}
let ready = !useDb, dbErr = "";
function dbExplain(e) {
  const m = String((e && e.message) || e);
  if (/DB 40[13]/.test(m)) return "SUPABASE_KEY kabul edilmedi veya yazma yetkisi yok. Service_role anahtarını kullandığınızdan emin olun.";
  if (/DB 404|PGRST205|does not exist/.test(m)) return "Veritabanında 'kv' tablosu yok. Supabase SQL Editor'da tabloyu oluşturun.";
  if (/fetch failed|ENOTFOUND|ECONN|timeout|Invalid URL/i.test(m)) return "Supabase'e ulaşılamıyor. Projenin aktif olduğundan emin olun.";
  return m;
}
async function init() {              
  if (!useDb) return;
  for (;;) {
    try {
      const rows = await dbLoad();
      await dbPut([{ key: "ping", value: { ts: Date.now() } }]);     
      for (const { key, value } of rows) {
        if (key === "settings") Object.assign(settings, value);
        else if (key === "menu") { try { setMenu(cleanMenu(value)); } catch (e) { console.error("Kayıtlı menü okunamadı:", e.message); } }
        else if (key === "calls") { if (Array.isArray(value)) calls = value; }
        else if (key.startsWith("order:")) orders.push(value);
      }
      orders.sort((a, b) => a.ts - b.ts); orders.forEach(o => snap.set(o.id, JSON.stringify(o)));
      if (!rows.some(r => r.key === "settings")) { dirty.settings = true; persist(); }   
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
if (process.env.MENU_METNI) {                                  
  try { setMenu(parseMenu(process.env.MENU_METNI)); } catch (e) { console.error("MENU_METNI hatalı:", e.message); }
}
if (!useDb) { try { setMenu(cleanMenu(JSON.parse(fs.readFileSync(FILE + ".menu.json", "utf8")))); } catch (e) {} }

// HTML Arayüz kısmı (Frontend kodunuz aynı kalıyor, sadece state yönetimleri backend üzerinden tam senkronize olacak)
const HTML = `... (Arayüz kodlarınız aynı kalacak) ...`;
const STAT = ["Yeni", "Hazırlanıyor", "Servis edildi", "Ödendi", "İptal"];

let orders = [];
if (!useDb) { try { orders = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {} }
let settings = { tables: Number(process.env.MASA_SAYISI) || 10, ordering: true, banner: "", requireKey: false, soldOut: [], counter: { day: "", n: 0 } };
let calls = [];
if (!useDb) { try { Object.assign(settings, JSON.parse(fs.readFileSync(FILE + ".ayar", "utf8"))); } catch (e) {} }

const saveSettings = () => { if (useDb) { dirty.settings = true; persist(); } else fs.writeFile(FILE + ".ayar", JSON.stringify(settings), () => {}); };
const saveMenu = () => { if (useDb) { dirty.menu = true; persist(); } else fs.writeFile(FILE + ".menu.json", JSON.stringify(MENU), () => {}); };
const saveCalls = () => { if (useDb) { dirty.calls = true; persist(); } }; // Çağrılar için kalıcı kayıt fonksiyonu eklendi

const pubSettings = () => ({ tables: settings.tables, ordering: settings.ordering, banner: settings.banner, requireKey: settings.requireKey, persist: useDb });
const menuOut = () => MENU.map(g => ({ c: g.c, i: g.i.map(([n, p]) => [n, p, settings.soldOut.includes(n)]) }));
const validTable = t => { const n = parseInt(t); return n >= 1 && n <= settings.tables && String(n) === t; };
const keyFor = t => crypto.createHmac("sha256", SECRET).update("masa:" + t).digest("hex").slice(0, 8);
const keyOk = (t, k) => {          
  if (!settings.requireKey) return true;
  const a = Buffer.from(String(k || "")), b = Buffer.from(keyFor(t));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const TR = 3 * 3600e3;             
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
  const cell = v => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };  
  const rows = [["No", "Tarih", "Masa", "Ürünler", "Not", "Tutar", "Ödenen", "Yöntem", "Durum"]];
  orders.filter(o => o.ts >= startOf(days)).sort((a, b) => a.ts - b.ts).forEach(o => rows.push([
    o.no ?? "", new Date(o.ts + TR).toISOString().slice(0, 16).replace("T", " "), o.table,
    o.items.map(i => i.q + "x " + i.n).join("; "), o.note, o.total, o.paid ?? "", o.method ?? "", o.status]));
  return "\ufeff" + rows.map(r => r.map(cell).join(";")).join("\n");
}
const streams = new Set();                                   
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

setInterval(() => {
  const lim = Date.now() - KEEP;
  orders = orders.filter(o => !(!isOpen(o) && o.ts < lim));
  save();
}, 3600e3);

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
    if (u.pathname === "/api/stream") {                       
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
    if (u.pathname === "/api/keys") {                       
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const k = {}; for (let i = 1; i <= settings.tables; i++) k[i] = keyFor(String(i));
      return send(res, 200, k);
    }
    if (u.pathname === "/api/call" && req.method === "POST") {   
      if (limited("c" + ip)) return send(res, 429, { error: "çok fazla istek" });
      const b = await body(req), table = String(b.table || "").slice(0, 20);
      if (!validTable(table)) return send(res, 400, { error: "geçersiz masa" });
      if (!keyOk(table, b.k)) return send(res, 403, { error: "geçersiz kart" });
      if (b.type !== "garson") return send(res, 400, { error: "geçersiz" });
      if (!calls.some(c => c.table === table && c.type === b.type)) {
        calls.push({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), table, type: b.type, ts: Date.now() });
        saveCalls(); // Çağrı eklendiğinde Supabase'e kaydet
      }
      push("call");
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/calls" && req.method === "GET") {
      if (!role(req)) return send(res, 401, { error: "auth" });
      const oldLen = calls.length;
      calls = calls.filter(c => Date.now() - c.ts < 1800e3);
      if(calls.length !== oldLen) saveCalls(); // Süresi geçenler temizlendiyse kalıcı hale getir
      return send(res, 200, calls);
    }
    if (u.pathname === "/api/calls/clear" && req.method === "POST") {
      if (!role(req)) return send(res, 401, { error: "auth" });
      const b = await body(req); 
      calls = calls.filter(c => c.id !== b.id);
      saveCalls(); // Çağrı silindiğinde Supabase'e kaydet
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/close" && req.method === "POST") {  
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), table = String(b.table || "").slice(0, 20);
      if (!["nakit", "kart"].includes(b.method)) return send(res, 400, { error: "geçersiz yöntem" });
      const d = Math.min(100, Math.max(0, Number(b.discount) || 0)); let n = 0;
      for (const o of orders) if (o.table === table && isOpen(o)) {
        o.status = "Ödendi"; o.method = b.method; o.discount = d; o.paid = Math.round(o.total * (100 - d)) / 100; o.paidAt = Date.now(); n++;
      }
      save(); return send(res, 200, { closed: n });
    }
    if (u.pathname === "/api/move" && req.method === "POST") {   
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), from = String(b.from || "").slice(0, 20), to = String(b.to || "").slice(0, 20);
      if (!validTable(to)) return send(res, 400, { error: "Geçersiz hedef masa" });
      let n = 0; for (const o of orders) if (o.table === from && isOpen(o)) { o.table = to; n++; }
      save(); return send(res, 200, { moved: n });
    }
    if (u.pathname === "/api/soldout" && req.method === "POST") {  
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), name = String(b.name || "");
      if (!(name in PRICE)) return send(res, 400, { error: "geçersiz ürün" });
      const s = new Set(settings.soldOut); b.out ? s.add(name) : s.delete(name);
      settings.soldOut = [...s]; 
      saveSettings(); // Stok durumu ayarlar (settings) içinde tutulduğu için artık Supabase'e kaydediliyor
      return send(res, 200, menuOut());
    }
    if (u.pathname === "/api/report") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, report([1, 7, 30].includes(+u.searchParams.get("days")) ? +u.searchParams.get("days"] : 1));
    }
    if (u.pathname === "/api/export") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, csv([1, 7, 30].includes(+u.searchParams.get("days")) ? +u.searchParams.get("days") : 30), "text/csv");
    }

    if (u.pathname === "/api/orders" && req.method === "GET") {
      const t = u.searchParams.get("table");
      if (t) {                                                
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
        items.push({ n: i.n, q, p: PRICE[i.n] });          
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
        return send(res, 403, { error: "yetkisiz" });          
      o.status = b.status;
      if (b.status === "İptal") o.why = String(b.why || "").slice(0, 80);
      save();
      return send(res, 200, o);
    }
    send(res, 404, { error: "yok" });
  } catch (e) { console.error(e); send(res, 500, { error: "hata" }); }
});
server.listen(PORT, () => console.log("Çalışıyor: http://localhost:" + PORT));
init();