-- Vulnerability intelligence lookups (NVD / OSV / GitHub) with a shared cache.
CREATE TABLE IF NOT EXISTS intel_cache (
  key        text PRIMARY KEY,
  payload    jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS intel_cache_expiry ON intel_cache(expires_at);
