-- Batch creation previously hard-coded this override; no batch worker override
-- API existed. NULL restores the same global settings.workers inheritance as
-- ordinary tasks, including queued/paused batches after an upgrade.
UPDATE tasks SET worker_limit=NULL WHERE batch_id IS NOT NULL AND worker_limit=1;
