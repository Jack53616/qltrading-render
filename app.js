// QL Trading AI v2.1 — Frontend logic
const TWA = window.Telegram?.WebApp;
const state = {
  tg_id: null,
  token: null,
  user: null,
  lang: localStorage.getItem("lang") || "en",
  feedTimer: null,
  musicOn: false,
  method: "usdt_trc20",
  methodAddr: ""
};

const i18n = {
  en: {
    gateTitle: "QL Trading — Access",
    gateSub: "Enter your subscription key to unlock your wallet",
    confirm: "Confirm",
    buyKey: "Buy a key",
    tabWallet: "Home",
    tabMarkets: "Markets",
    tabTrades: "Trades",
    tabWithdraw: "Withdraw",
    tabRequests: "Requests",
    tabSupport: "Support",
    noOpenTrade: "No open trade",
    withdraw: "Withdraw",
    markets: "Markets",
    support: "Support",
    day: "Day",
    month: "Month",
    subLeft: "Subscription",
    recent: "Recent activity",
    live: "Live feed",
    withdrawCrypto: "Withdraw (Crypto only)",
    request: "Request",
    savedAddr: "* Saved address for selected method will be used.",
    deposit: "Deposit",
    yourRequests: "Your requests",
    supportCenter: "Support Center",
    chooseMethod: "Choose withdraw method",
    cancel: "Cancel",
    myTrades: "My Trades",
    save: "Save"
  },
  ar: {
    gateTitle: "QL Trading — دخول",
    gateSub: "أدخل مفتاح الاشتراك لفتح محفظتك",
    confirm: "تأكيد",
    buyKey: "شراء مفتاح",
    tabWallet: "الرئيسية",
    tabMarkets: "الأسواق",
    tabTrades: "صفقاتي",
    tabWithdraw: "السحب",
    tabRequests: "الطلبات",
    tabSupport: "الدعم",
    noOpenTrade: "لا توجد صفقة مفتوحة",
    withdraw: "سحب",
    markets: "أسواق",
    support: "الدعم",
    day: "اليوم",
    month: "الشهر",
    subLeft: "الاشتراك",
    recent: "النشاط الأخير",
    live: "بث مباشر",
    withdrawCrypto: "سحب (عملات رقمية فقط)",
    request: "طلب",
    savedAddr: "* سيتم استخدام العنوان المحفوظ للطريقة المحددة.",
    deposit: "إيداع",
    yourRequests: "طلباتك",
    supportCenter: "مركز الدعم",
    chooseMethod: "اختر طريقة السحب",
    cancel: "إلغاء",
    myTrades: "صفقاتي",
    save: "حفظ"
  },
  tr: { /* اختصاراً نستخدم الإنجليزية لو ما وجدت */ },
  de: { /* اختصاراً نستخدم الإنجليزية لو ما وجدت */ }
}

function t(key){
  const lang = state.lang;
  return (i18n[lang] && i18n[lang][key]) || (i18n.en[key]||key);
}
function applyI18n(){
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    el.textContent = t(el.dataset.i18n);
  });
  document.body.dir = (state.lang === "ar") ? "rtl" : "ltr";
}

const $ = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);

// Splash fade then gate
setTimeout(()=> { $("#splash")?.classList.add("hidden"); }, 1800);

// Setup TG id
function detectTG(){
  try{
    const initDataUnsafe = TWA?.initDataUnsafe;
    const tgId = initDataUnsafe?.user?.id || null;
    state.tg_id = tgId;
  }catch{ state.tg_id = null; }
}

// Token (optional)
async function getToken(){
  if(!state.tg_id) return;
  const r = await fetch("/api/token",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tg_id: state.tg_id})}).then(r=>r.json());
  if(r.ok) state.token = r.token;
}

// Activate
$("#g-activate").addEventListener("click", async ()=>{
  const key = $("#g-key").value.trim();
  const name = $("#g-name").value.trim();
  const email = $("#g-email").value.trim();
  if(!key) return toast("Enter key");
  const tg_id = state.tg_id || Number(prompt("Enter Telegram ID (test):","1262317603"));
  const r = await fetch("/api/activate",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({key,tg_id,name,email})}).then(r=>r.json());
  if(!r.ok){ toast("Invalid key"); return; }
  state.user = r.user;
  localStorage.setItem("tg", r.user.tg_id);
  openApp();
});
function toast(msg){ const el=$("#g-toast"); el.textContent=msg; setTimeout(()=> el.textContent="", 2500); }

// App open
async function openApp(){
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await refreshUser();
  applyI18n();
  startFeed();
  refreshOps();
  refreshRequests();
  refreshMarkets();
}

// Tabs
$$(".seg-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    $$(".seg-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $$(".tab").forEach(s=>s.classList.remove("show"));
    $(`#tab-${tab}`)?.classList.add("show");
  });
});

$("#goWithdraw").onclick = ()=>{ document.querySelector('[data-tab="withdraw"]').click(); }
$("#goMarkets").onclick  = ()=>{ document.querySelector('[data-tab="markets"]').click(); }
$("#goSupport").onclick  = ()=>{ document.querySelector('[data-tab="support"]').click(); }

// Language
$("#btnLang").addEventListener("click", ()=>{
  const order = ["en","ar","tr","de"];
  const idx = order.indexOf(state.lang);
  state.lang = order[(idx+1)%order.length];
  localStorage.setItem("lang", state.lang);
  applyI18n();
});

// Music
const snd = $("#sndNotify");
let bgAudio = null;
$("#btnMusic").addEventListener("click", ()=>{
  if(!state.musicOn){
    if(!bgAudio){
      bgAudio = new Audio();
      bgAudio.src = "notify.mp3"; // مبدئياً نفس الملف (خفيف)
      bgAudio.loop = true;
      bgAudio.volume = 0.15;
    }
    state.musicOn = true; bgAudio.play().catch(()=>{});
  }else{
    state.musicOn = false; bgAudio.pause();
  }
});

// Withdraw sheet
const sheet = $("#sheet");
$("#pickMethod").addEventListener("click", ()=> sheet.classList.add("show"));
$("#sCancel").addEventListener("click", ()=> sheet.classList.remove("show"));
$$(".s-item").forEach(b=>{
  b.addEventListener("click", ()=>{
    state.method = b.dataset.method;
    $("#methodLabel").textContent = b.textContent;
    renderMethod();
    sheet.classList.remove("show");
  });
});

function renderMethod(){
  const map = {
    usdt_trc20: "USDT (TRC20)",
    usdt_erc20: "USDT (ERC20)",
    btc: "Bitcoin",
    eth: "Ethereum"
  };
  $("#methodLabel").textContent = map[state.method] || "USDT (TRC20)";
  $("#methodView").innerHTML = `
    <div class="muted">Saved address:</div>
    <input id="addr" class="input" placeholder="Your ${map[state.method]||'Wallet'} address..."/>
    <button id="saveAddr" class="btn">Save</button>
  `;
  $("#saveAddr").onclick = async ()=>{
    const addr = $("#addr").value.trim();
    const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
    await fetch("/api/withdraw/method",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tg_id:tg, method:state.method, addr})});
    notify("✅ Address saved");
  }
}
renderMethod();

$("#reqWithdraw").addEventListener("click", async ()=>{
  const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
  const amount = Number($("#amount").value || 0);
  if(amount<=0) return notify("Enter amount");
  const r = await fetch("/api/withdraw",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tg_id:tg, amount, method: state.method})}).then(r=>r.json());
  if(!r.ok) return notify("❌ "+(r.error||"Error"));
  notify("✅ Request sent");
  refreshUser(); refreshRequests();
});

// WhatsApp deposit
$("#whatsapp").onclick = ()=> window.open("https://wa.me/message/P6BBPSDL2CC4D1","_blank");

// Data
async function refreshUser(){
  const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
  if(!tg) return;
  const r = await fetch(`/api/user/${tg}`).then(r=>r.json());
  if(r.ok){
    state.user = r.user;
    $("#balance").textContent = "$"+Number(r.user.balance||0).toFixed(2);
    $("#subLeft").textContent = r.user.sub_expires ? new Date(r.user.sub_expires).toLocaleDateString() : "—";
  }
}

async function refreshOps(){
  const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
  if(!tg) return;
  const r = await fetch(`/api/ops/${tg}`).then(r=>r.json());
  const box = $("#ops"); box.innerHTML = "";
  if(r.ok){
    r.list.forEach(o=>{
      const div = document.createElement("div");
      div.className="op";
      div.innerHTML = `<span>${o.type||'op'}</span><b>${Number(o.amount).toFixed(2)}</b>`;
      box.appendChild(div);
    });
  }
}

async function refreshRequests(){
  const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
  if(!tg) return;
  const r = await fetch(`/api/requests/${tg}`).then(r=>r.json());
  const box = $("#reqList"); box.innerHTML = "";
  if(r.ok){
    r.list.forEach(req=>{
      const div = document.createElement("div");
      div.className="op";
      div.innerHTML = `<span>#${req.id} — ${req.method} — ${req.status}</span><b>$${Number(req.amount).toFixed(2)}</b>`;
      if(req.status==="pending"){
        const b = document.createElement("button");
        b.className="btn"; b.style.marginLeft="8px"; b.textContent="Cancel";
        b.onclick = async ()=>{
          const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
          await fetch("/api/withdraw/cancel",{method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({tg_id:tg, id:req.id})});
          refreshRequests(); refreshUser();
        };
        div.appendChild(b);
      }
      box.appendChild(div);
    });
  }
}

// Markets
async function refreshMarkets(){
  try{
    const r = await fetch("/api/markets").then(r=>r.json());
    if(!r.ok) return;
    $$(".mkt").forEach(card=>{
      const sym = card.dataset.sym;
      const price = r.data?.[sym] || 0;
      card.querySelector(".price").textContent = "$"+Number(price).toFixed(2);
      // spark fake
      const c = card.querySelector("canvas");
      const ctx = c.getContext("2d");
      ctx.clearRect(0,0,c.width,c.height);
      ctx.beginPath();
      let y = 40 + Math.random()*8;
      ctx.moveTo(0,y);
      for(let x=0; x<c.width; x+=8){
        y += (Math.random()-0.5)*4;
        ctx.lineTo(x,y);
      }
      ctx.lineWidth = 2; ctx.strokeStyle = "#7fe0ff";
      ctx.stroke();
      // pct
      const pct = ((Math.random()-.5)*2).toFixed(2);
      card.querySelector(".pct").textContent = (pct>0?"+":"") + pct + "%";
      card.querySelector(".pct").style.color = (pct>=0) ? "#9df09d" : "#ff8899";
    });
  }catch{}
}

// Live feed (وهمي كل 20 ثانية)
const names = ["أحمد","محمد","خالد","سارة","رامي","نور","ليلى","وسيم","حسن","طارق"];
function startFeed(){
  if(state.feedTimer) clearInterval(state.feedTimer);
  const feed = $("#feed");
  const push = (txt)=>{
    const it = document.createElement("div");
    it.className="item"; it.textContent = txt;
    feed.prepend(it);
    $("#sndNotify")?.play().catch(()=>{});
    while(feed.childElementCount>12) feed.lastChild.remove();
  };
  const once = ()=>{
    const r = Math.random();
    const name = names[Math.floor(Math.random()*names.length)];
    if(r<0.34){
      const v = 50+Math.floor(Math.random()*200);
      push(`🪙 ${name} سحب ${v}$ بنجاح`);
    }else if(r<0.67){
      const v = 20+Math.floor(Math.random()*120);
      const m = ["Gold","BTC","ETH","Silver"][Math.floor(Math.random()*4)];
      push(`💰 ${name} ربح ${v}$ من صفقة ${m}`);
    }else{
      const v = 150+Math.floor(Math.random()*400);
      push(`🎉 مستخدم جديد انضم وأودع ${v}$`);
    }
  };
  once();
  state.feedTimer = setInterval(once, 20000);
}

// Fake balance ticker (يتحرك إذا في صفقة يومية)
let tickerI = 0;
setInterval(async ()=>{
  if(!state.user) return;
  // اسحب daily_targets النشطة؟ (للتبسيط: حرك واجهة فقط)
  // الحركة البصرية:
  const dir = Math.random()>.5?1:-1;
  const step = (Math.random()*0.8)*dir;
  const cur = Number(String($("#balance").textContent).replace(/[^\d.]/g,""))||0;
  const next = Math.max(0, cur + step);
  $("#balance").textContent = "$"+next.toFixed(2);
  const change = (dir>0?"+":"") + step.toFixed(2);
  $("#ticker").textContent = change;
  $("#ticker").style.color = (dir>0) ? "#9df09d" : "#ff8899";
  // خط الرسم
  const p = $("#chartPath");
  tickerI = (tickerI+1)%100;
  const y = 12 + Math.sin(tickerI/8)*3 + (dir>0?-1:1);
  p.setAttribute("d", `M0,18 C15,12 22,16 30,15 C40,14 52,10 60,12 C70,14 82,${y} 100,12`);
}, 2000);

// Trades (عرض بسيط)
async function loadTrades(){
  const tg = state.user?.tg_id || Number(localStorage.getItem("tg"));
  // ما في endpoint لائحة، نعرض من ops كتمثيل مبسط:
  const box = $("#tradesList"); box.innerHTML = "";
  const div = document.createElement("div");
  div.className="op";
  div.innerHTML = `<span>Open trade: XAUUSD</span><b>running...</b>`;
  box.appendChild(div);
}
$("#saveSLTP").onclick = ()=>{
  notify("✅ SL/TP saved");
};

// Helpers
function notify(msg){
  const el = document.createElement("div");
  el.className="feed item";
  el.textContent = msg;
  $("#feed").prepend(el);
  $("#sndNotify")?.play().catch(()=>{});
  setTimeout(()=>{ el.remove();}, 6000);
}

// Boot
(async function(){
  detectTG();
  await getToken();
  applyI18n();

  // إذا عنده TG محفوظ، جرّب تفتح مباشرة
  const old = localStorage.getItem("tg");
  if(old){
    // افتح المحفظة مباشرة
    state.user = { tg_id: Number(old) };
    openApp();
  }
})();
