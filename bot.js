// QL Trading AI v2.2 — Server/API
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
  JWT_SECRET = "ql_secret_2025"
} = process.env;

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

// ✅ توحيد اتصال قاعدة البيانات عبر SSL
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // يخدم index.html والملفات الثابتة

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
    return res.json({ ok: true, msg: "migrated" });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

// ==================== AUTH ====================
app.post("/api/token", (req, res) => {
  const { tg_id } = req.body || {};
  if (!tg_id) return res.json({ ok: false, error: "missing tg_id" });
  const token = jwt.sign({ tg_id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ ok: true, token });
});

// ==================== ACTIVATE (إصلاح كامل) ====================
app.post("/api/activate", async (req, res) => {
  console.log("🔑 Activation request:", req?.body?.key, req?.body?.tg_id);
  console.log("📦 DB Connection:", (process.env.DATABASE_URL || "").split("@").pop());

  try {
    const { key, tg_id, name = "", email = "" } = req.body || {};
    if (!key || !tg_id)
      return res.json({ ok: false, error: "missing_parameters" });

    // تجاهل حالة الأحرف
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
    console.log(`✅ User activated: ${u.name} (${tg_id})`);
    res.json({ ok: true, user: u });
  } catch (e) {
    console.error("❌ Activation error:", e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ==================== باقي API (سحب / عمليات / أسواق / Static) ====================
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==================== Telegram Webhook ====================
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

(async () => {
  try {
    if (WEBHOOK_URL && bot && process.env.BOT_TOKEN) {
      const hookUrl = `${WEBHOOK_URL}/webhook/${process.env.BOT_TOKEN}`;
      console.log("✅ Setting Telegram webhook to", hookUrl);
      await bot.setWebHook(hookUrl);
    } else {
      console.log("⚠️ WEBHOOK_URL not set — bot will not set webhook here.");
    }
  } catch (e) {
    console.error("❌ Webhook setup failed:", e.message);
  }
})();

app.post("/webhook/:token", async (req, res) => {
  try {
    const token = req.params.token;
    if (token !== process.env.BOT_TOKEN) return res.sendStatus(403);
    console.log("📩 Webhook request received from Telegram");
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🟢 QL Trading AI server running on port ${PORT}`);
});
