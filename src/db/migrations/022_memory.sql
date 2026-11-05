-- App memory ("What day2 knows", src/memory/): short items distilled from
-- what the owner says and decides — facts, preferences, rules, things not
-- to do, who the app is for, how it's built — with where each came from.
-- Never secrets or data about the app's users (src/memory/privacy.ts).
CREATE TABLE memory_items (
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  id            text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('fact', 'preference', 'rule', 'do_not', 'audience', 'tech')),
  text          text NOT NULL,
  source_kind   text NOT NULL CHECK (source_kind IN ('owner_comment', 'answer', 'decline', 'correction', 'approval_note', 'backlog_rule', 'onboarding', 'day2_observed')),
  source_ref    jsonb,
  who           text NOT NULL,
  at            timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  confidence    real NOT NULL,
  status        text NOT NULL CHECK (status IN ('active', 'needs_confirmation', 'retired')),
  supersedes    text,
  superseded_by text,
  scope         jsonb NOT NULL DEFAULT '[]',
  keys          jsonb NOT NULL DEFAULT '[]',
  last_used_at  timestamptz,
  last_used_for text,
  rule_id       text,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX memory_items_status ON memory_items (app_id, status);

-- Per app: owner input waiting for the memory keeper, declined proposals
-- (the 90-day hard filter), recent changes the owner should see, and when
-- the keeper last ran (at most hourly, plus right after a decline or answer).
CREATE TABLE memory_state (
  app_id          text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  inbox           jsonb NOT NULL DEFAULT '[]',
  declines        jsonb NOT NULL DEFAULT '[]',
  changes         jsonb NOT NULL DEFAULT '[]',
  last_capture_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
