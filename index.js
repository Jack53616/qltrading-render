const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cors = require('cors');
const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args)).catch(()=>Promise.reject(new Error('node-fetch missing')));

const { checkTelegramInitData, parseInitData } = require('./verifyInitData');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin';
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5000);
const WHATSAPP_URL = process.env.WHATSAPP_URL || 'https://wa.me/message/P6BBPSDL2CC4D1';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

if(!DATABASE_URL) {
  console.error('DATABASE_URL missing');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname,'../frontend')));

// --- helpers
async function q(query, params){ const c = await pool.connect(); try{ const r = await c.query(query, params); return r; } finally { c.release(); } }
function sign(user){ return jwt.sign({ id:user.id, tg_id:user.tg_id }, JWT_SECRET, { expiresIn:'7d' }); }
function auth(req,res,next){
  const hdr = req.headers.authorization||'';
  const token = hdr.startsWith('Bearer ')? hdr.slice(7): null;
  if(!token) return res.status(401).json({ok:false, error:'no_token'});
  try{ req.user = jwt.verify(token, JWT_SECRET); next(); } catch{ return res.status(401).json({ok:false, error:'bad_token'}); }
}
function admin(req,res,next){
  const t = req.headers['x-admin-token']||req.query.admin_token;
  if(t && t===ADMIN_TOKEN) return next();
  return res.status(403).json({ok:false, error:'forbidden'});
}

// --- DB bootstrap endpoint (optional)
app.post('/api/admin/migrate', admin, async (req,res)=>{
  const fs = require('fs');
  const sql = fs.readFileSync(path.join(__dirname,'db.sql'),'utf8');
  try{
    await q(sql);
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

// --- Auth: Telegram initData -> JWT
app.post('/api/auth/tg', async (req,res)=>{
  const { initData } = req.body || {};
  if(!initData) return res.status(400).json({ok:false, error:'initData required'});
  if(!BOT_TOKEN) return res.status(500).json({ok:false, error:'BOT_TOKEN missing on server'});
  const ok = checkTelegramInitData(initData, BOT_TOKEN);
  if(!ok) return res.status(401).json({ok:false, error:'invalid_init'});
  const tg = parseInitData(initData);
  if(!tg || !tg.id) return res.status(400).json({ok:false, error:'no_user'});

  // upsert user
  const name = [tg.first_name||'', tg.last_name||''].join(' ').trim() || tg.username || ('tg'+tg.id);
  const r = await q(`INSERT INTO users (tg_id, name, language)
                     VALUES ($1,$2,$3)
                     ON CONFLICT (tg_id) DO UPDATE SET name=EXCLUDED.name
                     RETURNING *`, [tg.id, name, 'en']);
  const user = r.rows[0];
  const token = sign(user);
  res.json({ok:true, token, user: { id:user.id, name:user.name, balance:user.balance, language:user.language, sub_expires_at:user.sub_expires_at }});
});

// --- Subscription: activate key
app.post('/api/subscribe/activate', auth, async (req,res)=>{
  const { key } = req.body||{};
  if(!key) return res.status(400).json({ok:false, error:'key required'});
  const u = await q(`SELECT * FROM users WHERE id=$1`, [req.user.id]).then(r=>r.rows[0]);
  const k = await q(`SELECT * FROM keys WHERE key_code=$1`, [key]).then(r=>r.rows[0]);
  if(!k) return res.status(400).json({ok:false, error:'invalid_key'});
  if(k.used_by) return res.status(400).json({ok:false, error:'used_key'});
  const days = k.days||30;
  await q(`UPDATE keys SET used_by=$1, used_at=now() WHERE id=$2`, [u.id, k.id]);
  await q(`UPDATE users SET sub_expires_at = COALESCE(sub_expires_at, now()) + INTERVAL '${days} days' WHERE id=$1`, [u.id]);
  const u2 = await q(`SELECT * FROM users WHERE id=$1`, [u.id]).then(r=>r.rows[0]);
  res.json({ok:true, sub_expires_at: u2.sub_expires_at});
});

// --- Wallet summary
app.get('/api/wallet/summary', auth, async (req,res)=>{
  const u = await q(`SELECT balance, wins, losses, sub_expires_at FROM users WHERE id=$1`, [req.user.id]).then(r=>r.rows[0]);
  const ops = await q(`SELECT type, amount, note, created_at FROM ops WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [req.user.id]).then(r=>r.rows);
  res.json({ok:true, ...u, ops});
});

// --- Trades
app.get('/api/trades/open', auth, async (req,res)=>{
  const r = await q(`SELECT id, symbol, opened_at FROM trades WHERE user_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`, [req.user.id]).then(r=>r.rows[0]);
  res.json({ok:true, trade:r||null});
});
app.get('/api/trades/history', auth, async (req,res)=>{
  const r = await q(`SELECT id, symbol, pnl, opened_at, closed_at FROM trades WHERE user_id=$1 AND status='closed' ORDER BY id DESC LIMIT 30`, [req.user.id]).then(r=>r.rows);
  res.json({ok:true, trades:r});
});

// --- Withdraw
app.get('/api/withdraw/my', auth, async (req,res)=>{
  const rows = await q(`SELECT id, amount, method, address, status, created_at, updated_at FROM requests WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [req.user.id]).then(r=>r.rows);
  res.json({ok:true, list:rows});
});
app.post('/api/withdraw/request', auth, async (req,res)=>{
  const { amount, method, address } = req.body||{};
  if(!amount || !method || !address) return res.status(400).json({ok:false, error:'missing fields'});
  const u = await q(`SELECT balance FROM users WHERE id=$1`, [req.user.id]).then(r=>r.rows[0]);
  if(Number(u.balance) < Number(amount)) return res.status(400).json({ok:false, error:'insufficient_balance'});
  await q(`UPDATE users SET balance = balance - $1 WHERE id=$2`, [amount, req.user.id]);
  const r = await q(`INSERT INTO requests (user_id, amount, method, address) VALUES ($1,$2,$3,$4) RETURNING *`, [req.user.id, amount, method, address]).then(r=>r.rows[0]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'withdraw',-$2,$3)`, [req.user.id, amount, `withdraw request #${r.id}`]);
  res.json({ok:true, request:r});
});
app.post('/api/withdraw/cancel', auth, async (req,res)=>{
  const { id } = req.body||{};
  const r = await q(`SELECT * FROM requests WHERE id=$1 AND user_id=$2`, [id, req.user.id]).then(r=>r.rows[0]);
  if(!r) return res.status(404).json({ok:false, error:'not_found'});
  if(r.status!=='pending') return res.status(400).json({ok:false, error:'cannot_cancel'});
  await q(`UPDATE requests SET status='canceled', updated_at=now() WHERE id=$1`, [id]);
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [r.amount, req.user.id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'system',$2,$3)`, [req.user.id, r.amount, `withdraw cancel #${r.id}`]);
  res.json({ok:true});
});

// --- Admin endpoints
app.post('/api/admin/addbalance', admin, async (req,res)=>{
  const { tg_id, amount, note } = req.body||{};
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg_id]).then(r=>r.rows[0]);
  if(!u) return res.status(404).json({ok:false, error:'user_not_found'});
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [amount, u.id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'admin',$2,$3)`, [u.id, amount, note||'addbalance']);
  res.json({ok:true});
});
app.post('/api/admin/create_key', admin, async (req,res)=>{
  const { key_code, days } = req.body||{};
  if(!key_code) return res.status(400).json({ok:false, error:'key_code required'});
  await q(`INSERT INTO keys (key_code, days) VALUES ($1,$2)`, [key_code, days||30]);
  res.json({ok:true});
});
app.post('/api/admin/open_trade', admin, async (req,res)=>{
  const { tg_id, symbol } = req.body||{};
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg_id]).then(r=>r.rows[0]);
  if(!u) return res.status(404).json({ok:false, error:'user_not_found'});
  const tr = await q(`INSERT INTO trades (user_id, symbol, status) VALUES ($1,$2,'open') RETURNING *`, [u.id, symbol]).then(r=>r.rows[0]);
  res.json({ok:true, trade:tr});
});
app.post('/api/admin/close_trade', admin, async (req,res)=>{
  const { trade_id, pnl } = req.body||{};
  const tr = await q(`SELECT * FROM trades WHERE id=$1`, [trade_id]).then(r=>r.rows[0]);
  if(!tr || tr.status!=='open') return res.status(400).json({ok:false, error:'no_open_trade'});
  await q(`UPDATE trades SET status='closed', closed_at=now(), pnl=$1 WHERE id=$2`, [pnl, trade_id]);
  if(Number(pnl)>=0){
    await q(`UPDATE users SET balance = balance + $1, wins = wins + $1 WHERE id=$2`, [pnl, tr.user_id]);
  } else {
    await q(`UPDATE users SET losses = losses + $1 WHERE id=$2`, [Math.abs(pnl), tr.user_id]);
  }
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'pnl',$2,$3)`, [tr.user_id, pnl, `trade #${trade_id}`]);
  res.json({ok:true});
});

// --- Markets (BTC, ETH from Binance; XAU/XAG from metals.live; graceful fallback)
let cache = { t:0, symbols: [] };
app.get('/api/markets', async (req,res)=>{
  const now = Date.now();
  if(now - cache.t < CACHE_TTL_MS) return res.json({ok:true, symbols: cache.symbols});
  try{
    const out = [];
    // BTC/ETH from Binance
    const sym = ['BTCUSDT','ETHUSDT'];
    for(const s of sym){
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`);
      const j = await r.json();
      const price = Number(j.price);
      out.push({ sym:s, price, changePct:0.0, series:[price-10, price-5, price, price+5] });
    }
    // Metals
    const m = await fetch('https://api.metals.live/v1/spot').then(r=>r.json()).catch(()=>null);
    if(Array.isArray(m)){
      const gold = m.find(x=>Array.isArray(x) && x[0]==='gold');
      const silver = m.find(x=>Array.isArray(x) && x[0]==='silver');
      if(gold) out.push({ sym:'XAUUSD', price: Number(gold[1]), changePct:0.0, series:[gold[1]-4, gold[1]-2, gold[1], gold[1]+3]});
      if(silver) out.push({ sym:'XAGUSD', price: Number(silver[1]), changePct:0.0, series:[silver[1]-0.2, silver[1], silver[1]+0.1]});
    }
    cache = { t: now, symbols: out };
    res.json({ok:true, symbols: out});
  }catch(e){
    res.json({ok:true, symbols: cache.symbols||[]});
  }
});

// --- Activity ticker (real + aggregates; no fabricated personal names)
app.get('/api/activity/ticker', async (req,res)=>{
  // Latest ops and requests (approved) in last 24h
  const recentOps = await q(`SELECT type, amount, note, created_at FROM ops WHERE created_at > now() - interval '1 day' ORDER BY id DESC LIMIT 5`).then(r=>r.rows);
  const recentApproved = await q(`SELECT amount, method, updated_at FROM requests WHERE status='approved' AND updated_at > now() - interval '1 day' ORDER BY id DESC LIMIT 5`).then(r=>r.rows);
  const merged = [];
  recentApproved.forEach(r=> merged.push({ kind:'withdraw', text: `تمت الموافقة على سحب بقيمة $${Number(r.amount).toFixed(2)}` }));
  recentOps.forEach(o=>{
    if(o.type==='pnl') merged.push({ kind:'pnl', text:`تم إغلاق صفقة: ${Number(o.amount)>=0?'+':'-'}$${Math.abs(Number(o.amount)).toFixed(2)}`});
    if(o.type==='admin' && Number(o.amount)>0) merged.push({ kind:'deposit', text:`تم إضافة رصيد $${Number(o.amount).toFixed(2)}`});
  });
  if(merged.length===0){
    // aggregates fallback
    const agg = await q(`SELECT COUNT(*) AS users FROM users`).then(r=>r.rows[0]);
    merged.push({ kind:'info', text:`انضم ${agg.users} عضو إلى النظام` });
    merged.push({ kind:'info', text:`طلبات السحب تعمل بشكل طبيعي` });
  }
  res.json({ok:true, items: merged.slice(0,5)});
});

// --- WhatsApp deposit endpoint (returns the URL for frontend)
app.get('/api/deposit/whatsapp', auth, (req,res)=>{
  res.json({ok:true, url: WHATSAPP_URL});
});

// Fallback to SPA
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname,'../frontend/index.html'));
});

app.listen(PORT, ()=>{
  console.log('Server running on port '+PORT);
});
