-- asset_intercept_rules Field：kind/pattern/note/builtin。
ALTER TABLE asset_intercept_rules ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '';
ALTER TABLE asset_intercept_rules ADD COLUMN IF NOT EXISTS pattern TEXT NOT NULL DEFAULT '';
ALTER TABLE asset_intercept_rules ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE asset_intercept_rules ADD COLUMN IF NOT EXISTS builtin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE asset_intercept_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Copy old column value
UPDATE asset_intercept_rules SET kind = scope_kind, pattern = value WHERE kind = '';
ALTER TABLE task_intercept_rules ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '';
ALTER TABLE task_intercept_rules ADD COLUMN IF NOT EXISTS pattern TEXT NOT NULL DEFAULT '';
UPDATE task_intercept_rules SET kind = scope_kind, pattern = value WHERE kind = '';
