-- Learning across apps ("What works", src/learning/): one platform-wide
-- library of anonymous outcomes, shared by every account that didn't opt
-- out. No app names, texts, user numbers, revenue amounts or identifiers:
-- relative effects, size buckets and a fixed vocabulary only. app_hash and
-- account_hash are salted hashes used only to count apps and accounts (priors
-- need 3 of each, and leave the asking account out) and to forget an account
-- or app; they are never shown. learning_playbook.apps / fixed_in hold
-- "<account_hash>.<app_hash>".
CREATE TABLE learning_outcomes (
  id           text PRIMARY KEY,
  at           date NOT NULL,
  app_hash     text NOT NULL,
  account_hash text NOT NULL,
  ref_hash     text NOT NULL UNIQUE,
  category     text NOT NULL,
  product_type text NOT NULL,
  platform     text NOT NULL,
  kind         text NOT NULL,
  pattern      text NOT NULL,
  metric       text NOT NULL,
  effect       real,
  low          real,
  high         real,
  n_bucket     text NOT NULL CHECK (n_bucket IN ('<100', '100-1k', '1k-10k', '10k+')),
  verdict      text NOT NULL CHECK (verdict IN ('better', 'worse', 'no_clear_change')),
  source       text NOT NULL
);
CREATE INDEX learning_outcomes_kind ON learning_outcomes (kind, category);
CREATE INDEX learning_outcomes_account ON learning_outcomes (account_hash);

-- Build playbook: generalized fixes for failure signatures (framework,
-- package, error type), reviewed by the operator before agents see them.
CREATE TABLE learning_playbook (
  id          text PRIMARY KEY,
  key         text NOT NULL,
  framework   text NOT NULL,
  pkg         text,
  error_type  text NOT NULL,
  fix         text NOT NULL,
  status      text NOT NULL CHECK (status IN ('candidate', 'approved', 'retired')),
  apps        jsonb NOT NULL DEFAULT '[]',
  fixed_in    jsonb NOT NULL DEFAULT '[]',
  seen        integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- Failures waiting for the run that fixes them (per app and ticket, hashed).
CREATE TABLE learning_failures (
  ref         text PRIMARY KEY,
  app_hash    text NOT NULL,
  account_hash text NOT NULL,
  key         text NOT NULL,
  framework   text NOT NULL,
  pkg         text,
  error_type  text NOT NULL,
  at          timestamptz NOT NULL
);

-- New false-positive patterns the calibration loop suggested, for review
-- (src/false-positive-patterns.ts itself only changes by hand).
CREATE TABLE learning_fp_candidates (
  id          text PRIMARY KEY,
  persona     text NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('candidate', 'approved', 'dismissed')),
  seen        integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- Per account: share anonymous outcomes (default on; the owner can turn it off).
CREATE TABLE learning_settings (
  account_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  share       boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
