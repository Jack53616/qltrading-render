-- Users
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
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Keys
CREATE TABLE IF NOT EXISTS keys (
  id SERIAL PRIMARY KEY,
  key_code TEXT UNIQUE NOT NULL,
  days INT DEFAULT 30,
  used_by BIGINT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Operations (activity feed)
CREATE TABLE IF NOT EXISTS ops (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,           -- deposit / withdraw / pnl / open / close / info
  amount NUMERIC(18,2) DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT DEFAULT 'XAUUSD',
  status TEXT DEFAULT 'open', -- open/closed
  opened_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  pnl NUMERIC(18,2) DEFAULT 0,
  stop_loss NUMERIC(18,2),
  take_profit NUMERIC(18,2)
);

-- Withdraw requests
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  method TEXT,                     -- usdt_trc20 / usdt_erc20 / btc / eth
  address TEXT,
  amount NUMERIC(18,2) NOT NULL,
  status TEXT DEFAULT 'pending',   -- pending/approved/rejected/cancelled
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS withdraw_methods (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  address TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, method)
);

-- Daily progression targets (drive balance gradually to a target amount)
CREATE TABLE IF NOT EXISTS daily_targets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT DEFAULT 'XAUUSD',
  target NUMERIC(18,2) NOT NULL,   -- +10 for profit, -10 for loss
  duration_sec INT DEFAULT 1800,   -- total duration to reach target
  started_at TIMESTAMPTZ DEFAULT now(),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
