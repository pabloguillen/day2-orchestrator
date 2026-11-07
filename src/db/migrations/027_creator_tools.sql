-- Creator tools (src/creative/): the owner's own API keys for tools like
-- Runway, HeyGen or ElevenLabs, for one app (app_id) or the whole workspace
-- (app_id NULL). Keys are encrypted by day2 (DAY2_SECRETS_KEY), bound to the
-- row id, and never returned by the API. `meta` holds which fields are set
-- and the likeness consent (who, when) — never key values.
CREATE TABLE creator_tool_keys (
  id            text PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  app_id        text REFERENCES apps(id) ON DELETE CASCADE,
  tool          text NOT NULL,
  secret_enc    text NOT NULL,
  meta          jsonb NOT NULL,
  connected_by  text,
  connected_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX creator_tool_keys_scope ON creator_tool_keys (account_id, COALESCE(app_id, ''), tool);
