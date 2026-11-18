-- Persistent model health and circuit-breaker state.
-- Retain the earlier llm_pool_health table as legacy data: its string state has
-- no faithful mapping to original fails/trips/open_until counters.
CREATE TABLE llm_profile_health (
 profile_id BIGINT PRIMARY KEY REFERENCES llm_profiles(id) ON DELETE CASCADE,
 fails INTEGER NOT NULL DEFAULT 0,
 trips INTEGER NOT NULL DEFAULT 0,
 open_until TIMESTAMPTZ,
 last_error TEXT,
 last_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
