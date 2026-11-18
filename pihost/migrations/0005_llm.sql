-- 0005_llm.sql — F11 LLM profiles。
-- api_key Only warehousing without echoing (application layer guarantees）；is_default Always the head of the failover chain。

CREATE TABLE IF NOT EXISTS llm_profiles (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  format             TEXT NOT NULL DEFAULT 'anthropic',
  base_url           TEXT NOT NULL DEFAULT '',
  proxy              TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  api_key            TEXT NOT NULL DEFAULT '',
  api_key_hint       TEXT NOT NULL DEFAULT '',
  rate_per_second    DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_per_minute    DOUBLE PRECISION NOT NULL DEFAULT 0,
  context_window_k   INTEGER NOT NULL DEFAULT 0,
  thinking_type      TEXT NOT NULL DEFAULT '',
  reasoning_effort   TEXT NOT NULL DEFAULT '',
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  priority           INTEGER NOT NULL DEFAULT 0,
  pool_exclude       BOOLEAN NOT NULL DEFAULT FALSE,
  streaming          BOOLEAN NOT NULL DEFAULT TRUE,
  max_tokens         INTEGER NOT NULL DEFAULT 0,
  max_tokens_field   TEXT NOT NULL DEFAULT '',
  session_header_key TEXT NOT NULL DEFAULT '',
  retry              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_profiles_name_idx ON llm_profiles (name);

CREATE TABLE IF NOT EXISTS llm_pool_health (
  profile_id BIGINT PRIMARY KEY REFERENCES llm_profiles(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'ok', -- ok | degraded | down
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
