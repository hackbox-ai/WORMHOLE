-- 0004：Event ledger idempotent rewriting + app_settings KV（Authentication and F21 System configuration shared，
-- Unification settings Key value configuration table。

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DLQ Complement idempotent: unique event_uid，ON CONFLICT DO NOTHING
ALTER TABLE business_events ADD COLUMN IF NOT EXISTS event_uid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS business_events_uid_idx ON business_events (event_uid);
ALTER TABLE business_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'session';
