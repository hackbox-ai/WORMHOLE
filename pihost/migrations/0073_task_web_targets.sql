-- User-declared Web targets shared by browser authorization and intake.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS web_targets JSONB NOT NULL DEFAULT '[]'::jsonb;
