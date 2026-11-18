ALTER TABLE task_efficiency_state ADD COLUMN IF NOT EXISTS base_total bigint NOT NULL DEFAULT 0;
ALTER TABLE task_efficiency_state ADD COLUMN IF NOT EXISTS review_active_seconds double precision NOT NULL DEFAULT 0;
ALTER TABLE task_efficiency_state ADD COLUMN IF NOT EXISTS review_signature text NOT NULL DEFAULT '';
ALTER TABLE task_efficiency_state ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0;
