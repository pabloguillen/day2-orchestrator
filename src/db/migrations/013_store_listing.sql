-- Store (src/store-listing/): the app's store listing work — listing texts
-- read from the stores, proposals and their approvals, research runs,
-- screenshot sets, product page tests, custom product pages, rating
-- snapshots and settings — as one document per app.
CREATE TABLE store_listing (
  app_id      text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Reviews from the App Store and Google Play (public texts and nicknames),
-- with day2's drafted reply and the backlog ticket a problem went into.
-- Kept for a year.
CREATE TABLE store_reviews (
  app_id      text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  store       text NOT NULL,
  review_id   text NOT NULL,
  created_at  timestamptz NOT NULL,
  rating      smallint NOT NULL,
  doc         jsonb NOT NULL,
  PRIMARY KEY (app_id, store, review_id)
);
CREATE INDEX store_reviews_recent ON store_reviews (app_id, created_at DESC);
