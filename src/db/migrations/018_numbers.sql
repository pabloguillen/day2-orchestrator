-- Numbers (src/numbers/): what App Store Connect and Google Play reported
-- for the app (installs, store page views, sessions, Play vitals) per day,
-- the owner's report settings (Apple vendor number, Play reports bucket),
-- daily ad spend and crash counts kept past the field data's own limits —
-- one document per app, refreshed by the daily pass.
CREATE TABLE numbers_cache (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The platform (ios, android, web) the device reported with each event, so
-- the numbers can be split by platform. NULL for events stored before this.
ALTER TABLE field_events ADD COLUMN platform text;
