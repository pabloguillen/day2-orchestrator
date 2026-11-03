-- Messages (src/messages/, docs/messages.md): push notifications and in-app
-- messages for the lifecycle. Users are the app's own ids hashed and salted
-- per app (u_…); push tokens live only here — never in events or logs.

-- Expo push tokens per app and hashed user. A token belongs to one device;
-- signing in as someone else on that device moves it. Invalidated tokens
-- (Expo said DeviceNotRegistered, or the app reported push switched off)
-- are never sent to and are deleted by the daily cleanup; tokens not seen
-- for 400 days are deleted too.
CREATE TABLE push_tokens (
  app_id          text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  token           text NOT NULL,
  user_id         text NOT NULL,
  platform        text NOT NULL,
  tz              text,
  tz_offset       integer,
  locale          text,
  updated_at      timestamptz NOT NULL,
  invalidated_at  timestamptz,
  invalid_reason  text,
  PRIMARY KEY (app_id, token)
);
CREATE INDEX push_tokens_app_user ON push_tokens (app_id, user_id);

-- Who switched push off, and when (no token): the guardrail that stops a
-- campaign whose recipients turn notifications off more. Kept 400 days.
CREATE TABLE message_optouts (
  app_id   text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id  text NOT NULL,
  at       timestamptz NOT NULL,
  reason   text NOT NULL,
  PRIMARY KEY (app_id, user_id, at)
);

-- Every planned, held-out, sent and failed message per user (no token, no
-- text): limits per week, "stop when ignored", receipts and measurement.
CREATE TABLE message_sends (
  id           text PRIMARY KEY,
  app_id       text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  campaign_id  text NOT NULL,
  user_id      text NOT NULL,
  channel      text NOT NULL,
  arm          text NOT NULL,
  status       text NOT NULL,
  locale       text,
  eligible_at  timestamptz NOT NULL,
  due_at       timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  sent_at      timestamptz,
  receipts     jsonb NOT NULL DEFAULT '[]',
  error        text,
  checked_at   timestamptz
);
CREATE INDEX message_sends_app_user ON message_sends (app_id, user_id, eligible_at);
CREATE INDEX message_sends_due ON message_sends (app_id, status, due_at);
CREATE INDEX message_sends_campaign ON message_sends (app_id, campaign_id);

-- Settings and campaigns (texts, schedule, results) per app.
CREATE TABLE app_messages (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL
);
