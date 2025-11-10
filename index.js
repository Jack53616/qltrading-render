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
import { checkTelegramInitData, parseInitData } from "./utils/verifyInitData.js";
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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

async function getUserByTelegramId(tgId) {
  if (!tgId) return null;
  return q(`SELECT * FROM users WHERE tg_id=$1`, [tgId]).then(r => r.rows[0] || null);
}

const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const VALID_KEY_CHARS = /^[A-Za-z0-9._\-+=]+$/;
const KEY_FRAGMENT_RE = /[A-Za-z0-9][A-Za-z0-9._\-+=]{3,}[A-Za-z0-9=]?/g;
const BANNED_KEY_WORDS = new Set([
  "key", "code", "subscription", "subs", "sub", "token", "pass", "password",
  "link", "your", "this", "that", "here", "is", "for", "the", "my",
  "http", "https", "www", "click", "press", "bot", "created", "generated"
]);

function scoreToken(token) {
  const lower = token.toLowerCase();
  const length = token.length;
  const digitCount = (token.match(/\d/g) || []).length;
  const letterCount = (token.match(/[A-Za-z]/g) || []).length;

  let score = 0;
  if (digitCount) score += 6;
  if (/[-_]/.test(token)) score += 2;
  if (/[+=]/.test(token)) score += 1;
  if (digitCount && letterCount) score += 2;
  if (length >= 28) score += 6;
  else if (length >= 20) score += 5;
  else if (length >= 16) score += 4;
  else if (length >= 12) score += 3;
  else if (length >= 8) score += 2;
  else if (length >= 6) score += 1;

  const digitRatio = length ? digitCount / length : 0;
  if (digitRatio >= 0.5) score += 4;
  else if (digitRatio >= 0.35) score += 2;

  const upperCount = (token.match(/[A-Z]/g) || []).length;
  if (upperCount >= 4 && letterCount) score += 1;

  if (length > 32) score -= Math.min(length - 32, 12);
  if (length > 64) score -= Math.min(length - 64, 12);

  if (BANNED_KEY_WORDS.has(lower)) score -= 12;
  if (/^(key|code|token|pass)/.test(lower)) score -= 8;
  if (lower.includes("created") || lower.includes("generated")) score -= 6;
  if (lower.includes("http") || lower.includes("www") || lower.includes("tme")) score -= 15;
  if (lower.includes("telegram")) score -= 8;
  if (lower.includes("start=")) score -= 6;

  return score;
}

function sanitizeToken(candidate = "") {
  if (!candidate) return "";
  let token = candidate
    .replace(INVISIBLE_CHARS, "")
    .trim();
  if (!token) return "";
  token = token.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9=]+$/, "");
  if (!token) return "";
  if (!VALID_KEY_CHARS.test(token)) {
    token = token.replace(/[^A-Za-z0-9._\-+=]+/g, "");
  }
  if (token.length < 4) return "";
  return token;
}

function extractKeyCandidates(raw = "") {
  if (!raw) return [];
  const normalized = raw.normalize("NFKC").replace(INVISIBLE_CHARS, " ").trim();
  if (!normalized) return [];
  const seen = new Map();
  const candidates = [];
  const sanitizedParts = [];

  const register = (token, boost = 0) => {
    const sanitized = sanitizeToken(token);
    if (!sanitized) return;
    const fingerprint = sanitized.toLowerCase();
    if (seen.has(fingerprint)) return;
    const score = scoreToken(sanitized) + boost;
    seen.set(fingerprint, score);
    candidates.push({ token: sanitized, score, idx: candidates.length });
  };

  const pushMatches = (text, boost = 0) => {
    if (!text) return;
    const matches = text.match(KEY_FRAGMENT_RE);
    if (matches) matches.forEach(match => register(match, boost));
  };

  pushMatches(normalized, 1);

  const startMatch = normalized.match(/start=([A-Za-z0-9._\-+=]+)/i);
  if (startMatch) register(startMatch[1], 6);

  normalized
    .split(/[\s|,;:/\\]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const sanitizedPart = sanitizeToken(part);
      if (sanitizedPart) {
        sanitizedParts.push({
          value: sanitizedPart,
          hasDigits: /\d/.test(sanitizedPart),
          hasLetters: /[A-Za-z]/.test(sanitizedPart)
        });
      }
      const eqIndex = part.indexOf("=");
      if (eqIndex >= 0 && eqIndex < part.length - 1) {
        register(part.slice(eqIndex + 1), 5);
      }
      register(part);
      pushMatches(part);
    });

  for (let i = 0; i < sanitizedParts.length - 1; i++) {
    const first = sanitizedParts[i];
    const second = sanitizedParts[i + 1];
    const joined = first.value + second.value;
    if (joined.length >= 6 && (first.hasDigits || second.hasDigits)) {
      register(joined, first.hasDigits && second.hasDigits ? 6 : 5);
    }
  }

  for (let i = 0; i < sanitizedParts.length - 2; i++) {
    const a = sanitizedParts[i];
    const b = sanitizedParts[i + 1];
    const c = sanitizedParts[i + 2];
    const joined = a.value + b.value + c.value;
    if (joined.length >= 8 && (a.hasDigits || b.hasDigits || c.hasDigits)) {
      register(joined, 4);
    }
  }

  const collapsed = sanitizedCollapsed(normalized);
  if (collapsed) {
    const lowerCollapsed = collapsed.toLowerCase();
    const startsWithMeta = /^(key|code|token|pass)/.test(lowerCollapsed);
    register(collapsed, startsWithMeta ? -2 : 1);
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.token.length !== a.token.length) return b.token.length - a.token.length;
    return a.idx - b.idx;
  });

  return candidates.map(c => c.token);
}

function sanitizedCollapsed(text = "") {
  if (!text) return "";
  const collapsed = text.replace(/[^A-Za-z0-9._\-+=]+/g, "");
  return collapsed.length >= 4 ? collapsed : "";
}

function normalizeKey(key = "") {
  const candidates = extractKeyCandidates(key);
  return candidates[0] || "";
}

async function findKeyByCandidates(candidates = []) {
  if (!candidates.length) return null;
  const tried = new Set();

  const fetchKey = async (whereClause, value) => {
    return q(
      `SELECT id, key_code, days, used_by, used_at, created_at
         FROM keys
        WHERE ${whereClause}
        LIMIT 1`,
      [value]
    ).then(r => r.rows[0] || null);
  };

  for (const token of candidates) {
    const sanitized = sanitizeToken(token);
    if (!sanitized) continue;

    const lower = sanitized.toLowerCase();
    if (!tried.has(lower)) {
      tried.add(lower);
      const row = await fetchKey("LOWER(key_code) = $1", lower);
      if (row) return row;
    }

    const collapsed = sanitizedCollapsed(sanitized);
    if (!collapsed) continue;
    const collapsedLower = collapsed.toLowerCase();
    const collapsedKey = `collapsed:${collapsedLower}`;
    if (tried.has(collapsedKey)) continue;
    tried.add(collapsedKey);
    const collapsedRow = await fetchKey(
      "LOWER(REGEXP_REPLACE(key_code, '[^A-Za-z0-9._\\-+=]+', '', 'g')) = $1",
      collapsedLower
    );
    if (collapsedRow) return collapsedRow;
  }

  return null;
}

function ensureAdmin(req, res, next) {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  return next();
}

async function recordOp(userId, type, amount, note) {
  if (!userId) return;
  await q(`INSERT INTO ops (user_id, type, amount, note) VALUES ($1,$2,$3,$4)`, [
    userId,
    type,
    amount,
    note
  ]);
}

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
  lang TEXT DEFAULT 'en',
  sub_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sub_expires TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS keys (
  id SERIAL PRIMARY KEY,
  key_code TEXT UNIQUE NOT NULL,
  days INT NOT NULL DEFAULT 30,
  used_by BIGINT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,
  amount NUMERIC(18,2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT,
  status TEXT DEFAULT 'open',
  pnl NUMERIC(18,2) DEFAULT 0,
  sl NUMERIC(18,2),
  tp NUMERIC(18,2),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL,
  method TEXT,
  address TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS withdraw_methods (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  address TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, method)
);

CREATE TABLE IF NOT EXISTS daily_targets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  target NUMERIC(18,2) NOT NULL,
  symbol TEXT DEFAULT 'XAUUSD',
  duration_sec INT DEFAULT 1800,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
    const body = req.body || {};
    const submittedKey = body.key;
    const rawKey = body.rawKey;
    const tg_id = body.tg_id;
    const name = body.name ?? "";
    const email = body.email ?? "";
    const initData = body.initData;

    const candidateSources = [rawKey, submittedKey];
    const keyCandidates = [];
    const seenCandidates = new Set();
    if (Array.isArray(body.candidates)) {
      body.candidates.forEach(token => {
        const sanitized = sanitizeToken(token);
        if (!sanitized) return;
        const lower = sanitized.toLowerCase();
        if (seenCandidates.has(lower)) return;
        seenCandidates.add(lower);
        keyCandidates.push(sanitized);
      });
    }
    candidateSources.forEach(source => {
      extractKeyCandidates(source || "").forEach(token => {
        const lower = token.toLowerCase();
        if (seenCandidates.has(lower)) return;
        seenCandidates.add(lower);
        keyCandidates.push(token);
      });
    });
    if (!keyCandidates.length) {
      const fallback = normalizeKey(submittedKey || rawKey || "");
      if (fallback) keyCandidates.push(fallback);
    }
    const normalizedKey = keyCandidates[0] || "";
    const tgId = String(tg_id || "").trim();
    if (!normalizedKey || !tgId) {
      return res.json({ ok: false, error: "missing_parameters" });
    }

    let sessionVerified = false;
    if (initData && process.env.BOT_TOKEN) {
      const verified = checkTelegramInitData(initData, process.env.BOT_TOKEN);
      const telegramUser = parseInitData(initData);
      sessionVerified = verified && (!telegramUser?.id || String(telegramUser.id) === tgId);
      if (!sessionVerified) {
        return res.json({ ok: false, error: "invalid_session" });
      }
    }

    const existingUser = await getUserByTelegramId(tgId);
    const keyRow = await findKeyByCandidates(keyCandidates);

    if (!keyRow) {
      if (existingUser && sessionVerified) {
        return res.json({ ok: true, user: existingUser, reused: true });
      }
      return res.json({ ok: false, error: "invalid_key" });
    }

    if (keyRow.used_by && String(keyRow.used_by) !== tgId) {
      return res.json({ ok: false, error: "invalid_key" });
    }

    const days = Number(keyRow.days || 0) || 30;
    const user = await q(
      `INSERT INTO users (tg_id, name, email, sub_expires, level)
       VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval, 'Bronze')
       ON CONFLICT (tg_id) DO UPDATE
       SET name = COALESCE(NULLIF(EXCLUDED.name,''), users.name),
           email = COALESCE(NULLIF(EXCLUDED.email,''), users.email),
           sub_expires = GREATEST(COALESCE(users.sub_expires, NOW()), NOW()) + ($4 || ' days')::interval
       RETURNING *`,
      [tgId, name, email, days]
    ).then(r => r.rows[0]);

    await q(`UPDATE keys SET used_by=$1, used_at=NOW() WHERE id=$2`, [tgId, keyRow.id]);
    await recordOp(user.id, "activate", 0, `Activated with key ${keyRow.key_code}`);

    console.log(`✅ User activated: ${user.name || "unknown"} (${tgId})`);
    res.json({ ok: true, user });
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

app.get("/api/ops/:tg", async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.params.tg);
    if (!user) return res.json({ ok: false, list: [] });
    const ops = await q(
      `SELECT id, type, amount, note, created_at FROM ops WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    ).then(r => r.rows);
    res.json({ ok: true, list: ops });
  } catch (e) {
    res.json({ ok: false, error: e.message, list: [] });
  }
});

app.get("/api/requests/:tg", async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.params.tg);
    if (!user) return res.json({ ok: false, list: [] });
    const rows = await q(
      `SELECT id, amount, method, address, status, created_at FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    ).then(r => r.rows);
    res.json({ ok: true, list: rows });
  } catch (e) {
    res.json({ ok: false, error: e.message, list: [] });
  }
});

app.post("/api/withdraw/method", async (req, res) => {
  try {
    const { tg_id, method, address } = req.body || {};
    if (!tg_id || !method || !address) {
      return res.status(400).json({ ok: false, error: "missing_parameters" });
    }
    const user = await getUserByTelegramId(String(tg_id));
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
    await q(
      `INSERT INTO withdraw_methods (user_id, method, address)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, method) DO UPDATE SET address=EXCLUDED.address, updated_at=NOW()`,
      [user.id, method, address]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { tg_id, amount, method } = req.body || {};
    const value = Number(amount);
    if (!tg_id || !method || !(value > 0)) {
      return res.status(400).json({ ok: false, error: "missing_parameters" });
    }
    const user = await getUserByTelegramId(String(tg_id));
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
    if (Number(user.balance || 0) < value) {
      return res.status(400).json({ ok: false, error: "insufficient_balance" });
    }
    const saved = await q(
      `SELECT address FROM withdraw_methods WHERE user_id=$1 AND method=$2`,
      [user.id, method]
    ).then(r => r.rows[0]);
    if (!saved?.address) {
      return res.status(400).json({ ok: false, error: "missing_address" });
    }
    const request = await q(
      `INSERT INTO requests (user_id, amount, method, address)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [user.id, value, method, saved.address]
    ).then(r => r.rows[0]);
    await q(`UPDATE users SET balance = balance - $1 WHERE id=$2`, [value, user.id]);
    await recordOp(user.id, "withdraw", -value, `Withdraw request #${request.id}`);
    res.json({ ok: true, request });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/withdraw/cancel", async (req, res) => {
  try {
    const { tg_id, id } = req.body || {};
    if (!tg_id || !id) {
      return res.status(400).json({ ok: false, error: "missing_parameters" });
    }
    const user = await getUserByTelegramId(String(tg_id));
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
    const request = await q(
      `UPDATE requests SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='pending'
       RETURNING *`,
      [id, user.id]
    ).then(r => r.rows[0]);
    if (!request) {
      return res.status(400).json({ ok: false, error: "cannot_cancel" });
    }
    await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [request.amount, user.id]);
    await recordOp(user.id, "withdraw_cancel", Number(request.amount) || 0, `Cancelled withdraw #${request.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ==================== ADMIN ====================
app.get("/api/admin/stats", ensureAdmin, async (_req, res) => {
  try {
    const users = await q(`SELECT COUNT(*) AS total FROM users`).then(r => Number(r.rows[0]?.total || 0));
    const deposits = await q(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS total FROM ops`
    ).then(r => Number(r.rows[0]?.total || 0));
    const withdrawals = await q(
      `SELECT COALESCE(SUM(amount),0) AS total FROM requests WHERE status='approved'`
    ).then(r => Number(r.rows[0]?.total || 0));
    const openTrades = await q(`SELECT COUNT(*) AS total FROM trades WHERE status='open'`)
      .then(r => Number(r.rows[0]?.total || 0));
    const recent = await q(
      `SELECT id, type, amount, note, created_at FROM ops ORDER BY created_at DESC LIMIT 20`
    ).then(r => r.rows);
    res.json({ ok: true, users, deposits, withdrawals, open_trades: openTrades, recent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/users", ensureAdmin, async (req, res) => {
  try {
    const qv = (req.query.q || "").toString().trim();
    const params = [];
    let where = "";
    if (qv) {
      if (/^\d+$/.test(qv)) {
        params.push(qv);
        where = "WHERE tg_id = $1";
      } else {
        params.push(`%${qv}%`);
        where = "WHERE LOWER(name) LIKE LOWER($1)";
      }
    }
    const items = await q(
      `SELECT id, tg_id, name, balance, sub_expires AS sub_expires_at
       FROM users ${where}
       ORDER BY id DESC
       LIMIT 100`,
      params
    ).then(r => r.rows);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/users/:id/balance", ensureAdmin, async (req, res) => {
  try {
    const { delta = 0, note = "" } = req.body || {};
    const value = Number(delta);
    if (!Number.isFinite(value) || value === 0) {
      return res.status(400).json({ ok: false, error: "invalid_delta" });
    }
    const user = await q(`UPDATE users SET balance = balance + $1 WHERE id=$2 RETURNING *`, [value, req.params.id])
      .then(r => r.rows[0]);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
    await recordOp(user.id, value > 0 ? "admin_deposit" : "admin_withdraw", value, note || "admin panel");
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/withdrawals", ensureAdmin, async (_req, res) => {
  try {
    const items = await q(
      `SELECT id, user_id, amount, method, address, status, created_at
       FROM requests
       ORDER BY created_at DESC
       LIMIT 100`
    ).then(r => r.rows);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/withdrawals/:id/approve", ensureAdmin, async (req, res) => {
  try {
    const row = await q(
      `UPDATE requests SET status='approved', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id]
    ).then(r => r.rows[0]);
    if (!row) return res.status(400).json({ ok: false, error: "cannot_approve" });
    await recordOp(row.user_id, "withdraw_approved", -Number(row.amount || 0), `Approved withdraw #${row.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/withdrawals/:id/reject", ensureAdmin, async (req, res) => {
  try {
    const reason = (req.body?.reason || "").toString();
    const row = await q(
      `UPDATE requests SET status='rejected', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id]
    ).then(r => r.rows[0]);
    if (!row) return res.status(400).json({ ok: false, error: "cannot_reject" });
    await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [row.amount, row.user_id]);
    await recordOp(row.user_id, "withdraw_rejected", Number(row.amount) || 0, reason || `Rejected withdraw #${row.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/admin/trades", ensureAdmin, async (_req, res) => {
  try {
    const items = await q(
      `SELECT id, user_id, symbol, status, pnl, opened_at, closed_at FROM trades ORDER BY id DESC LIMIT 100`
    ).then(r => r.rows);
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/trades/:id/close", ensureAdmin, async (req, res) => {
  try {
    const pnl = Number(req.body?.pnl || 0);
    const trade = await q(
      `UPDATE trades SET status='closed', pnl=$1, closed_at=NOW() WHERE id=$2 AND status='open' RETURNING *`,
      [pnl, req.params.id]
    ).then(r => r.rows[0]);
    if (!trade) return res.status(400).json({ ok: false, error: "cannot_close" });
    if (pnl !== 0) {
      if (pnl > 0) {
        await q(`UPDATE users SET balance = balance + $1, wins = wins + $1 WHERE id=$2`, [pnl, trade.user_id]);
      } else {
        await q(`UPDATE users SET losses = losses + $1 WHERE id=$2`, [Math.abs(pnl), trade.user_id]);
      }
      await recordOp(trade.user_id, "trade_close", pnl, `Trade #${trade.id} closed`);
    }
    res.json({ ok: true, trade });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

app.listen(PORT, () => {
  console.log(`🟢 QL Trading AI Server running on port ${PORT}`);
});
