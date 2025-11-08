-- Postgres schema for QL Trading (core only, no demo/missions/learn/store)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE,
  name TEXT,
  email TEXT,
  language TEXT DEFAULT 'en',
  vip_level TEXT DEFAULT 'standard',
  balance NUMERIC(18,2) DEFAULT 0,
  wins NUMERIC(18,2) DEFAULT 0,
  losses NUMERIC(18,2) DEFAULT 0,
  sub_expires_at TIMESTAMPTZ,
  theme TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS keys (
  id SERIAL PRIMARY KEY,
  key_code TEXT UNIQUE NOT NULL,
  days INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT now(),
  used_by INTEGER REFERENCES users(id),
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol TEXT,
  status TEXT CHECK (status IN ('open','closed')) DEFAULT 'open',
  opened_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  pnl NUMERIC(18,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  amount NUMERIC(18,2) NOT NULL,
  method TEXT NOT NULL, -- 'usdt_trc20'|'usdt_erc20'|'btc'|'eth'
  address TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending','approved','rejected','canceled')) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) UNIQUE,
  usdt_trc20 TEXT,
  usdt_erc20 TEXT,
  btc TEXT,
  eth TEXT
);

CREATE TABLE IF NOT EXISTS ops (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type TEXT, -- 'deposit'|'withdraw'|'pnl'|'admin'|'system'
  amount NUMERIC(18,2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);
