-- Mobile releases (src/mobile-release/): which devices ran which release
-- (store version and over-the-air update), so a new release's crash rate can
-- be compared with the one before it. Device ids are random per launch by
-- default, so this counts launches.

CREATE TABLE field_release_devices (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release     text NOT NULL,
  device_id   text NOT NULL,
  platform    text NOT NULL,
  first_seen  timestamptz NOT NULL,
  PRIMARY KEY (app_id, release, device_id)
);
CREATE INDEX field_release_devices_seen ON field_release_devices (app_id, release, first_seen);

-- Store credentials for releasing (Expo, App Store Connect, Google Play),
-- encrypted by day2 (DAY2_SECRETS_KEY), bound to app and kind.
CREATE TABLE release_credentials (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  secret      text NOT NULL,
  label       text NOT NULL,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, kind)
);
