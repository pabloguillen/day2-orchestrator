-- Field contracts (packages/sensors): what apps report from users' devices.

-- Each app's send-only key: in the app's code, so it's public; it can only
-- send reports for that one app, never read anything.
CREATE TABLE app_ingest_keys (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  key         text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The contracts day2 generated from the app's code (served to the devices).
CREATE TABLE app_contracts (
  app_id        text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  head          text,
  file          jsonb NOT NULL,
  candidates    jsonb NOT NULL DEFAULT '[]',
  generated_at  timestamptz NOT NULL DEFAULT now()
);

-- Per contract per day: how often it held and how often it broke.
CREATE TABLE field_counts (
  app_id    text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  contract  text NOT NULL,
  day       date NOT NULL,
  passes    integer NOT NULL DEFAULT 0,
  failures  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, contract, day)
);

-- Failure reports in full (expected, actual, evidence, steps) — kept 30 days.
CREATE TABLE field_failures (
  id         bigserial PRIMARY KEY,
  app_id     text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  contract   text NOT NULL,
  at         timestamptz NOT NULL,
  device_id  text NOT NULL,
  release    text,
  device     jsonb NOT NULL,
  report     jsonb NOT NULL
);
CREATE INDEX field_failures_app_contract_at ON field_failures (app_id, contract, at DESC);

-- Growth events (visit, signup, activated, shared, invite_sent…) — kept 180 days.
CREATE TABLE field_events (
  id           bigserial PRIMARY KEY,
  app_id       text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL,
  device_id    text NOT NULL,
  type         text NOT NULL,
  acquisition  jsonb
);
CREATE INDEX field_events_app_at ON field_events (app_id, at);

-- When each app last reported, and from which release.
CREATE TABLE field_meta (
  app_id        text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  last_seen_at  timestamptz NOT NULL,
  last_release  text,
  platforms     text[] NOT NULL DEFAULT '{}'
);
