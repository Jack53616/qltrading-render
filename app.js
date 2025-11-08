const tg = window.Telegram?.WebApp; if(tg) tg.expand();

const state = {
  token: null,
  method: 'usdt_trc20',
  wallets: {}
};

// Simple toast
function toast(msg){ const el = document.getElementById('g-toast'); el.textContent = msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 1700); }

// Gate animated bg
(function fx(){
  const c = document.getElementById('fx'); if(!c) return;
  const ctx = c.getContext('2d');
  function size(){ c.width = innerWidth; c.height = innerHeight; } size(); addEventListener('resize', size, {passive:true});
  let t=0; (function loop(){ t+=0.006; ctx.clearRect(0,0,c.width,c.height);
    const cx=c.width/2, cy=c.height/2;
    for(let i=0;i<160;i++){
      const a = i/160 * Math.PI*2 + t*2;
      const r = 160 + Math.sin(i*0.25 + t*4) * 22;
      const x = cx + Math.cos(a)*r*2.2; const y = cy + Math.sin(a)*r*1.1;
      const s = 0.9 + Math.sin(i*0.8 + t*3)*0.4;
      ctx.fillStyle = `hsla(${220 + Math.sin(a)*40}, 90%, ${60 + Math.cos(a*2)*18}%, 0.12)`;
      ctx.beginPath(); ctx.arc(x,y,s,0,Math.PI*2); ctx.fill();
    }
    requestAnimationFrame(loop);
  })();
})();

// Auth via Telegram initData -> JWT
async function auth(){
  try{
    const initData = tg?.initData || ''; // In Telegram Mini App this is filled
    const r = await fetch('/api/auth/tg', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ initData })});
    const j = await r.json();
    if(j.ok){ state.token = j.token; localStorage.setItem('jwt', state.token); return true; }
    return false;
  }catch(e){ console.error(e); return false; }
}
async function ensureAuth(){
  state.token = localStorage.getItem('jwt');
  if(!state.token){
    const ok = await auth();
    if(!ok){ /* keep gate open */ return; }
  }
  // hide gate
  document.getElementById('gate').style.display='none';
  await refreshAll();
}

// Activate subscription key
document.getElementById('activate').addEventListener('click', async ()=>{
  const key = document.getElementById('key').value.trim();
  if(!key) return toast('Enter a valid key');
  try{
    const r = await fetch('/api/subscribe/activate', { method:'POST', headers:{'Content-Type':'application/json', 'Authorization':'Bearer '+(state.token||'')}, body: JSON.stringify({ key })});
    const j = await r.json();
    if(j.ok){ toast('Activated!'); document.getElementById('gate').style.display='none'; refreshAll(); }
    else toast(j.error||'Error');
  }catch(e){ toast('Error'); }
});

// Tabs
const seg = document.querySelectorAll('.seg-btn');
function setTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('show'));
  document.getElementById('tab-'+id).classList.add('show');
  seg.forEach(b=> b.classList.toggle('active', b.dataset.tab===id));
}
seg.forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.tab)));
document.getElementById('goWithdraw').addEventListener('click', ()=> setTab('withdraw'));
document.getElementById('goMarkets').addEventListener('click', ()=> setTab('markets'));
document.getElementById('goSupport').addEventListener('click', ()=> window.open('https://t.me/QL_Support','_blank'));

// Wallet summary
async function loadSummary(){
  const r = await fetch('/api/wallet/summary', { headers:{'Authorization':'Bearer '+(state.token||'')} });
  const j = await r.json(); if(!j.ok) return;
  document.getElementById('balance').textContent = '$'+Number(j.balance||0).toFixed(2);
  document.getElementById('pnlDay').textContent = '$'+Number(j.wins - j.losses).toFixed(2);
  document.getElementById('pnlMonth').textContent = '$'+Number(j.wins - j.losses).toFixed(2);
  document.getElementById('subLeft').textContent = j.sub_expires_at ? new Date(j.sub_expires_at).toLocaleDateString() : '—';
  document.getElementById('ops').innerHTML = (j.ops||[]).map(o=>`<div class="op"><div class="k">${o.type} • ${new Date(o.created_at).toLocaleString()}</div><div class="v">${(o.amount>=0?'+':'-')}$${Math.abs(o.amount).toFixed(2)}</div></div>`).join('');
}

// Activity ticker
async function loadFeed(){
  try{
    const r = await fetch('/api/activity/ticker');
    const j = await r.json(); if(!j.ok) return;
    document.getElementById('feed').innerHTML = j.items.map(i=>`<div class="item">${i.text}</div>`).join('');
  }catch{}
}
setInterval(loadFeed, 20000);

// Markets
const cards = Array.from(document.querySelectorAll('.mkt'));
async function loadMarkets(){
  try{
    const r = await fetch('/api/markets'); const j = await r.json();
    if(!j.ok) return;
    cards.forEach(card=>{
      const sym = card.dataset.sym;
      const it = j.symbols.find(s=>s.sym===sym);
      if(!it) return;
      card.querySelector('.price').textContent = '$'+(it.price>1000? it.price.toFixed(0): it.price.toFixed(2));
      drawSpark(card.querySelector('.spark'), it.series||[]);
    });
  }catch(e){}
}
function drawSpark(c, series){
  const ctx=c.getContext('2d'); const w=c.width,h=c.height; ctx.clearRect(0,0,w,h);
  if(!series.length) return; const min=Math.min(...series), max=Math.max(...series), norm=v=>h-((v-min)/(max-min||1))*h;
  ctx.lineWidth=2; const g=ctx.createLinearGradient(0,0,w,0); g.addColorStop(0,'#b3a6ff'); g.addColorStop(1,'#4fe3ff');
  ctx.strokeStyle=g; ctx.beginPath(); series.forEach((v,i)=>{ const x=(i/(series.length-1))*w, y=norm(v); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
}
setInterval(loadMarkets, 5000);

// Withdraw
const methods = { usdt_trc20:'USDT (TRC20)', usdt_erc20:'USDT (ERC20)', btc:'Bitcoin (BTC)', eth:'Ethereum (ETH)' };
function setMethod(m){
  state.method = m; document.getElementById('methodLabel').textContent = methods[m];
  document.getElementById('methodView').innerHTML = `<div class="op"><div class="k">Address</div><div class="v"><input id="addr_${m}" class="input" placeholder="${m==='usdt_erc20' || m==='eth' ? '0x...' : (m==='btc'?'bc1...':'T...')}"/></div></div>`;
}
setMethod('usdt_trc20');

document.getElementById('pickMethod').addEventListener('click', ()=> document.getElementById('sheet').classList.add('show'));
document.getElementById('sCancel').addEventListener('click', ()=> document.getElementById('sheet').classList.remove('show'));
document.querySelectorAll('.s-item').forEach(b=> b.addEventListener('click', ()=>{ setMethod(b.dataset.method); document.getElementById('sheet').classList.remove('show'); }));

document.getElementById('reqWithdraw').addEventListener('click', async ()=>{
  const amount = Number(document.getElementById('amount').value||0);
  const addr = document.getElementById('addr_'+state.method)?.value?.trim();
  if(!amount || !addr) return alert('Enter a valid amount and address');
  const r = await fetch('/api/withdraw/request', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+(state.token||'')}, body: JSON.stringify({ amount, method: state.method, address: addr })});
  const j = await r.json(); if(j.ok){ alert('Request created #'+j.request.id); document.getElementById('amount').value=''; loadRequests(); loadSummary(); }
  else alert(j.error||'Error');
});

async function loadRequests(){
  const r = await fetch('/api/withdraw/my', { headers:{'Authorization':'Bearer '+(state.token||'')} });
  const j = await r.json(); if(!j.ok) return;
  const el = document.getElementById('reqList');
  el.innerHTML = j.list.map(x=>`<div class="op"><div class="k">#${x.id} • ${new Date(x.created_at).toLocaleString()}<br><small>${x.method} → ${x.address}</small></div><div class="v">${x.status} • $${Number(x.amount).toFixed(2)} ${x.status==='pending'?`<button class="btn small" data-id="${x.id}">Cancel</button>`:''}</div></div>`).join('');
  el.querySelectorAll('button[data-id]').forEach(b=> b.addEventListener('click', async ()=>{
    const id = Number(b.dataset.id);
    const r2 = await fetch('/api/withdraw/cancel', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+(state.token||'')}, body: JSON.stringify({ id })});
    const j2 = await r2.json(); if(j2.ok){ loadRequests(); loadSummary(); }
  }));
}

// WhatsApp deposit
document.getElementById('whatsapp').addEventListener('click', async ()=>{
  const r = await fetch('/api/deposit/whatsapp', { headers:{'Authorization':'Bearer '+(state.token||'')} });
  const j = await r.json(); if(j.ok) window.open(j.url, '_blank');
});

// Animate mini chart
const chartPath = document.getElementById('chartPath'); let phase=0;(function anim(){ phase += 0.04; const y = 12 + Math.sin(phase)*2; chartPath.setAttribute('d', `M0,18 C15,12 22,16 30,15 C40,14 52,10 60,12 C70,14 82,11 100,${y}`); requestAnimationFrame(anim) })();

async function refreshAll(){ await Promise.all([loadSummary(), loadRequests(), loadMarkets(), loadFeed()]); }
ensureAuth();
