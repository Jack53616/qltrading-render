const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID||0);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin';
const DATABASE_URL = process.env.DATABASE_URL;

if(!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }
if(!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({ connectionString: DATABASE_URL });

async function q(query, params){ const c = await pool.connect(); try{ const r = await c.query(query, params); return r; } finally { c.release(); } }

bot.onText(/^\/start$/, async (msg)=>{
  bot.sendMessage(msg.chat.id, 'Welcome to QL Trading AI — use the Mini App button to open your wallet.');
});

// Admin guard
function isAdmin(msg){ return msg?.from?.id === ADMIN_ID; }

bot.onText(/^\/create_key\s+(\S+)(?:\s+(\d+))?$/,(msg,match)=>{
  if(!isAdmin(msg)) return;
  const key = match[1]; const days = Number(match[2]||30);
  q(`INSERT INTO keys (key_code, days) VALUES ($1,$2)`, [key, days])
    .then(()=> bot.sendMessage(ADMIN_ID, `✅ Key created: ${key} (${days}d)`))
    .catch(e=> bot.sendMessage(ADMIN_ID, `❌ create_key error: ${e.message}`));
});

bot.onText(/^\/addbalance\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg, m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const amount = Number(m[2]);
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r=>r.rows[0]);
  if(!u) return bot.sendMessage(ADMIN_ID, 'User not found');
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [amount, u.id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'admin',$2,$3)`, [u.id, amount, 'bot addbalance']);
  bot.sendMessage(ADMIN_ID, `✅ Balance updated for tg:${tg} by ${amount}`);
  // optionally notify user
  bot.sendMessage(tg, `💳 تم تحديث رصيدك: ${amount>0?'+':'-'}$${Math.abs(amount).toFixed(2)}`)
    .catch(()=>{});
});

bot.onText(/^\/open_trade\s+(\d+)\s+(\S+)$/, async (msg,m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const symbol = m[2].toUpperCase();
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r=>r.rows[0]);
  if(!u) return bot.sendMessage(ADMIN_ID, 'User not found');
  const tr = await q(`INSERT INTO trades (user_id, symbol, status) VALUES ($1,$2,'open') RETURNING *`, [u.id, symbol]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Opened trade #${tr.id} on ${symbol} for @${u.name}`);
  bot.sendMessage(tg, `📈 تم فتح صفقة على ${symbol} لحسابك.`).catch(()=>{});
});

bot.onText(/^\/close_trade\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg,m)=>{
  if(!isAdmin(msg)) return;
  const tradeId = Number(m[1]); const pnl = Number(m[2]);
  const tr = await q(`SELECT * FROM trades WHERE id=$1`, [tradeId]).then(r=>r.rows[0]);
  if(!tr || tr.status!=='open') return bot.sendMessage(ADMIN_ID, 'No open trade');
  await q(`UPDATE trades SET status='closed', closed_at=now(), pnl=$1 WHERE id=$2`, [pnl, tradeId]);
  if(pnl>=0) await q(`UPDATE users SET balance = balance + $1, wins = wins + $1 WHERE id=$2`, [pnl, tr.user_id]);
  else await q(`UPDATE users SET losses = losses + $1 WHERE id=$2`, [Math.abs(pnl), tr.user_id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'pnl',$2,$3)`, [tr.user_id, pnl, 'bot close_trade']);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [tr.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Closed trade #${tradeId} PnL ${pnl}`);
  bot.sendMessage(u.tg_id, `✅ تم إغلاق الصفقة. النتيجة: ${pnl>=0?'+':'-'}$${Math.abs(pnl).toFixed(2)}`).catch(()=>{});
});

bot.onText(/^\/approve_withdraw\s+(\d+)$/, async (msg,m)=>{
  if(!isAdmin(msg)) return;
  const id = Number(m[1]);
  const r = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r=>r.rows[0]);
  if(!r) return bot.sendMessage(ADMIN_ID, 'Request not found');
  if(r.status!=='pending') return bot.sendMessage(ADMIN_ID, 'Not pending');
  await q(`UPDATE requests SET status='approved', updated_at=now() WHERE id=$1`, [id]);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [r.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Withdraw #${id} approved`);
  bot.sendMessage(u.tg_id, `💸 تمت الموافقة على طلب السحب #${id} بقيمة $${Number(r.amount).toFixed(2)}.`).catch(()=>{});
});

bot.onText(/^\/reject_withdraw\s+(\d+)\s+(.+)$/, async (msg,m)=>{
  if(!isAdmin(msg)) return;
  const id = Number(m[1]); const reason = m[2];
  const r = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r=>r.rows[0]);
  if(!r) return bot.sendMessage(ADMIN_ID, 'Request not found');
  if(r.status!=='pending') return bot.sendMessage(ADMIN_ID, 'Not pending');
  await q(`UPDATE requests SET status='rejected', updated_at=now() WHERE id=$1`, [id]);
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [r.amount, r.user_id]);
  const u = await q(`SELECT tg_id FROM users WHERE id=$1`, [r.user_id]).then(r=>r.rows[0]);
  bot.sendMessage(ADMIN_ID, `✅ Withdraw #${id} rejected`);
  bot.sendMessage(u.tg_id, `❌ تم رفض طلب السحب #${id}. السبب: ${reason}`).catch(()=>{});
});

// Broadcast / notify
bot.onText(/^\/broadcast\s+all\s+([\s\S]+)$/,(msg,m)=>{
  if(!isAdmin(msg)) return;
  const text = m[1].trim();
  q(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL`).then(r=>{
    r.rows.forEach(u=> bot.sendMessage(u.tg_id, text).catch(()=>{}));
    bot.sendMessage(ADMIN_ID, `🚀 Broadcast sent to ${r.rows.length} users.`);
  });
});

bot.onText(/^\/notify\s+(\d+)\s+([\s\S]+)$/,(msg,m)=>{
  if(!isAdmin(msg)) return;
  const tg = Number(m[1]); const text = m[2].trim();
  bot.sendMessage(tg, text).then(()=> bot.sendMessage(ADMIN_ID,'✅ Sent.')).catch(e=> bot.sendMessage(ADMIN_ID, '❌ '+e.message));
});

console.log('Bot running (polling)');
