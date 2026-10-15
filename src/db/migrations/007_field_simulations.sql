-- day2's scheduled simulation (simulation.ts): the latest run per app.
CREATE TABLE field_simulations (
  app_id  text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  run     jsonb NOT NULL,
  at      timestamptz NOT NULL
);
