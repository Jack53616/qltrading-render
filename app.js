const tg = window.Telegram?.WebApp;
try { tg?.ready(); } catch (_) {}

const initData = tg?.initDataUnsafe || null;
const tgId = initData?.user?.id || null;

// Gate logic: show subscription gate if no init data (e.g., Telegram Web)
if (!tgId) document.getElementById('gate')?.classList.remove('hide');

// Basic i18n
const dict = {
  en: {
    tab_wallet:"Home", tab_markets:"Markets", tab_withdraw:"Withdraw", tab_requests:"Requests", tab_trades:"My Trades",
    withdraw:"Withdraw", markets:"Markets", support:"Support",
    day:"Day", month:"Month", sub:"Subscription", recent:"Recent activity", livefeed:"Live feed",
    withdraw_title:"Withdraw (Crypto only)", request:"Request", saved_addr:"* Your saved address will be used.",
    deposit_title:"Deposit", your_requests:"Your requests", open_trades:"Open trades", choose_method:"Choose withdraw method",
    cancel:"Cancel", gate_title:"QL Trading — Access", gate_sub:"Enter your subscription key to unlock your wallet",
    activate:"Confirm", buy_key:"Buy a key", no_trade:"No open trade"
  },
  ar: {
    tab_wallet:"المحفظة", tab_markets:"الأسواق", tab_withdraw:"السحب", tab_requests:"الطلبات", tab_trades:"صفقاتي",
    withdraw:"سحب", markets:"الأسواق", support:"الدعم",
    day:"اليوم", month:"الشهر", sub:"الاشتراك", recent:"النشاط الأخير", livefeed:"التغذية الحية",
    withdraw_title:"سحب (عملات رقمية فقط)", request:"طلب", saved_addr:"* سيتم استخدام العنوان المحفوظ للطريقة المختارة.",
    deposit_title:"إيداع", your_requests:"طلباتك", open_trades:"الصفقات المفتوحة", choose_method:"اختر طريقة السحب",
    cancel:"إلغاء", gate_title:"QL Trading — دخول", gate_sub:"أدخل مفتاح الاشتراك لفتح محفظتك", activate:"تأكيد", buy_key:"شراء مفتاح",
    no_trade:"لا توجد صفقة مفتوحة"
  },
  tr: {
    tab_wallet:"Cüzdan", tab_markets:"Piyasalar", tab_withdraw:"Çekim", tab_requests:"Talepler", tab_trades:"İşlemlerim",
    withdraw:"Çekim", markets:"Piyasalar", support:"Destek",
    day:"Gün", month:"Ay", sub:"Abonelik", recent:"Son işlemler", livefeed:"Canlı akış",
    withdraw_title:"Çekim (Sadece Kripto)", request:"Talep", saved_addr:"* Seçilen yöntem için kayıtlı adres kullanılacaktır.",
    deposit_title:"Yatırma", your_requests:"Taleplerin", open_trades:"Açık işlemler", choose_method:"Çekim yöntemini seç",
    cancel:"İptal", gate_title:"QL Trading — Erişim", gate_sub:"Cüzdanını açmak için abonelik anahtısını gir", activate:"Onayla", buy_key:"Anahtar satın al",
    no_trade:"Açık işlem yok"
  },
  de: {
    tab_wallet:"Wallet", tab_markets:"Märkte", tab_withdraw:"Auszahlung", tab_requests:"Anfragen", tab_trades:"Meine Trades",
    withdraw:"Auszahlen", markets:"Märkte", support:"Support",
    day:"Tag", month:"Monat", sub:"Abo", recent:"Letzte Aktivität", livefeed:"Live-Feed",
    withdraw_title:"Auszahlung (nur Krypto)", request:"Anfragen", saved_addr:"* Gespeicherte Adresse wird verwendet.",
    deposit_title:"Einzahlung", your_requests:"Deine Anfragen", open_trades:"Offene Trades", choose_method:"Auszahlungsmethode wählen",
    cancel:"Abbrechen", gate_title:"QL Trading — Zugang", gate_sub:"Abo-Schlüssel eingeben, um Wallet zu öffnen", activate:"Bestätigen", buy_key:"Schlüssel kaufen",
    no_trade:"Kein offener Trade"
  }
};

let lang = localStorage.getItem('ql_lang') || 'en';
function applyLang(){
  const t = dict[lang] || dict.en;
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    if(t[key]) el.textContent = t[key];
  });
}
applyLang();

// Language sheet
const langSheet = document.getElementById('langSheet');
document.getElementById('btnLang').onclick = ()=> langSheet.classList.add('show');
document.getElementById('lCancel').onclick = ()=> langSheet.classList.remove('show');
langSheet.addEventListener('click', (e)=>{
  const l = e.target?.dataset?.lang;
  if(!l) return;
  lang = l; localStorage.setItem('ql_lang', lang);
  applyLang(); langSheet.classList.remove('show');
  // optionally tell server
  fetch('/api/user/lang', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-ql-tg': tgId }, body: JSON.stringify({ lang }) });
});

// Navigation
const tabs = document.querySelectorAll('.seg-btn');
tabs.forEach(b=> b.addEventListener('click', ()=>{
  document.querySelectorAll('.seg-btn').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.tab').forEach(t=> t.classList.remove('show'));
  document.getElementById('tab-'+b.dataset.tab).classList.add('show');
}));

// Quick nav
document.getElementById('goWithdraw').onclick = ()=> document.querySelector('[data-tab="withdraw"]').click();
document.getElementById('goMarkets').onclick  = ()=> document.querySelector('[data-tab="markets"]').click();
document.getElementById('goSupport').onclick  = ()=> window.open('https://wa.me/message/P6BBPSDL2CC4D1', '_blank');

// Gate activate
const keyInput = document.getElementById('key');
document.getElementById('activate').onclick = async ()=>{
  const key = keyInput.value.trim();
  if(!key) return toast('Enter key');
  const r = await fetch('/api/auth/activateKey', { method:'POST', headers:{'Content-Type':'application/json','x-ql-tg':tgId}, body: JSON.stringify({ key }) }).then(r=>r.json());
  if(r.ok){ toast('Activated'); document.getElementById('gate').classList.add('hide'); loadAll(); }
  else toast(r.error||'Error');
};

// Show user id
document.getElementById('userId').textContent = tgId ? `ID: ${tgId}` : '';

// Markets: Binance WS for BTC/ETH, polling metals
function wsTicker(sym, cb){
  const s = new WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@trade`);
  s.onmessage = ev=>{ try{ const { p } = JSON.parse(ev.data); cb(Number(p)); }catch(e){} };
  s.onclose = ()=> setTimeout(()=> wsTicker(sym, cb), 2000);
}
function updateMarket(sym, price){
  const el = document.querySelector(`.mkt[data-sym="${sym}"] .price`);
  if(el && price) el.textContent = `$${Number(price).toFixed(2)}`;
}
try{
  wsTicker('btcusdt', p=> updateMarket('BTCUSDT', p));
  wsTicker('ethusdt', p=> updateMarket('ETHUSDT', p));
}catch(_){}
async function pollMetals(){
  try{
    const r = await fetch('/api/metals').then(r=>r.json());
    if(r.ok){
      updateMarket('XAUUSD', r.XAUUSD);
      updateMarket('XAGUSD', r.XAGUSD);
    }
  }catch(_){}
  setTimeout(pollMetals, 15000);
}
pollMetals();

// Wallet polling
async function pollWallet(){
  if(!tgId) return setTimeout(pollWallet, 3000);
  try{
    const r = await fetch('/api/user/me',{ headers:{'x-ql-tg': tgId }}).then(r=>r.json());
    if(r.ok){
      const b = Number(r.user.balance||0);
      document.getElementById('balance').textContent = `$${b.toFixed(2)}`;
      // simple pnl ticker from last op
      const last = (r.ops||[])[0];
      if(last && Number(last.amount)){
        const pnl = Number(last.amount);
        const percent = (pnl / Math.max(1,b - pnl)) * 100;
        const el = document.getElementById('ticker');
        el.textContent = `${pnl>=0?'+':'-'}$${Math.abs(pnl).toFixed(2)} (${percent.toFixed(2)}%)`;
        el.style.color = pnl>=0 ? '#00d27a' : '#ff5a6b';
        if(pnl<0) toast(`📉 ${dict[lang].day||'Day'}: -$${Math.abs(pnl).toFixed(2)}`);
      }
      // ops list
      renderOps(r.ops||[]);
      // requests list
      renderReqs(r.requests||[]);
      // trades list
      renderTrades(r.trades||[]);
      // trade badge
      const open = (r.trades||[]).some(t=> t.status==='open');
      document.getElementById('tradeBadge').textContent = open ? 'Open trade active' : (dict[lang].no_trade||'No open trade');
    }
  }catch(_){}
  setTimeout(pollWallet, 3000);
}
pollWallet();

function renderOps(rows){
  const box = document.getElementById('ops'); box.innerHTML='';
  rows.forEach(op=>{
    const el = document.createElement('div');
    el.className = 'op';
    el.innerHTML = `<div><b>${op.type}</b><div class="muted">${new Date(op.created_at).toLocaleString()}</div></div>
      <div style="color:${Number(op.amount)>=0?'#00d27a':'#ff5a6b'}">${Number(op.amount)>=0?'+':'-'}$${Math.abs(Number(op.amount)).toFixed(2)}</div>`;
    box.appendChild(el);
  });
}

function renderReqs(rows){
  const box = document.getElementById('reqList'); box.innerHTML='';
  rows.forEach(r=>{
    const el = document.createElement('div');
    el.className='op';
    el.innerHTML = `<div><b>#${r.id}</b> ${r.method} — $${Number(r.amount).toFixed(2)} <div class="muted">${r.status}</div></div>
      ${r.status==='pending' ? '<button class="btn xs" data-cancel="'+r.id+'">Cancel</button>' : ''}`;
    box.appendChild(el);
  });
  box.onclick = async (e)=>{
    const id = e.target?.dataset?.cancel; if(!id) return;
    await fetch('/api/withdraw/cancel/'+id, { method:'POST', headers:{ 'x-ql-tg': tgId }});
    pollWallet();
  };
}

function renderTrades(rows){
  const box = document.getElementById('trades'); box.innerHTML='';
  rows.filter(t=>t.status==='open').forEach(t=>{
    const el = document.createElement('div');
    el.className='op';
    el.innerHTML = `
      <div>
        <b>#${t.id}</b> ${t.symbol} — <span class="muted">${t.status}</span>
        <div class="muted">SL: ${t.stop_loss??'—'} / TP: ${t.take_profit??'—'}</div>
      </div>
      <div>
        <button class="btn xs" data-close="${t.id}">Close</button>
        <button class="btn xs" data-sltp="${t.id}">SL/TP</button>
      </div>
    `;
    box.appendChild(el);
  });
  box.onclick = async (e)=>{
    const id = e.target?.dataset?.close;
    const st = e.target?.dataset?.sltp;
    if(id){
      await fetch('/api/trades/close/'+id, { method:'POST', headers:{ 'x-ql-tg': tgId }});
      pollWallet();
    }
    if(st){
      const sl = prompt('Stop-Loss (e.g. -20):');
      const tp = prompt('Take-Profit (e.g. 60):');
      await fetch('/api/trades/updateSLTP', { method:'POST', headers:{'Content-Type':'application/json','x-ql-tg':tgId}, body: JSON.stringify({ id: Number(st), stop_loss: sl?Number(sl):null, take_profit: tp?Number(tp):null }) });
      pollWallet();
    }
  };
}

// Withdraw UI
const sheet = document.getElementById('sheet');
document.getElementById('pickMethod').onclick = ()=> sheet.classList.add('show');
document.getElementById('sCancel').onclick = ()=> sheet.classList.remove('show');
let method = 'usdt_trc20';
document.getElementById('methodLabel').textContent = 'USDT (TRC20)';
sheet.addEventListener('click', (e)=>{
  const m = e.target?.dataset?.method;
  if(!m) return;
  method = m; const map = {usdt_trc20:'USDT (TRC20)', usdt_erc20:'USDT (ERC20)', btc:'Bitcoin', eth:'Ethereum'};
  document.getElementById('methodLabel').textContent = map[m]||m;
  sheet.classList.remove('show');
});
document.getElementById('reqWithdraw').onclick = async ()=>{
  const addr = document.getElementById('address').value.trim();
  const amt = Number(document.getElementById('amount').value);
  if(!amt || amt<=0) return toast('Enter amount');
  await fetch('/api/withdraw/request', { method:'POST', headers:{'Content-Type':'application/json','x-ql-tg':tgId}, body: JSON.stringify({ method, address: addr, amount: amt }) });
  toast('Requested'); document.getElementById('amount').value=''; pollWallet();
};

document.getElementById('whatsapp').onclick = ()=> window.open('https://wa.me/message/P6BBPSDL2CC4D1','_blank');

function toast(msg){
  const t = document.createElement('div');
  t.className='toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(()=> t.remove(), 2500);
}

function loadAll(){ pollWallet(); }

// Auto load if already authorized
if(tgId) loadAll();
