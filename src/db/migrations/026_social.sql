-- Social posts (src/social/): organic posts day2 makes for an app and
-- publishes on the owner's own Instagram, Facebook Page and TikTok.

-- The owner's connected social accounts, per app and network ('meta' for
-- Instagram + the Facebook Page, 'tiktok'). Tokens (the Page access token,
-- TikTok's access + refresh token) are encrypted by day2 (DAY2_SECRETS_KEY),
-- bound to the row id, and never returned by the API.
CREATE TABLE social_accounts (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  network       text NOT NULL CHECK (network IN ('meta', 'tiktok')),
  meta          jsonb NOT NULL,
  tokens        text NOT NULL,
  connected_by  text,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, network)
);

-- One post: what it shows, the words per platform, when it goes out, what
-- it became (external ids) and how it did. The whole post is `doc`; the
-- columns are what the publisher selects on.
CREATE TABLE social_posts (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('draft', 'waiting_approval', 'approved', 'publishing', 'published', 'failed', 'declined')),
  scheduled_at  timestamptz,
  doc           jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_posts_app ON social_posts (app_id, created_at DESC);
CREATE INDEX social_posts_due ON social_posts (status, scheduled_at);

-- Unguessable, expiring public links to a post's media (Instagram and
-- Facebook fetch media by URL): served at /api/assets/<token>, gone 24 hours
-- after the post went out.
CREATE TABLE social_media_links (
  token       text PRIMARY KEY,
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  asset_id    text NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX social_media_links_expiry ON social_media_links (expires_at);
