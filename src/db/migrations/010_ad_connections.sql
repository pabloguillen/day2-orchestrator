-- One-click ad connections (src/ads/connections.ts): day2's own ad accounts
-- (scope 'day2') and apps' own ad accounts (scope 'app:<id>'). Tokens are
-- encrypted by day2 (DAY2_SECRETS_KEY), bound to the row id.

CREATE TABLE ad_connections (
  id             text PRIMARY KEY,
  scope          text NOT NULL,
  app_id         text REFERENCES apps(id) ON DELETE CASCADE,
  platform       text NOT NULL,
  ad_account_id  text NOT NULL,
  account_name   text NOT NULL,
  currency       text NOT NULL,
  tokens         text NOT NULL,
  connected_by   text,
  connected_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, platform)
);

-- Between the platform's sign-in and picking an account or page (1 hour).
CREATE TABLE ad_connect_pending (
  id          text PRIMARY KEY,
  state       text NOT NULL UNIQUE,
  scope       text NOT NULL,
  platform    text NOT NULL,
  purpose     text NOT NULL,
  app_id      text REFERENCES apps(id) ON DELETE CASCADE,
  pending     text,
  tokens      text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Identities can wait on the platform owner's approval (e.g. a Meta Page request).
ALTER TABLE app_platform_identities ADD COLUMN status text NOT NULL DEFAULT 'ready';
ALTER TABLE app_platform_identities ADD COLUMN todo text;

-- Conversions day2 already sent, per app and platform (never twice).
CREATE TABLE ad_conversions_sent (
  app_id    text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform  text NOT NULL,
  event_id  text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, platform, event_id)
);
