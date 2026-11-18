-- 0001_init.sql — B01 Skeleton minimum persistence layer。
-- business_events Yes B07 The starting point of the persistent event ledger：SSE Press (business_kind,
-- business_id, seq) cursor Replay；Pi JSONL Session is not used as the only business ledger。
-- pi_session_map Yes B04 of Pi session ↔ Business object mapping starting point。
-- The complete data dictionary is in B03 Continue to expand this directory after landing。

CREATE TABLE IF NOT EXISTS business_events (
  seq           BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_kind TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS business_events_cursor_idx
  ON business_events (business_kind, business_id, seq);

CREATE TABLE IF NOT EXISTS pi_session_map (
  id            BIGSERIAL PRIMARY KEY,
  pi_session_id TEXT NOT NULL UNIQUE,
  business_kind TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  work_dir      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_kind, business_id)
);
