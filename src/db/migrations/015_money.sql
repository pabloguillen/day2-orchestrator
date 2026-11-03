-- Money (src/money/): what Apple and Google confirmed, per hashed user
-- (never receipts, emails or raw user ids), the queue of store notifications
-- being checked, and the keys only Money needs (In-App Purchase key, Pub/Sub
-- push settings, RevenueCat), encrypted by day2 (DAY2_SECRETS_KEY).

CREATE TABLE money_records (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  id          text NOT NULL,
  store       text NOT NULL,
  type        text NOT NULL,
  kind        text NOT NULL,
  product_id  text,
  at          timestamptz NOT NULL,
  amount      numeric(12, 4) NOT NULL DEFAULT 0,
  currency    text NOT NULL,
  user_hash   text,
  variants    jsonb NOT NULL DEFAULT '{}'::jsonb,
  source      text,
  chain       text,
  sandbox     boolean NOT NULL DEFAULT false,
  expires_at  timestamptz,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX money_records_at ON money_records (app_id, at);

CREATE TABLE money_queue (
  app_id       text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  id           text NOT NULL,
  store        text NOT NULL,
  received_at  timestamptz NOT NULL,
  state        text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  next_at      timestamptz,
  error        text,
  payload      jsonb,
  note         text,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX money_queue_due ON money_queue (app_id, state, next_at);

CREATE TABLE money_credentials (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  secret      text NOT NULL,
  label       text NOT NULL,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, kind)
);
