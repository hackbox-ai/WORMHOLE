ALTER TABLE task_planner_recovery
  ADD COLUMN failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN work_revision TEXT NOT NULL DEFAULT '',
  ADD COLUMN strategy TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN last_outcome TEXT NOT NULL DEFAULT '',
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN history JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN message TEXT NOT NULL DEFAULT '';
UPDATE task_planner_recovery SET failures=CASE WHEN blocked OR attempts>=2 THEN 2 ELSE attempts END,
  strategy=CASE WHEN blocked OR attempts>=2 THEN 'single_gap' ELSE 'compact' END,
  blocked=FALSE,attempts=0,last_outcome='length',next_attempt_at=now();
