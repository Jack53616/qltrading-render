// QL Trading AI v2.1 FINAL — Server/API
import express from "express";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  DATABASE_URL,
  PORT = 10000,
  ADMIN_TOKEN = "ql_admin_2025",
  JWT_SECRET = "ql_secret_2025"
} = process.env;

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // يخدم index.html و app.js و style.css والأصول

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : false
});

async function q(sql, params = []) {
  const c = await pool.connect();
  try {
    const r = await c.query(sql, params);
    return r;
  } finally {
    c.release();
  }
}

// ---------- MIGRATIONS ----------
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE,
  name TEXT,
  email TEXT,
  balance NUMERIC(18,2) DEFAULT 0,
  wins NUMERIC(18,2) DEFAULT 0,
  losses NUMERIC(18,2) DEFAULT 0,
  level TEXT DEFAULT 'Bronze',
  sub_expires TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keys (
  id SERIAL PRIMARY KEY,
  key_code TEXT UNIQUE NOT NULL,
  days INT NOT NULL DEFAULT 30,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,            -- admin | pnl | withdraw | deposit | system
  amount NUMERIC(18,2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT,
  status TEXT DEFAULT 'open',  -- open / closed
  pnl NUMERIC(18,2) DEFAULT 0,
  sl NUMERIC(18,2),            -- stop loss
  tp NUMERIC(18,2),            -- take profit
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT,           -- usdt_trc20 | usdt_erc20 | btc | eth
  addr TEXT,             -- العنوان المحفوظ للسحب
  status TEXT DEFAULT 'pending', -- pending/approved/rejected/canceled
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_targets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  target NUMERIC(18,2) NOT NULL,  -- موجب ربح، سالب خسارة
  symbol TEXT DEFAULT 'XAUUSD',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

app.post("/api/admin/migrate", async (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    await q(DDL);
    return res.json({ ok: true, msg: "migrated" });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

// ---------- AUTH (Token بسيط للميني آب) ----------
app.post("/api/token", (req, res) => {
  const { tg_id } = req.body || {};
  if (!tg_id) return res.json({ ok: false, error: "missing tg_id" });
  const token = jwt.sign({ tg_id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ ok: true, token });
});

// ---------- SUBSCRIBE / ACTIVATE ----------
app.post("/api/activate", async (req, res) => {
  try {
    const { key, tg_id, name = "", email = "" } = req.body || {};
    if (!key || !tg_id) return res.json({ ok: false, error: "missing" });
    const k = await q(`SELECT * FROM keys WHERE key_code=$1`, [key]).then(r => r.rows[0]);
    if (!k) return res.json({ ok: false, error: "invalid_key" });

    const u = await q(
      `INSERT INTO users (tg_id, name, email, sub_expires, level)
       VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval, 'Bronze')
       ON CONFLICT (tg_id) DO UPDATE
       SET sub_expires = NOW() + ($4 || ' days')::interval
       RETURNING *`,
      [tg_id, name, email, k.days]
    ).then(r => r.rows[0]);

    await q(`DELETE FROM keys WHERE key_code=$1`, [key]);
    res.json({ ok: true, user: u });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---------- USER ----------
app.get("/api/user/:tg", async (req, res) => {
  try {
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [req.params.tg]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false });
    res.json({ ok: true, user: u });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// حفظ/تحديث عنوان السحب لطريقة معينة
app.post("/api/withdraw/method", async (req, res) => {
  try {
    const { tg_id, method, addr } = req.body || {};
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg_id]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false, error: "User not found" });
    // نحفظها كـ op note بسيطة
    await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'system',0,$2)`, [u.id, `withdraw_addr:${method}:${addr}`]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// طلب سحب
app.post("/api/withdraw", async (req, res) => {
  try {
    const { tg_id, amount, method } = req.body || {};
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg_id]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false, error: "User not found" });
    if (Number(u.balance) < Number(amount)) return res.json({ ok: false, error: "Insufficient balance" });

    await q(`UPDATE users SET balance = balance - $1 WHERE id=$2`, [amount, u.id]);
    const r0 = await q(`INSERT INTO requests (user_id, amount, method, status) VALUES ($1,$2,$3,'pending') RETURNING *`,
      [u.id, amount, method]).then(r => r.rows[0]);
    await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,'withdraw',$2,$3)`,
      [u.id, amount, `withdraw_request:${method}`]);
    res.json({ ok: true, request: r0 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// إلغاء طلب السحب قبل الموافقة
app.post("/api/withdraw/cancel", async (req, res) => {
  try {
    const { tg_id, id } = req.body || {};
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [tg_id]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false, error: "User not found" });
    const r0 = await q(`SELECT * FROM requests WHERE id=$1 AND user_id=$2`, [id, u.id]).then(r => r.rows[0]);
    if (!r0) return res.json({ ok: false, error: "not_found" });
    if (r0.status !== "pending") return res.json({ ok: false, error: "cannot_cancel" });

    await q(`UPDATE requests SET status='canceled', updated_at=NOW() WHERE id=$1`, [id]);
    await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [r0.amount, u.id]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// قائمة الطلبات
app.get("/api/requests/:tg", async (req, res) => {
  try {
    const u = await q(`SELECT id FROM users WHERE tg_id=$1`, [req.params.tg]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false, list: [] });
    const list = await q(`SELECT * FROM requests WHERE user_id=$1 ORDER BY id DESC`, [u.id]).then(r => r.rows);
    res.json({ ok: true, list });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// عمليات المستخدم
app.get("/api/ops/:tg", async (req, res) => {
  try {
    const u = await q(`SELECT id FROM users WHERE tg_id=$1`, [req.params.tg]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false, list: [] });
    const list = await q(`SELECT * FROM ops WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [u.id]).then(r => r.rows);
    res.json({ ok: true, list });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---------- MARKETS ----------
app.get("/api/markets", async (_req, res) => {
  try {
    const pairs = [
      { code: "BTCUSDT", type: "binance" },
      { code: "ETHUSDT", type: "binance" },
      { code: "XAUUSD",  type: "yahoo", y: "XAUUSD=X" },
      { code: "XAGUSD",  type: "yahoo", y: "XAGUSD=X" }
    ];
    const out = {};
    for (const p of pairs) {
      if (p.type === "binance") {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${p.code}`);
        const j = await r.json();
        out[p.code] = Number(j?.price || 0);
      } else {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${p.y}`);
        const j = await r.json();
        const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
        out[p.code] = Number(price);
      }
    }
    res.json({ ok: true, data: out });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---------- STATIC (SPA) ----------
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("QL Trading AI v2.1 — Ready ✅");
  console.log(`Server running on port ${PORT}`);
});
