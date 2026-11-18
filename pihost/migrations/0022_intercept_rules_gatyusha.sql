-- intercept_rules Input fields and compatible columns。
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS match_target TEXT NOT NULL DEFAULT 'tool_name';
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'regex';
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS pattern TEXT NOT NULL DEFAULT '';
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS timeout_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS timeout_action TEXT NOT NULL DEFAULT '';
-- Compatible with old tool_pattern/param_pattern，Rule management uses current input fields。
ALTER TABLE intercept_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE intercept_rules ALTER COLUMN tool_pattern DROP NOT NULL;
ALTER TABLE intercept_rules ALTER COLUMN param_pattern DROP NOT NULL;
ALTER TABLE intercept_rules ALTER COLUMN reason DROP NOT NULL;
