-- Connected tools (connectors.ts): one encrypted OAuth record per
-- workspace and tool (Foreplay, Runway, Meta Ads, …).

CREATE TABLE account_connectors (
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connector_id  text NOT NULL,
  data_enc      text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, connector_id)
);
