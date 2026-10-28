-- Multi-platform ads (src/ads/): finished images and videos, and who each
-- app's ads show as on each platform.

CREATE TABLE ad_assets (
  id          text PRIMARY KEY,
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  meta        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_assets_app ON ad_assets (app_id, created_at DESC);

-- Per app and platform: the page/account/identity its ads run under.
CREATE TABLE app_platform_identities (
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform      text NOT NULL,
  ref           text NOT NULL,
  display_name  text NOT NULL,
  set_by        text,
  set_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, platform)
);
-- The Meta Pages assigned before (app_ad_identities) carry over.
INSERT INTO app_platform_identities (app_id, platform, ref, display_name, set_by, set_at)
  SELECT app_id, 'meta', meta_page_id, '', set_by, set_at FROM app_ad_identities
  ON CONFLICT DO NOTHING;
