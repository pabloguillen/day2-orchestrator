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
