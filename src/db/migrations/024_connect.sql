-- Connect your stores (src/connect/): the owner's Google access token
-- between Google's consent page and the end of setup, encrypted by day2
-- (DAY2_SECRETS_KEY) and bound to the row id. At most an hour; deleted when
-- setup ends. No refresh token is ever asked for.
CREATE TABLE connect_google_sessions (
  id          text PRIMARY KEY,
  state       text NOT NULL UNIQUE,
  account_id  text NOT NULL,
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  secret      text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connect_google_sessions_created ON connect_google_sessions (created_at);
