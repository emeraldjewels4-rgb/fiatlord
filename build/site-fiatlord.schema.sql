-- The one table the worker reads and writes (see SNAPSHOT_CREATE in
-- build/site-fiatlord.worker.js, which must stay identical to this).
--
-- Applying this is not required for the dashboard to work: the worker creates
-- the table itself on its first successful mirror write. Doing it up front
-- proves the DB binding before the first request, and leaves a fresh account
-- with the table in place instead of a schema that only appears after traffic.
--
--     npx wrangler d1 execute fiatlord-prices --remote \
--         --file build/site-fiatlord.schema.sql
--
-- An empty table is the expected state until the first live fetch: the probe
-- answers 502 with stored.present false and "no stored row", which is true.
CREATE TABLE IF NOT EXISTS price_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  prices TEXT NOT NULL
);
