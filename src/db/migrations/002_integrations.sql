-- JIRA / Linear connections per app. The whole config (tokens included) is
-- one AES-256-GCM ciphertext (secrets.ts), bound to the app id.

CREATE TABLE app_integrations (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  data_enc    text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_integrations_account ON app_integrations (account_id);

-- One day2 account per GitHub App installation, so repos reachable through
-- an installation belong to exactly one customer account.
CREATE UNIQUE INDEX accounts_github_installation ON accounts (github_installation_id) WHERE github_installation_id IS NOT NULL;

-- "Connect GitHub" round-trips through GitHub's install page; the state
-- remembers which account the installation is for.
ALTER TABLE oauth_states ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
