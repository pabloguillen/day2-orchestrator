-- Hosting (src/hosting/, docs/hosting.md): each app's backend on Supabase,
-- in day2's Supabase organization. What's set up, health, usage, findings
-- and history per app — nothing secret.
CREATE TABLE app_hosting (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The app's hosting secrets, encrypted with DAY2_SECRETS_KEY (bound to app
-- and kind): database passwords, secret keys, the owner's Apple / Google
-- sign-in secrets, an SMTP password, the owner's own Supabase token after a
-- takeover. Never returned by the API.
CREATE TABLE hosting_secrets (
  app_id  text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind    text NOT NULL,
  secret  text NOT NULL,
  label   text NOT NULL,
  set_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, kind)
);
