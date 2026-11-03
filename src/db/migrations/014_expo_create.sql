-- Create (src/expo-create/): new native Expo apps built from a description.
-- One row per build; the whole build record (plan, mockups, progress,
-- checks) is kept as JSON so an unfinished build can be resumed after a
-- restart.

CREATE TABLE expo_creates (
  id          text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status      text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expo_creates_account ON expo_creates (account_id, created_at DESC);
CREATE INDEX expo_creates_working ON expo_creates (status) WHERE status = 'working';
