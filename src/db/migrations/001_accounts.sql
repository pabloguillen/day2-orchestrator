-- day2 schema v1: people, customer accounts, sign-in, apps, credits.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   bigint UNIQUE NOT NULL,
  login       text NOT NULL,
  name        text,
  email       text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_login_lower ON users (lower(login));

-- A customer account (workspace): the unit that owns apps, credits and a plan.
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  github_installation_id bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- Invitations by GitHub username; accepted on that person's next sign-in.
CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  github_login text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX invites_account_login ON invites (account_id, lower(github_login));

-- Sessions: only a SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Short-lived OAuth "state" values (login CSRF protection).
CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  next_path   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE apps (
  id                text PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name              text NOT NULL,
  repo_path         text NOT NULL,
  connection_method text NOT NULL,
  github_repo       text,
  app_base_url      text,
  added_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apps_account ON apps (account_id);
CREATE UNIQUE INDEX apps_account_repo ON apps (account_id, repo_path);

-- Credits (credits.ts): the account's plan state and its append-only ledger.
CREATE TABLE credit_accounts (
  account_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_events (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id          text NOT NULL,
  seq         bigserial,
  kind        text NOT NULL,
  at          timestamptz NOT NULL,
  data        jsonb NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX credit_events_account_seq ON credit_events (account_id, seq);
