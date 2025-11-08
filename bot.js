// QL Trading AI v2.1 FINAL — Telegram Bot
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();

const { BOT_TOKEN, ADMIN_ID, DATABASE_URL } = process.env;
if (!BOT_TOKEN) { console.error("BOT_TOKEN missing"); process.exit(1); }
if (!DATABASE_URL) { console.error("DATABASE_URL missing"); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false
});

async function q(sql, params = []) {
  const c = await pool.connect();
  try { return await c.query(sql, params); } finally { c.release(); }
}
const isAdmin = (msg) => Number(msg?.from?.id) === Number(ADMIN_ID);

// رسالة ترحيب خارج الويب
bot.onText(/^\/start$/, (msg) => {
  const t = `👋 Welcome to QL Trading AI
🤖 The smart trading bot that works automatically for you.
💰 Just deposit funds and watch profits added to your wallet.
📊 Track balance, trades, and withdrawals inside your wallet.
🕒 24/7 support via WhatsApp or Telegram.

👋 أهلاً بك في QL Trading AI
🤖 البوت الذكي الذي يعمل تلقائياً لإدارة تداولاتك.
💰 كل ما عليك هو الإيداع وانتظر الأرباح تُضاف تلقائياً.
📊 تابع رصيدك، صفقاتك، وطلبات السحب من داخل المحفظة.
🕒 دعم 24/7 عبر واتساب أو تيليجرام.`;
  bot.sendMessage(msg.chat.id, t);
});

// ===== أوامر الأدمن =====
bot.onText(/^\/help$/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, `
🛠 Admin Commands
/create_key <KEY> <DAYS>
/addbalance <tg_id> <amount>
/open_trade <tg_id> <symbol>
/close_trade <trade_id> <pnl>
/setdaily <tg_id> <amount>
/approve_withdraw <id>
/reject_withdraw <id> <reason>
/broadcast all <message>
/notify <tg_id> <message>
  `.trim());
});

// إنشاء مفتاح
bot.onText(/^\/create_key\s+(\S+)(?:\s+(\d+))?$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const key = m[1]; const days = Number(m[2] || 30);
  try {
    await q(`INSERT INTO keys (key_code, days) VALUES ($1,$2)`, [key, days]);
    bot.sendMessage(msg.chat.id, `✅ Key created: ${key} (${days}d)`);
  } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

// إيداع/خصم رصيد
bot.onText(/^\/addbalance\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tg = Number(m[1]); const amount = Number(m[2]);
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r => r.rows[0]);
  if (!u) return bot.sendMessage(msg.chat.id, "User not found");
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [amount, u.id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'admin',$2,'manual admin op')`, [u.id, amount]);
  bot.sendMessage(msg.chat.id, `✅ Balance updated for tg:${tg} by ${amount}`);
  // إشعار للمستخدم بدون ذكر أدمن
  bot.sendMessage(tg, `💳 تم الإيداع في حسابك: ${amount>0?'+':'-'}$${Math.abs(amount).toFixed(2)}`).catch(()=>{});
});

// فتح صفقة
bot.onText(/^\/open_trade\s+(\d+)\s+(\S+)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tg = Number(m[1]); const symbol = m[2].toUpperCase();
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r => r.rows[0]);
  if (!u) return bot.sendMessage(msg.chat.id, "User not found");
  const tr = await q(`INSERT INTO trades (user_id, symbol, status) VALUES ($1,$2,'open') RETURNING *`, [u.id, symbol]).then(r => r.rows[0]);
  bot.sendMessage(msg.chat.id, `✅ Opened trade #${tr.id} on ${symbol} for ${tg}`);
  bot.sendMessage(tg, `📈 تم فتح صفقة على ${symbol} لحسابك.`).catch(()=>{});
});

// إغلاق صفقة
bot.onText(/^\/close_trade\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tradeId = Number(m[1]); const pnl = Number(m[2]);
  const tr = await q(`SELECT * FROM trades WHERE id=$1`, [tradeId]).then(r => r.rows[0]);
  if (!tr || tr.status !== "open") return bot.sendMessage(msg.chat.id, "No open trade");
  await q(`UPDATE trades SET status='closed', closed_at=NOW(), pnl=$1 WHERE id=$2`, [pnl, tradeId]);
  if (pnl >= 0) await q(`UPDATE users SET balance = balance + $1, wins = wins + $1 WHERE id=$2`, [pnl, tr.user_id]);
  else await q(`UPDATE users SET losses = losses + $1 WHERE id=$2`, [Math.abs(pnl), tr.user_id]);
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'pnl',$2,'close trade')`, [tr.user_id, pnl]);
  const tg = await q(`SELECT tg_id FROM users WHERE id=$1`, [tr.user_id]).then(r => r.rows[0]?.tg_id);
  bot.sendMessage(msg.chat.id, `✅ Closed trade #${tradeId} PnL ${pnl}`);
  if (tg) bot.sendMessage(Number(tg), `✅ تم إغلاق الصفقة. النتيجة: ${pnl>=0?'+':'-'}$${Math.abs(pnl).toFixed(2)}`).catch(()=>{});
});

// setdaily (تحريك تدريجي للرصيد حتى الهدف)
bot.onText(/^\/setdaily\s+(\d+)\s+(-?\d+(?:\.\d+)?)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tg = Number(m[1]); const target = Number(m[2]);
  const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg]).then(r => r.rows[0]);
  if (!u) return bot.sendMessage(msg.chat.id, "User not found");
  await q(`INSERT INTO daily_targets (user_id, target, active) VALUES ($1,$2,TRUE)`, [u.id, target]);
  bot.sendMessage(msg.chat.id, `🚀 setdaily started for tg:${tg} target ${target}`);
  bot.sendMessage(tg, `🚀 تم بدء صفقة يومية (الهدف ${target>=0?'+':'-'}$${Math.abs(target)}).`);
  // التحريك التدريجي (سيرفر فقط — الويب يعرض الحركة)
  // هنا فقط تسجّل الهدف؛ الويب سيقوم بالـ animation حسب الهدف.
});

// السحب: approve / reject
bot.onText(/^\/approve_withdraw\s+(\d+)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const id = Number(m[1]);
  const r0 = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r => r.rows[0]);
  if (!r0) return bot.sendMessage(msg.chat.id, "Request not found");
  if (r0.status !== "pending") return bot.sendMessage(msg.chat.id, "Not pending");
  await q(`UPDATE requests SET status='approved', updated_at=NOW() WHERE id=$1`, [id]);
  const tg = await q(`SELECT tg_id FROM users WHERE id=$1`, [r0.user_id]).then(r => r.rows[0]?.tg_id);
  bot.sendMessage(msg.chat.id, `✅ Withdraw #${id} approved`);
  if (tg) bot.sendMessage(Number(tg), `💸 تمت الموافقة على طلب السحب #${id} بقيمة $${Number(r0.amount).toFixed(2)}.`).catch(()=>{});
});

bot.onText(/^\/reject_withdraw\s+(\d+)\s+(.+)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const id = Number(m[1]); const reason = m[2];
  const r0 = await q(`SELECT * FROM requests WHERE id=$1`, [id]).then(r => r.rows[0]);
  if (!r0) return bot.sendMessage(msg.chat.id, "Request not found");
  if (r0.status !== "pending") return bot.sendMessage(msg.chat.id, "Not pending");
  await q(`UPDATE requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
  // نرجع الرصيد
  await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [r0.amount, r0.user_id]);
  const tg = await q(`SELECT tg_id FROM users WHERE id=$1`, [r0.user_id]).then(r => r.rows[0]?.tg_id);
  bot.sendMessage(msg.chat.id, `✅ Withdraw #${id} rejected`);
  if (tg) bot.sendMessage(Number(tg), `❌ تم رفض طلب السحب #${id}. السبب: ${reason}`).catch(()=>{});
});

// broadcast / notify
bot.onText(/^\/broadcast\s+all\s+([\s\S]+)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const text = m[1].trim();
  const list = await q(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL`);
  let ok = 0;
  for (const row of list.rows) {
    try { await bot.sendMessage(Number(row.tg_id), text); ok++; } catch {}
  }
  bot.sendMessage(msg.chat.id, `🚀 Broadcast sent to ${ok} users.`);
});

bot.onText(/^\/notify\s+(\d+)\s+([\s\S]+)$/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tg = Number(m[1]); const text = m[2];
  try { await bot.sendMessage(tg, text); bot.sendMessage(msg.chat.id, "✅ Sent."); }
  catch (e) { bot.sendMessage(msg.chat.id, "❌ " + e.message); }
});

console.log("Bot running (polling)");
