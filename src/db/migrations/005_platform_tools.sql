-- day2 now runs the tools on its own accounts; per-workspace connections
-- (004) are replaced by platform-wide ones.
DROP TABLE IF EXISTS account_connectors;

-- The tools day2 runs for every customer (connectors.ts): day2's own
-- accounts (Foreplay, Runway, Meta Ads), connected once by the operator.
-- One encrypted OAuth record per tool.

CREATE TABLE platform_connectors (
  connector_id  text PRIMARY KEY,
  data_enc      text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Meta shows every ad under a Facebook Page: the Page day2 runs each app's
-- ads under, assigned once by the operator.
CREATE TABLE app_ad_identities (
  app_id        text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  meta_page_id  text NOT NULL,
  set_by        text,
  set_at        timestamptz NOT NULL DEFAULT now()
);
