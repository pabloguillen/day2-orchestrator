-- Live (src/live/, docs/live.md): settings and experiments sent to apps over
-- the air. Events gain small props, money (revenue) and the Live experiments
-- the device was exposed to, so experiments can be judged per variant.

ALTER TABLE field_events ADD COLUMN props jsonb;
ALTER TABLE field_events ADD COLUMN value jsonb;
ALTER TABLE field_events ADD COLUMN variants jsonb;
CREATE INDEX field_events_app_type ON field_events (app_id, type, at);

-- One Live document per app: values, experiments, ideas, settings and the
-- decision log (LiveState in src/live/types.ts). Small; read on every config
-- request, written when something changes.
CREATE TABLE live_state (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The config last served per app, with its version (etag), so an unchanged
-- config keeps its version and apps get "304 Not Modified".
CREATE TABLE live_served (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  hash        text NOT NULL,
  body        jsonb NOT NULL,
  served_at   timestamptz NOT NULL DEFAULT now()
);
