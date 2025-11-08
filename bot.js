// QL Trading AI v2.3 — Server/API (FINAL)
import express from "express";
import path from "path";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import pkg from "pg";
import bot from "./bot.js";
const { Pool } = pkg;

dotenv.config();
const startedAt = new Date().toISOString();
console.log("🟢 Starting QL Trading AI Server...", startedAt);
console.log("📦 DATABASE_URL =", process.env.DATABASE_URL ? "loaded" : "❌ missing");
console.log("🤖 BOT_TOKEN =", process.env.BOT_TOKEN ? "loaded" : "❌ missing");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  DATABASE_URL,
  PORT = 10000,
  ADMIN_TOKEN = "ql_admin_2025",
  JWT_SECRET = "ql_secret_2025",
  WEBHOOK_URL
} = process.env;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

// ✅ PostgreSQL اتصال موحّد عبر SSL
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// دالة مختصرة للـQuery
async function q(sql, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}

// ==================== MIGRATIONS ====================
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
  type TEXT,
  amount NUMERIC(18,2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT,
  status TEXT DEFAULT 'open',
  pnl NUMERIC(18,2) DEFAULT 0,
  sl NUMERIC(18,2),
  tp NUMERIC(18,2),
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT,
  addr TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_targets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  target NUMERIC(18,2) NOT NULL,
  symbol TEXT DEFAULT 'XAUUSD',
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

app.post("/api/admin/migrate", async (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, error: "forbidden" });
  try {
    await q(DDL);
    res.json({ ok: true, msg: "migrated" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ==================== AUTH ====================
app.post("/api/token", (req, res) => {
  const { tg_id } = req.body || {};
  if (!tg_id) return res.json({ ok: false, error: "missing_tg_id" });
  const token = jwt.sign({ tg_id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ ok: true, token });
});

// ==================== ACTIVATE ====================
app.post("/api/activate", async (req, res) => {
  console.log("🔑 Activation request:", req?.body?.key, req?.body?.tg_id);
  try {
    const { key, tg_id, name = "", email = "" } = req.body || {};
    if (!key || !tg_id) return res.json({ ok: false, error: "missing_parameters" });

    const k = await q(`SELECT * FROM keys WHERE LOWER(key_code)=LOWER($1)`, [key]).then(r => r.rows[0]);
    if (!k) return res.json({ ok: false, error: "invalid_key" });

    const u = await q(
      `INSERT INTO users (tg_id, name, email, sub_expires, level)
       VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval, 'Bronze')
       ON CONFLICT (tg_id) DO UPDATE
       SET sub_expires = NOW() + ($4 || ' days')::interval
       RETURNING *`,
      [tg_id, name, email, k.days]
    ).then(r => r.rows[0]);

    await q(`DELETE FROM keys WHERE key_code=$1`, [k.key_code]);
    console.log(`✅ User activated: ${u.name || "unknown"} (${tg_id})`);
    res.json({ ok: true, user: u });
  } catch (e) {
    console.error("❌ Activation error:", e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ==================== USER INFO ====================
app.get("/api/user/:tg", async (req, res) => {
  try {
    const u = await q(`SELECT * FROM users WHERE tg_id=$1`, [req.params.tg]).then(r => r.rows[0]);
    if (!u) return res.json({ ok: false });
    res.json({ ok: true, user: u });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ==================== MARKETS ====================
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

// ==================== STATIC FRONTEND ====================
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==================== TELEGRAM WEBHOOK ====================
(async () => {
  try {
    if (WEBHOOK_URL && process.env.BOT_TOKEN) {
      const hookUrl = `${WEBHOOK_URL}/webhook/${process.env.BOT_TOKEN}`;
      await bot.setWebHook(hookUrl);
      console.log("✅ Telegram webhook set to:", hookUrl);
    } else {
      console.log("⚠️ WEBHOOK_URL not set — running in local mode.");
    }
  } catch (e) {
    console.error("❌ Webhook setup failed:", e.message);
  }
})();

// استقبال التحديثات من Telegram
app.post("/webhook/:token", async (req, res) => {
  try {
    const token = req.params.token;
    if (token !== process.env.BOT_TOKEN) return res.sendStatus(403);
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    res.sendStatus(500);
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🟢 QL Trading AI Server running on port ${PORT}`);
});
