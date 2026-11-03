-- day2's inbox at Cloudflare (deploy/inbox/worker.js): reports kept while day2 can't be reached.
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  origin TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_received ON inbox (received_at);

-- The last good Live config per app key (GET /api/ingest/<key>/config), served
-- while day2 can't be reached so apps keep their settings and experiments.
CREATE TABLE IF NOT EXISTS live_config (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  etag TEXT,
  saved_at INTEGER NOT NULL
);
