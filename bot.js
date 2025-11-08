const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID||0);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ql_admin_2025';
const DATABASE_URL = process.env.DATABASE_URL;

if(!BOT_TOKEN || !DATABASE_URL){
  console.log('Bot disabled (missing env)'); 
  module.exports = {};
  return;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({ connectionString: DATABASE_URL });
async function q(query, params){ const c = await pool.connect(); try{ const r = await c.query(query, params); return r; } finally { c.release(); } }
function isAdmin(msg){ return msg?.from?.id === ADMIN_ID; }

bot.onText(/^\/start$/, async (msg)=>{
  bot.sendMessage(msg.chat.id, '👋 أهلاً بك في QL Trading AI\n🤖 البوت يعمل تلقائياً — قم بالإيداع وتابع الأرباح داخل المحفظة.\n\nWelcome to QL Trading AI — deposit and track profits in your wallet.');
});

// Create key
bot.onText(/^\/create_key\s+(\S+)\s*(\d+)?$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const key = m[1]; const days = Number(m[2]||30);
  try{
    await q(`INSERT INTO keys (key_code, days) VALUES ($1,$2)`, [key, days]);
    bot.sendMessage(ADMIN_ID, `✅ Key created: ${key} (${days}d)`);
  }catch(e){ bot.sendMessage(ADMIN_ID, '❌ '+e.message); }
});

// Add balance (silent note)
bot.onText(/^\/addbalance\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const amount = Number(m[2]);
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r=>r.rows[0]);
  if(!u) return bot.sendMessage(ADMIN_ID, 'User not found');
  await q(`UPDATE users SET balance = balance + ($1)::numeric WHERE id=$2`, [amount, u.id]);
  await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'deposit',($2)::numeric,'Deposit confirmed')`, [u.id, amount]);
  bot.sendMessage(ADMIN_ID, `✅ Balance updated for tg:${tg} by ${amount}`);
  bot.sendMessage(tg, `💰 تم إيداع مبلغ $${Math.abs(amount).toFixed(2)} في حسابك.`).catch(()=>{});
});

// Open trade
bot.onText(/^\/open_trade\s+(\d+)\s+(\S+)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const symbol = m[2].toUpperCase();
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r=>r.rows[0]);
  if(!u) return bot.sendMessage(ADMIN_ID, 'User not found');
  const tr = await q(`INSERT INTO trades (user_id,symbol,status) VALUES ($1,$2,'open') RETURNING *`, [u.id, symbol]).then(r=>r.rows[0]);
  await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'open',0,'Trade opened ${symbol}')`, [u.id]);
  bot.sendMessage(ADMIN_ID, `✅ Opened trade #${tr.id} on ${symbol} for tg:${tg}`);
  bot.sendMessage(tg, `📈 تم فتح صفقة على ${symbol} لحسابك.`).catch(()=>{});
});

// Close trade
bot.onText(/^\/close_trade\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg,m)=>{
  if(!isAdmin(msg)) return;
  const tradeId = Number(m[1]); const pnl = Number(m[2]);
  const tr = await q(`SELECT * FROM trades WHERE id=$1`, [tradeId]).then(r=>r.rows[0]);
  if(!tr || tr.status!=='open') return bot.sendMessage(ADMIN_ID, 'No open trade');
  await q(`UPDATE trades SET status='closed', closed_at=now(), pnl=$1 WHERE id=$2`, [pnl, tradeId]);
  await q(`INSERT INTO ops (user_id,type,amount,note) VALUES ($1,'close',($2)::numeric,'Trade closed')`, [tr.user_id, pnl]);
  if(pnl>=0) await q(`UPDATE users SET balance = balance + ($1)::numeric, wins = wins + ($1)::numeric WHERE id=$2`, [pnl, tr.user_id]);
  else await q(`UPDATE users SET losses = losses + ($1)::numeric WHERE id=$2`, [Math.abs(pnl), tr.user_id]);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [tr.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Closed trade #${tradeId} PnL ${pnl}`);
  bot.sendMessage(u.tg_id, `✅ تم إغلاق الصفقة. النتيجة: ${pnl>=0?'+':'-'}$${Math.abs(pnl).toFixed(2)}`).catch(()=>{});
});

// Daily target
bot.onText(/^\/setdaily\s+(\d+)\s+(-?\d+(?:\.\d+)?)\s*(\d+)?\s*(\S+)?$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]);
  const target = Number(m[2]);
  const durSec = m[3] ? Number(m[3]) : 1800;
  const symbol = (m[4]||'XAUUSD').toUpperCase();
  const u = await q(`SELECT id,tg_id FROM users WHERE tg_id=$1`, [tg]).then(r=>r.rows[0]);
  if(!u) return bot.sendMessage(ADMIN_ID, 'User not found');
  const open = await q(`SELECT id FROM trades WHERE user_id=$1 AND status='open'`, [u.id]).then(r=>r.rows[0]);
  if(!open){
    await q(`INSERT INTO trades (user_id,symbol,status) VALUES ($1,$2,'open')`, [u.id, symbol]);
  }
  await q(`INSERT INTO daily_targets (user_id,symbol,target,duration_sec,active) VALUES ($1,$2,$3,$4,true)`, [u.id, symbol, target, durSec]);
  bot.sendMessage(ADMIN_ID, `✅ setdaily → tg:${tg} target:${target} in ${durSec}s on ${symbol}`);
  bot.sendMessage(tg, `📈 تم فتح صفقة يومية على ${symbol}. الهدف ${target>0?'+':''}${target}$`).catch(()=>{});
});

// Approve / reject withdraw
bot.onText(/^\/approve_withdraw\s+(\d+)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const id = Number(m[1]);
  const r = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r=>r.rows[0]);
  if(!r || r.status!=='pending') return bot.sendMessage(ADMIN_ID, 'Not pending');
  await q(`UPDATE requests SET status='approved', updated_at=now() WHERE id=$1`, [id]);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [r.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Withdraw #${id} approved`);
  bot.sendMessage(u.tg_id, `💸 تمت الموافقة على طلب السحب #${id} بقيمة $${Number(r.amount).toFixed(2)}.`).catch(()=>{});
});

bot.onText(/^\/reject_withdraw\s+(\d+)\s+([\s\S]+)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const id = Number(m[1]); const reason = m[2];
  const r = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r=>r.rows[0]);
  if(!r || r.status!=='pending') return bot.sendMessage(ADMIN_ID, 'Not pending');
  await q(`UPDATE requests SET status='rejected', updated_at=now() WHERE id=$1`, [id]);
  await q(`UPDATE users SET balance = balance + ($1)::numeric WHERE id=$2`, [r.amount, r.user_id]);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [r.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Withdraw #${id} rejected`);
  bot.sendMessage(u.tg_id, `❌ تم رفض طلب السحب #${id}. السبب: ${reason}`).catch(()=>{});
});

// Broadcasts
bot.onText(/^\/broadcast\s+all\s+([\s\S]+)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const text = m[1].trim();
  const r = await q(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL`);
  let c=0;
  for(const row of r.rows){
    try{ await bot.sendMessage(row.tg_id, text); c++; }catch(_){}
  }
  bot.sendMessage(ADMIN_ID, `🚀 Broadcast sent to ${c} users.`);
});

bot.onText(/^\/notify\s+(\d+)\s+([\s\S]+)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const text = m[2].trim();
  bot.sendMessage(tg, text).then(()=> bot.sendMessage(ADMIN_ID,'✅ Sent.')).catch(e=> bot.sendMessage(ADMIN_ID,'❌ '+e.message));
});

console.log('Bot running (polling)');
