// NFC Masa Sipariş Sunucusu — ek paket gerektirmez (Node 18+)
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const PASS = process.env.KASA_SIFRE || "1234";          // KASA ŞİFRESİNİ DEĞİŞTİRİN
const FILE = process.env.DATA_FILE || path.join(__dirname, "orders.json");

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
if (process.env.MENU_METNI) {
  try { setMenu(parseMenu(process.env.MENU_METNI)); } catch (e) { console.error("MENU_METNI hatalı:", e.message); }
} else {
  try { setMenu(cleanMenu(JSON.parse(fs.readFileSync(FILE + ".menu.json", "utf8")))); } catch (e) {}
}
const HTML = "<!DOCTYPE html>\n<html lang=\"tr\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>NFC Masa Sipariş</title>\n<style>\n:root{--bg:#faf7f2;--card:#fff;--ink:#2a2018;--mute:#7a6c5f;--line:#e8dfd3;--acc:#c2410c;--acc2:#fff;--ok:#15803d;--warn:#b45309;\nbox-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#17130f;--card:#241e18;--ink:#f3ece4;--mute:#a89a8c;--line:#3a3128;--acc:#f97316;--acc2:#1a1209;--ok:#4ade80;--warn:#fbbf24}}\n:root[data-theme=\"dark\"]{--bg:#17130f;--card:#241e18;--ink:#f3ece4;--mute:#a89a8c;--line:#3a3128;--acc:#f97316;--acc2:#1a1209;--ok:#4ade80;--warn:#fbbf24}\nhtml{scroll-padding-top:env(safe-area-inset-top,0px)}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.w{max-width:960px;margin:0 auto;padding:16px 16px 160px}\nh1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}\n.top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}\n.badge{font-size:12px;padding:3px 9px;border-radius:99px;border:1px solid var(--line);color:var(--mute)}\n.badge.live{color:var(--ok);border-color:var(--ok)}\n.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}\n.row{display:flex;justify-content:space-between;align-items:center;gap:10px}\n.mute{color:var(--mute);font-size:14px}\nbutton{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px}\nbutton.p{background:var(--acc);color:var(--acc2);border-color:var(--acc);font-weight:600}\nbutton.q{width:38px;height:38px;padding:0;font-size:20px}\n.qty{display:flex;align-items:center;gap:10px}.qty b{min-width:18px;text-align:center}\n.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}\n.bar>div{max-width:960px;margin:0 auto}\ntextarea,input,select{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg);color:var(--ink)}\n.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}\n.st{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:99px;background:var(--line)}\n.st.Yeni{background:var(--acc);color:var(--acc2)}.st.Hazırlanıyor{color:var(--warn)}.st.Servis{color:var(--ok)}\nul{margin:6px 0;padding-left:18px}\n.toast{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);background:var(--ok);color:#fff;padding:10px 18px;border-radius:99px;z-index:9}\n.links{overflow-x:auto}.links .row{padding:6px 0;border-bottom:1px solid var(--line)}\n.links code{font-size:12px;word-break:break-all}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;margin-top:10px}\n.tile{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:10px;text-align:left;min-height:78px;font-size:14px}\n.tile span{font-size:12px;color:var(--mute)}\n.tile.tN{background:var(--acc);color:var(--acc2);border-color:var(--acc)}.tile.tN span{color:var(--acc2)}\n.tile.tH{border-color:var(--warn)}.tile.tS{border-color:var(--ok)}\n.tile.sel{outline:3px solid var(--ink)}\n.mi{gap:8px;margin-top:6px}.mi input:first-child{flex:1;min-width:0}.mi button{flex:none}.pr{width:92px!important;flex:none}\ndetails summary{cursor:pointer;font-weight:600}\na{color:var(--acc)}\n</style>\n</head>\n<body>\n<div class=\"w\" id=\"app\"></div>\n<script>\nlet MENU=[],PRICE={};\nconst STAT=[\"Yeni\",\"Hazırlanıyor\",\"Servis edildi\",\"Ödendi\"];\nconst NEXT={\"Yeni\":\"Hazırlamaya başla\",\"Hazırlanıyor\":\"Servis edildi\",\"Servis edildi\":\"Ödendi\"};\nconst TL=n=>n.toLocaleString(\"tr-TR\")+\" ₺\";\nconst esc=s=>String(s).replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\n\nlet orders=[],cart={},note=\"\",tables=10,lastCount=-1,pass=\"\",sel=\"\",mdraft=null,mobj=null,lastMenu=0;\ntry{pass=sessionStorage.getItem(\"kp\")||\"\"}catch(e){}\nasync function api(p,o={}){\n  const r=await fetch(p,{...o,headers:{\"Content-Type\":\"application/json\",\"x-pass\":pass}});\n  if(r.status===401){pass=\"\";try{sessionStorage.removeItem(\"kp\")}catch(e){}render();throw new Error(\"auth\")}\n  if(!r.ok){let m=\"\";try{m=(await r.json()).error}catch(e){}throw new Error(m||r.status)}return r.json();\n}\nasync function addOrder(o){await api(\"/api/orders\",{method:\"POST\",body:JSON.stringify({table:o.table,items:o.items.map(i=>({n:i.n,q:i.q})),note:o.note})});await poll()}\nasync function setStatus(id,s){await api(\"/api/orders/\"+id+\"/status\",{method:\"POST\",body:JSON.stringify({status:s})});await poll()}\nasync function poll(){\n  const r=route();\n  try{\n    if(r.v===\"m\"&&Date.now()-lastMenu>15000){lastMenu=Date.now();setMenuC(await api(\"/api/menu\"));pruneCart()}\n    if(r.v===\"m\")orders=await api(\"/api/orders?table=\"+encodeURIComponent(r.t));\n    else if(r.v===\"k\"&&pass)orders=await api(\"/api/orders\");\n    else return;\n    if(r.v===\"k\"&&lastCount>=0&&orders.length>lastCount)beep();\n    lastCount=orders.length;\n    {const a=document.activeElement;if(!a||(![\"note\",\"tc\",\"pw\",\"mt\"].includes(a.id)&&!(a.closest&&a.closest(\"#medit\"))))render()}\n  }catch(e){}\n}\nsetInterval(poll,3000);\nwindow.addEventListener(\"hashchange\",()=>{lastCount=-1;poll()});\nfetch(\"/api/menu\").then(r=>r.json()).then(m=>{MENU=m;MENU.forEach(g=>g.i.forEach(([n,p])=>PRICE[n]=p));return fetch(\"/api/settings\").then(r=>r.json()).then(x=>{tables=x.tables;render();poll()})});\n\nfunction beep(){try{const a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();\n o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.setValueAtTime(.2,a.currentTime);g.gain.exponentialRampToValueAtTime(.001,a.currentTime+.5);o.start();o.stop(a.currentTime+.5)}catch(e){}}\n\n/* ---------- yönlendirme ---------- */\nfunction route(){\n  const h=location.hash.slice(1);\n  if(h.startsWith(\"masa=\")){let t=\"\";try{t=decodeURIComponent(h.slice(5))}catch(e){}return{v:\"m\",t:t.slice(0,20)||\"?\"}}\n  if(h===\"kasa\")return{v:\"k\"};\n  return{v:\"home\"};\n}\nwindow.addEventListener(\"hashchange\",render);\n\nconst badge=()=>`<span class=\"badge live\">● Canlı</span>`;\nconst menuText=()=>MENU.map(g=>\"# \"+g.c+\"\\n\"+g.i.map(([n,p])=>n+\"; \"+p).join(\"\\n\")).join(\"\\n\\n\");\nconst setMenuC=m=>{MENU=m;PRICE={};m.forEach(g=>g.i.forEach(([n,p])=>PRICE[n]=p))};\nconst pruneCart=()=>Object.keys(cart).forEach(n=>{if(!(n in PRICE))delete cart[n]});\nconst ens=()=>{if(!mobj)mobj=JSON.parse(JSON.stringify(MENU))};\nfunction editor(){\n  const m=mobj||MENU;\n  return m.map((g,gi)=>`<div class=\"card\"><div class=\"row mi\" style=\"margin-top:0\"><input data-f=\"c\" data-g=\"${gi}\" value=\"${esc(g.c)}\" style=\"font-weight:700\"><button data-a=\"gdel\" data-g=\"${gi}\">Kategoriyi sil</button></div>\n  ${g.i.map(([n,p],ii)=>`<div class=\"row mi\"><input data-f=\"n\" data-g=\"${gi}\" data-i=\"${ii}\" value=\"${esc(n)}\" placeholder=\"Ürün adı\"><input class=\"pr\" data-f=\"p\" data-g=\"${gi}\" data-i=\"${ii}\" type=\"number\" step=\"any\" min=\"0\" value=\"${esc(p)}\"><button class=\"q\" data-a=\"idel\" data-g=\"${gi}\" data-i=\"${ii}\">✕</button></div>`).join(\"\")}\n  <button data-a=\"iadd\" data-g=\"${gi}\" style=\"margin-top:8px\">+ Ürün ekle</button></div>`).join(\"\")+`<button data-a=\"gadd\">+ Kategori ekle</button>`;\n}\nconst base=()=>location.href.split(\"#\")[0];\n\n/* ---------- görünümler ---------- */\nfunction home(){\n  return `<div class=\"top\"><h1>🍽️ NFC Masa Sipariş</h1>${badge()}</div>\n  <p class=\"mute\">Demo: bir masa seçip müşteri ekranını deneyin, sonra kasa ekranında siparişi görün.</p>\n  <div class=\"card\"><div class=\"row\"><b>Müşteri ekranı</b><select id=\"pick\" style=\"width:auto\">${Array.from({length:tables},(_,i)=>`<option>${i+1}</option>`).join(\"\")}</select></div>\n  <button class=\"p\" data-a=\"goT\" style=\"margin-top:10px\">Masaya git</button></div>\n  <div class=\"card\"><b>Kasa ekranı</b><br><button class=\"p\" data-a=\"goK\" style=\"margin-top:10px\">Kasaya git</button></div>`;\n}\nfunction qtyRow(n,p){\n  const q=cart[n]||0;\n  return `<div class=\"card row\"><div><b>${esc(n)}</b><div class=\"mute\">${TL(p)}</div></div>\n  <div class=\"qty\"><button class=\"q\" data-a=\"dec\" data-n=\"${esc(n)}\">−</button><b>${q}</b><button class=\"q\" data-a=\"inc\" data-n=\"${esc(n)}\">+</button></div></div>`;\n}\nfunction customer(t){\n  const mine=orders.filter(o=>String(o.table)===t&&o.status!==\"Ödendi\").sort((a,b)=>a.ts-b.ts);\n  const total=Object.entries(cart).reduce((s,[n,q])=>s+(PRICE[n]||0)*q,0);\n  const cnt=Object.values(cart).reduce((a,b)=>a+b,0);\n  return `<div class=\"top\"><h1>Masa ${esc(t)}</h1>${badge()}</div>\n  ${mine.length?`<h2>Siparişleriniz</h2>`+mine.map(o=>`<div class=\"card\"><div class=\"row\"><span class=\"mute\">${new Date(o.ts).toLocaleTimeString(\"tr-TR\",{hour:\"2-digit\",minute:\"2-digit\"})}</span><span class=\"st ${o.status.split(\" \")[0]}\">${esc(o.status)}</span></div>\n  <ul>${o.items.map(i=>`<li>${i.q}× ${esc(i.n)}</li>`).join(\"\")}</ul><b>${TL(o.total)}</b></div>`).join(\"\"):\"\"}\n  ${MENU.map(g=>`<h2>${esc(g.c)}</h2>`+g.i.map(([n,p])=>qtyRow(n,p)).join(\"\")).join(\"\")}\n  <div class=\"bar\"><div>\n   ${cnt?`<textarea id=\"note\" rows=\"1\" placeholder=\"Sipariş notu (isteğe bağlı)\">${esc(note)}</textarea>`:\"\"}\n   <div class=\"row\" style=\"margin-top:${cnt?8:0}px\"><div><b>${TL(total)}</b><div class=\"mute\">${cnt} ürün</div></div>\n   <button class=\"p\" data-a=\"send\" ${cnt?\"\":\"disabled style='opacity:.5'\"}>Siparişi Gönder</button></div></div></div>`;\n}\nfunction kasa(){\n  const all=orders.filter(o=>o.status!==\"Ödendi\").sort((a,b)=>a.ts-b.ts);\n  const act=sel?all.filter(o=>String(o.table)===sel):all;\n  const byT={};all.forEach(o=>{(byT[o.table]=byT[o.table]||[]).push(o)});\n  const ids=[...Array.from({length:tables},(_,i)=>String(i+1)),...Object.keys(byT).filter(t=>!(+t>=1&&+t<=tables))];\n  const tile=t=>{const os=byT[t]||[],tot=os.reduce((s,o)=>s+o.total,0);\n   const k=!os.length?\"t0\":os.some(o=>o.status===\"Yeni\")?\"tN\":os.some(o=>o.status===\"Hazırlanıyor\")?\"tH\":\"tS\";\n   const lb={t0:\"Boş\",tN:\"Yeni sipariş\",tH:\"Hazırlanıyor\",tS:\"Hesap bekliyor\"}[k];\n   return `<button class=\"tile ${k}${sel===t?\" sel\":\"\"}\" data-a=\"sel\" data-t=\"${esc(t)}\"><b>Masa ${esc(t)}</b><span>${lb}</span>${tot?`<span>${TL(tot)}</span>`:\"\"}</button>`};\n  const col=s=>act.filter(o=>o.status===s);\n  const card=o=>`<div class=\"card\"><div class=\"row\"><b>Masa ${esc(o.table)}</b><span class=\"mute\">${new Date(o.ts).toLocaleTimeString(\"tr-TR\",{hour:\"2-digit\",minute:\"2-digit\"})}</span></div>\n   <ul>${o.items.map(i=>`<li>${i.q}× ${esc(i.n)}</li>`).join(\"\")}</ul>${o.note?`<div class=\"mute\">📝 ${esc(o.note)}</div>`:\"\"}\n   <div class=\"row\" style=\"margin-top:8px\"><b>${TL(o.total)}</b>${NEXT[o.status]?`<button class=\"p\" data-a=\"next\" data-id=\"${esc(o.id)}\">${NEXT[o.status]}</button>`:\"\"}</div></div>`;\n  const bills={};act.forEach(o=>bills[o.table]=(bills[o.table]||0)+o.total);\n  return `<div class=\"top\"><h1>🧾 Kasa</h1>${badge()}</div>\n  <div class=\"row\" style=\"margin-top:14px\"><h2 style=\"margin:0\">Masalar</h2><span class=\"mute\">Masa sayısı <input id=\"tc\" type=\"number\" min=\"1\" max=\"200\" value=\"${tables}\" style=\"width:80px;display:inline-block\"></span></div>\n  <div class=\"grid\">${ids.map(tile).join(\"\")}</div>\n  ${sel?`<div class=\"mute\" style=\"margin-top:8px\">Masa ${esc(sel)} gösteriliyor · <a href=\"#kasa\" data-a=\"sel\" data-t=\"\">Tümünü göster</a></div>`:\"\"}\n  <div class=\"cols\">${STAT.slice(0,3).map(s=>`<div><h2>${s} (${col(s).length})</h2>${col(s).map(card).join(\"\")||'<div class=\"mute\">—</div>'}</div>`).join(\"\")}</div>\n  <h2>Açık hesaplar</h2>\n  ${Object.keys(bills).length?Object.entries(bills).map(([t,v])=>`<div class=\"card row\"><b>Masa ${esc(t)}</b><span><b>${TL(v)}</b> <button class=\"p\" data-a=\"close\" data-t=\"${esc(t)}\" style=\"margin-left:8px\">Hesabı kapat</button></span></div>`).join(\"\"):'<div class=\"mute\">Açık hesap yok.</div>'}\n  <h2>Menü</h2>\n  <div id=\"medit\">${editor()}</div>\n  <div class=\"row\" style=\"margin:10px 0;flex-wrap:wrap;gap:8px\"><span class=\"mute\">${mobj?\"⚠ Kaydedilmemiş değişiklikler var\":\"Fiyat ve adları değiştirip kaydedin\"}</span>\n  <span>${mobj?`<button data-a=\"ereset\">Vazgeç</button> `:\"\"}<button class=\"p\" data-a=\"esave\">Menüyü kaydet</button></span></div>\n  <details class=\"card\"><summary>Toplu düzenle: metin / .txt dosyası</summary>\n  <p class=\"mute\">Kategori satırı <code>#</code> ile başlar, ürün satırları <code>Ürün; fiyat</code> biçimindedir. UTF-8 kaydedilmiş bir .txt dosyası yükleyebilirsiniz.</p>\n  <textarea id=\"mt\" rows=\"12\">${esc(mdraft===null?menuText():mdraft)}</textarea>\n  <div class=\"row\" style=\"margin-top:8px;flex-wrap:wrap\"><input id=\"mf\" type=\"file\" accept=\".txt,text/plain\" style=\"width:auto\"><span><button data-a=\"mcopy\">Metni kopyala</button> <button class=\"p\" data-a=\"msave\">Metinden kaydet</button></span></div></details>\n  <p class=\"mute\">Render ücretsiz planda sunucu yeniden başlayınca menü eski haline döner. Kalıcı olması için kaydettikten sonra <button data-a=\"acopy\" style=\"padding:3px 10px\">Menü metnini kopyala</button> deyip Render → Environment → <code>MENU_METNI</code> alanına yapıştırın.</p>\n  <h2>NFC kart bağlantıları</h2>\n  <div class=\"card\">\n  <p class=\"mute\">Her bağlantıyı ilgili masanın NFC kartına “URL/Web bağlantısı” olarak yazın (NFC Tools vb. uygulamayla).</p>\n  <div class=\"links\">${Array.from({length:tables},(_,i)=>{const u=base()+\"#masa=\"+(i+1);return `<div class=\"row\"><span>Masa ${i+1}<br><code>${esc(u)}</code></span><button data-a=\"copy\" data-u=\"${esc(u)}\">Kopyala</button></div>`}).join(\"\")}</div></div>`;\n}\n\nfunction login(){return `<h1>🧾 Kasa girişi</h1><div class=\"card\"><input id=\"pw\" type=\"password\" placeholder=\"Şifre\"><button class=\"p\" data-a=\"login\" style=\"margin-top:10px\">Giriş</button></div>`}\nfunction render(){\n  const r=route(),app=document.getElementById(\"app\");\n  const keep=document.activeElement&&document.activeElement.id===\"note\";\n  app.innerHTML=r.v===\"m\"?customer(r.t):r.v===\"k\"?(pass?kasa():login()):home();\n  if(keep){const n=document.getElementById(\"note\");if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length)}}\n}\n\nfunction toast(m){const d=document.createElement(\"div\");d.className=\"toast\";d.textContent=m;document.body.appendChild(d);setTimeout(()=>d.remove(),2500)}\n\n/* ---------- olaylar ---------- */\ndocument.addEventListener(\"click\",async e=>{\n  const b=e.target.closest(\"[data-a]\");if(!b)return;\n  const a=b.dataset.a;\n  if(a===\"inc\"){cart[b.dataset.n]=(cart[b.dataset.n]||0)+1;render()}\n  else if(a===\"dec\"){const n=b.dataset.n;if(cart[n]>1)cart[n]--;else delete cart[n];render()}\n  else if(a===\"send\"){\n    const t=route().t;\n    const items=Object.entries(cart).map(([n,q])=>({n,q,p:PRICE[n]||0}));\n    if(!items.length)return;\n    const o={id:\"o\"+Date.now().toString(36)+Math.random().toString(36).slice(2,5),table:t,items,note:note.trim().slice(0,200),\n      total:items.reduce((s,i)=>s+i.p*i.q,0),status:\"Yeni\",ts:Date.now()};\n    b.disabled=true;\n    try{await addOrder(o);cart={};note=\"\";toast(\"Siparişiniz kasaya iletildi ✓\");render()}\n    catch(err){b.disabled=false;\n      if(err.message===\"geçersiz ürün\"){try{setMenuC(await api(\"/api/menu\"));pruneCart();toast(\"Menü güncellenmiş, sepeti kontrol edip tekrar deneyin\")}catch(e2){toast(\"Gönderilemedi\")}render()}\n      else toast(\"Gönderilemedi, tekrar deneyin\")}\n  }\n  else if(a===\"next\"){const o=orders.find(x=>x.id===b.dataset.id);if(o)await setStatus(o.id,STAT[STAT.indexOf(o.status)+1])}\n  else if(a===\"close\"){for(const o of orders.filter(x=>String(x.table)===b.dataset.t&&x.status!==\"Ödendi\"))await setStatus(o.id,\"Ödendi\")}\n  else if(a===\"copy\"){try{await navigator.clipboard.writeText(b.dataset.u);toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"login\"){pass=document.getElementById(\"pw\").value;try{sessionStorage.setItem(\"kp\",pass)}catch(err){}lastCount=-1;await poll();render()}\n  else if(a===\"sel\"){sel=sel===b.dataset.t?\"\":b.dataset.t;render()}\n  else if(a===\"msave\"){\n    try{const r=await api(\"/api/menu\",{method:\"POST\",body:JSON.stringify({text:document.getElementById(\"mt\").value})});setMenuC(r);mobj=null;mdraft=null;toast(\"Menü kaydedildi ✓\");render()}\n    catch(err){if(err.message!==\"auth\")toast(err.message)}\n  }\n  else if(a===\"mcopy\"){try{await navigator.clipboard.writeText(document.getElementById(\"mt\").value);toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"gdel\"){ens();mobj.splice(+b.dataset.g,1);render()}\n  else if(a===\"idel\"){ens();mobj[+b.dataset.g].i.splice(+b.dataset.i,1);render()}\n  else if(a===\"iadd\"){ens();mobj[+b.dataset.g].i.push([\"\",0]);render()}\n  else if(a===\"gadd\"){ens();mobj.push({c:\"Yeni kategori\",i:[[\"\",0]]});render()}\n  else if(a===\"ereset\"){mobj=null;render()}\n  else if(a===\"acopy\"){try{await navigator.clipboard.writeText(menuText());toast(\"Kopyalandı\")}catch(err){toast(\"Kopyalanamadı\")}}\n  else if(a===\"esave\"){\n    try{const r=await api(\"/api/menu\",{method:\"POST\",body:JSON.stringify({menu:mobj||MENU})});setMenuC(r);mobj=null;mdraft=null;toast(\"Menü kaydedildi ✓\");render()}\n    catch(err){if(err.message!==\"auth\")toast(err.message)}\n  }\n  else if(a===\"goT\"){location.hash=\"masa=\"+document.getElementById(\"pick\").value}\n  else if(a===\"goK\"){location.hash=\"kasa\"}\n});\ndocument.addEventListener(\"input\",e=>{\n  if(e.target.id===\"note\")note=e.target.value;\n  if(e.target.id===\"mt\")mdraft=e.target.value;\n  const t=e.target;\n  if(t.dataset&&t.dataset.f){\n    ens();const g=mobj[+t.dataset.g];if(!g)return;\n    if(t.dataset.f===\"c\")g.c=t.value;\n    else{const it=g.i[+t.dataset.i];if(!it)return;if(t.dataset.f===\"n\")it[0]=t.value;else it[1]=Number(t.value)||0}\n  }\n});\ndocument.addEventListener(\"change\",async e=>{\n  if(e.target.id===\"mf\"){\n    const f=e.target.files[0];if(!f)return;\n    if(f.size>40000){toast(\"Dosya çok büyük\");return}\n    mdraft=(await f.text()).replace(/^\\uFEFF/,\"\");render();toast(\"Dosya yüklendi, kaydetmeyi unutmayın\");\n  }\n  if(e.target.id===\"tc\"){\n    const v=Math.max(1,Math.min(200,parseInt(e.target.value)||1));\n    try{const r=await api(\"/api/settings\",{method:\"POST\",body:JSON.stringify({tables:v})});tables=r.tables;toast(\"Masa sayısı: \"+tables)}\n    catch(err){toast(\"Kaydedilemedi\")}\n    render();\n  }\n});\nrender();\n</script>\n</body>\n</html>\n";
const STAT = ["Yeni", "Hazırlanıyor", "Servis edildi", "Ödendi"];

let orders = [];
try { orders = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
let settings = { tables: Number(process.env.MASA_SAYISI) || 10 };
try { Object.assign(settings, JSON.parse(fs.readFileSync(FILE + ".ayar", "utf8"))); } catch (e) {}
const save = () => fs.writeFile(FILE, JSON.stringify(orders), () => {});

// 24 saatten eski ödenmiş siparişleri temizle
setInterval(() => {
  const lim = Date.now() - 24 * 3600e3;
  orders = orders.filter(o => !(o.status === "Ödendi" && o.ts < lim));
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
const isKasa = req => req.headers["x-pass"] === PASS;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  try {
    if (u.pathname === "/" ) return send(res, 200, HTML, "text/html");
    if (u.pathname === "/api/menu" && req.method === "GET") return send(res, 200, MENU);
    if (u.pathname === "/api/menu" && req.method === "POST") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req); let m;
      try { m = Array.isArray(b.menu) ? cleanMenu(b.menu) : parseMenu(b.text); } catch (e) { return send(res, 400, { error: e.message }); }
      setMenu(m);
      fs.writeFile(FILE + ".menu.json", JSON.stringify(m), () => {});
      return send(res, 200, MENU);
    }
    if (u.pathname === "/api/settings" && req.method === "GET") return send(res, 200, settings);
    if (u.pathname === "/api/settings" && req.method === "POST") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const n = parseInt((await body(req)).tables);
      if (!(n >= 1 && n <= 200)) return send(res, 400, { error: "geçersiz" });
      settings.tables = n;
      fs.writeFile(FILE + ".ayar", JSON.stringify(settings), () => {});
      return send(res, 200, settings);
    }

    if (u.pathname === "/api/orders" && req.method === "GET") {
      const t = u.searchParams.get("table");
      if (t) return send(res, 200, orders.filter(o => o.table === t.slice(0, 20)));  // müşteri: yalnızca kendi masası
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      return send(res, 200, orders);
    }

    if (u.pathname === "/api/orders" && req.method === "POST") {
      if (limited(ip)) return send(res, 429, { error: "çok fazla istek" });
      const b = await body(req);
      const table = String(b.table || "").slice(0, 20);
      const tn = parseInt(table);
      if (!(tn >= 1 && tn <= settings.tables) || String(tn) !== table) return send(res, 400, { error: "geçersiz masa" });
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return send(res, 400, { error: "geçersiz" });
      const items = [];
      for (const i of b.items) {
        const q = Number(i.q);
        if (!(i.n in PRICE) || !Number.isInteger(q) || q < 1 || q > 20) return send(res, 400, { error: "geçersiz ürün" });
        items.push({ n: i.n, q, p: PRICE[i.n] });          // fiyat HER ZAMAN sunucudan
      }
      const o = {
        id: "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        table, items, note: String(b.note || "").slice(0, 200),
        total: items.reduce((s, i) => s + i.p * i.q, 0), status: "Yeni", ts: Date.now(),
      };
      orders.push(o); save();
      return send(res, 200, o);
    }

    const m = u.pathname.match(/^\/api\/orders\/([\w-]+)\/status$/);
    if (m && req.method === "POST") {
      if (!isKasa(req)) return send(res, 401, { error: "auth" });
      const b = await body(req), o = orders.find(x => x.id === m[1]);
      if (!o || !STAT.includes(b.status)) return send(res, 400, { error: "geçersiz" });
      o.status = b.status; save();
      return send(res, 200, o);
    }
    send(res, 404, { error: "yok" });
  } catch (e) { console.error(e); send(res, 500, { error: "hata" }); }
}).listen(PORT, () => console.log("Çalışıyor: http://localhost:" + PORT + "  (kasa şifresi: " + PASS + ")"));
