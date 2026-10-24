-- Retention (retention.ts): who comes back. Users are the app's own ids,
-- hashed and salted per app by the library (never the id, email or name).

ALTER TABLE field_events ADD COLUMN user_id text;
CREATE INDEX field_events_app_user ON field_events (app_id, user_id) WHERE user_id IS NOT NULL;

-- Each user: when first and last seen (kept two years).
CREATE TABLE field_users (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  first_seen  date NOT NULL,
  last_seen   date NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

-- The days each user was active (kept 400 days): lifecycle states are made of these.
CREATE TABLE field_user_days (
  app_id   text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id  text NOT NULL,
  day      date NOT NULL,
  PRIMARY KEY (app_id, user_id, day)
);
CREATE INDEX field_user_days_app_day ON field_user_days (app_id, day);

-- The latest daily retention snapshot per app (states, return rates, treatments).
CREATE TABLE app_retention (
  app_id    text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  snapshot  jsonb NOT NULL,
  at        timestamptz NOT NULL
);
