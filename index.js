require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = (url,...args)=> import('node-fetch').then(({default: f})=> f(url,...args));
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ql_admin_2025';
const DATABASE_URL = process.env.DATABASE_URL;
if(!DATABASE_URL){ console.error('DATABASE_URL missing'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });
async function q(query, params){ const c = await pool.connect(); try{ const r = await c.query(query, params); return r; } finally { c.release(); } }

// --- Admin migrate
app.post('/api/admin/migrate', async (req,res)=>{
  try{
    if(req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });
    const sql = require('fs').readFileSync(path.join(__dirname,'db.sql'),'utf-8');
    await q(sql);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// --- Auth: activate key
app.post('/api/auth/activateKey', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']);
    const { key } = req.body;
    if(!tgId) return res.json({ ok:false, error:'no tg id' });
    const k = await q(`SELECT * FROM keys WHERE key_code=$1`, [key]).then(r=>r.rows[0]);
    if(!k) return res.json({ ok:false, error:'invalid key' });
    if(k.used_at) return res.json({ ok:false, error:'used key' });
    const u = await q(`INSERT INTO users (tg_id) VALUES ($1) ON CONFLICT (tg_id) DO UPDATE SET tg_id=EXCLUDED.tg_id RETURNING *`, [tgId]).then(r=>r.rows[0]);
    await q(`UPDATE keys SET used_by=$1, used_at=now() WHERE id=$2`, [u.id, k.id]);
    // sub 30 days default
    await q(`UPDATE users SET sub_until = now() + ($1 || ' days')::interval WHERE id=$2`, [k.days||30, u.id]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// --- User info
app.get('/api/user/me', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']);
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tgId]).then(r=>r.rows[0]);
    if(!u) return res.json({ ok:true, user:{ balance:0 }, ops:[], requests:[], trades:[] });
    const ops = await q(`SELECT * FROM ops WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [u.id]).then(r=>r.rows);
    const reqs = await q(`SELECT * FROM requests WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [u.id]).then(r=>r.rows);
    const trs = await q(`SELECT id,symbol,status,pnl,stop_loss,take_profit FROM trades WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [u.id]).then(r=>r.rows);
    res.json({ ok:true, user:u, ops, requests:reqs, trades:trs });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/user/lang', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']); const { lang }= req.body;
    if(!tgId) return res.json({ ok:false });
    await q(`UPDATE users SET lang=$1 WHERE tg_id=$2`, [lang, tgId]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// --- Withdraw
app.post('/api/withdraw/request', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']); const { method, address, amount } = req.body;
    const u = await q(`SELECT id FROM users WHERE tg_id=$1`, [tgId]).then(r=>r.rows[0]);
    if(!u) return res.json({ ok:false });
    await q(`INSERT INTO requests (user_id,method,address,amount,status) VALUES ($1,$2,$3,($4)::numeric,'pending')`, [u.id, method, address, amount]);
    await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'withdraw',($2)::numeric,'Withdrawal requested')`, [u.id, -Math.abs(amount)]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/withdraw/cancel/:id', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']); const id = Number(req.params.id);
    const u = await q(`SELECT id FROM users WHERE tg_id=$1`, [tgId]).then(r=>r.rows[0]);
    if(!u) return res.json({ ok:false });
    const r = await q(`SELECT * FROM requests WHERE id=$1 AND user_id=$2`, [id, u.id]).then(r=>r.rows[0]);
    if(!r || r.status!=='pending') return res.json({ ok:false });
    await q(`UPDATE requests SET status='cancelled', updated_at=now() WHERE id=$1`, [id]);
    await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'info',0,'Withdraw cancelled')`, [u.id]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// --- Trades APIs for UI
app.get('/api/trades/me', async (req,res)=>{
  try{
    const tgId = Number(req.headers['x-ql-tg']);
    const u = await q(`SELECT id FROM users WHERE tg_id=$1`, [tgId]).then(r=>r.rows[0]);
    if(!u) return res.json({ rows: [] });
    const rows = await q(`SELECT id,symbol,status,pnl,stop_loss,take_profit FROM trades WHERE user_id=$1 ORDER BY id DESC`, [u.id]).then(r=>r.rows);
    res.json({ rows });
  }catch(e){ res.status(500).json({ rows: [] }); }
});

app.post('/api/trades/close/:id', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const tr = await q(`SELECT * FROM trades WHERE id=$1`, [id]).then(r=>r.rows[0]);
    if(!tr || tr.status!=='open') return res.json({ ok:false });
    await q(`UPDATE trades SET status='closed', closed_at=now() WHERE id=$1`, [id]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

app.post('/api/trades/updateSLTP', async (req,res)=>{
  try{
    const { id, stop_loss, take_profit } = req.body;
    await q(`UPDATE trades SET stop_loss=$1, take_profit=$2 WHERE id=$3`, [stop_loss, take_profit, id]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// --- Metals proxy
let metalsCache = { xau:null, xag:null, t:0 };
app.get('/api/metals', async (req,res)=>{
  try{
    const now = Date.now();
    if(!metalsCache.xau || now - metalsCache.t > 15_000){
      const xau = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?range=1d&interval=1m').then(r=>r.json());
      const xag = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/XAGUSD=X?range=1d&interval=1m').then(r=>r.json());
      const pXAU = xau?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
      const pXAG = xag?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
      metalsCache = { xau:pXAU, xag:pXAG, t:now };
    }
    res.json({ ok:true, XAUUSD: metalsCache.xau, XAGUSD: metalsCache.xag });
  }catch(e){ res.json({ ok:false }); }
});

// --- Engine: daily targets & SL/TP enforcement
setInterval(async ()=>{
  try{
    // Move balance gradually
    const act = await q(`SELECT dt.*, u.id AS uid, u.tg_id
                         FROM daily_targets dt
                         JOIN users u ON u.id=dt.user_id
                         WHERE dt.active=true`);
    for(const row of (act.rows||[])){
      const perTick = (Number(row.target) / (Number(row.duration_sec)||1800)) * 3; // per 3s
      await q(`UPDATE users SET balance = (balance + ($1)::numeric) WHERE id=$2`, [perTick, row.uid]);
      await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'pnl',($2)::numeric,'daily step')`, [row.uid, perTick]);
      await q(`UPDATE daily_targets SET duration_sec = GREATEST(duration_sec - 3,0) WHERE id=$1`, [row.id]);
      const left = await q(`SELECT duration_sec FROM daily_targets WHERE id=$1`, [row.id]).then(r=>r.rows[0]?.duration_sec||0);
      if(left<=0){
        await q(`UPDATE daily_targets SET active=false WHERE id=$1`, [row.id]);
        const tr = await q(`SELECT id FROM trades WHERE user_id=$1 AND status='open'`, [row.uid]).then(r=>r.rows[0]);
        if(tr){
          await q(`UPDATE trades SET status='closed', closed_at=now(), pnl=$1 WHERE id=$2`, [row.target, tr.id]);
        }
      }
    }

    // Enforce SL/TP on open trades (use last ops sum as pnl approximation)
    const open = await q(`SELECT t.*, u.id AS uid FROM trades t JOIN users u ON u.id=t.user_id WHERE t.status='open'`);
    for(const t of (open.rows||[])){
      // Approximate user's last PnL for this period (optional improvement: track pnl per trade)
      // Here we check if reached SL/TP purely by pnl field if set during /close_trade by admin or daily_targets end.
      if(t.stop_loss != null && Number(t.pnl) <= Number(t.stop_loss)){
        await q(`UPDATE trades SET status='closed', closed_at=now() WHERE id=$1`, [t.id]);
      }
      if(t.take_profit != null && Number(t.pnl) >= Number(t.take_profit)){
        await q(`UPDATE trades SET status='closed', closed_at=now() WHERE id=$1`, [t.id]);
      }
    }
  }catch(e){ /*silent*/ }
}, 3000);

// Static files from project root
app.use(express.static(path.join(__dirname)));

// SPA fallback
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

// Load bot within same service
require('./bot.js');

app.listen(PORT, ()=> console.log('Server running on port '+PORT));
