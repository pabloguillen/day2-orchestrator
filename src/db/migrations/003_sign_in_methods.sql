-- Sign-in without GitHub: Google, and one-time links by email.
--
-- A person (users) can have several ways in (identities). A new way in with
-- a verified email that matches a person's verified email joins that
-- person — so signing in with Google, GitHub or an email link lands in the
-- same account.

ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;
ALTER TABLE users ALTER COLUMN login DROP NOT NULL;
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX users_verified_email ON users (lower(email)) WHERE email_verified;

CREATE TABLE identities (
  provider     text NOT NULL CHECK (provider IN ('github', 'google', 'email')),
  subject      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);
INSERT INTO identities (provider, subject, user_id, email, created_at)
  SELECT 'github', github_id::text, id, email, created_at FROM users WHERE github_id IS NOT NULL;

-- Invitations by GitHub username or by email.
ALTER TABLE invites ALTER COLUMN github_login DROP NOT NULL;
ALTER TABLE invites ADD COLUMN email text;
ALTER TABLE invites ADD CONSTRAINT invites_one_target CHECK ((github_login IS NULL) <> (email IS NULL));
CREATE UNIQUE INDEX invites_account_email ON invites (account_id, lower(email)) WHERE email IS NOT NULL;

-- One-time sign-in links. Only a SHA-256 of the token is stored.
CREATE TABLE email_sign_in (
  token_hash  text PRIMARY KEY,
  email       text NOT NULL,
  next_path   text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX email_sign_in_email ON email_sign_in (lower(email), created_at);
CREATE INDEX email_sign_in_ip ON email_sign_in (ip, created_at);

-- Which sign-in a state belongs to, and (for "Connect GitHub") who started it.
ALTER TABLE oauth_states ADD COLUMN provider text NOT NULL DEFAULT 'github';
ALTER TABLE oauth_states ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
