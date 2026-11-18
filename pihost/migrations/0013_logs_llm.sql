-- 0013_logs_llm.sql — F20 Service Log + F07 LLM Recording/Dosage (control server_logs / llm_records / llm_usage）。

CREATE TABLE IF NOT EXISTS server_logs (
  seq    BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  level  TEXT NOT NULL DEFAULT 'info',
  tag    TEXT NOT NULL DEFAULT '',
  text   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS server_logs_ts_idx ON server_logs (ts DESC);

CREATE TABLE IF NOT EXISTS llm_usage (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT NOT NULL DEFAULT '',
  profile_id    BIGINT,
  business_kind TEXT NOT NULL DEFAULT '',
  business_id   TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS llm_usage_model_idx ON llm_usage (model, ts DESC);

CREATE TABLE IF NOT EXISTS llm_records (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT NOT NULL DEFAULT '',
  profile_id    BIGINT,
  business_kind TEXT NOT NULL DEFAULT '',
  business_id   TEXT NOT NULL DEFAULT '',
  request_text  TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  is_error      BOOLEAN NOT NULL DEFAULT FALSE,
  error_text    TEXT NOT NULL DEFAULT ''
);
