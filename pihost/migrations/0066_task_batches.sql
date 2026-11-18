CREATE TABLE task_batches (
 id uuid PRIMARY KEY,
 request_hash text NOT NULL,
 name text NOT NULL DEFAULT '',
 total integer NOT NULL,
 timeout_seconds integer NOT NULL CHECK(timeout_seconds BETWEEN 60 AND 86400),
 fingerprint_snapshot text,
 poc_snapshot text,
 paused boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN batch_id uuid REFERENCES task_batches(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN batch_position integer;
ALTER TABLE tasks ADD COLUMN target_input text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN execution_mode text NOT NULL DEFAULT 'goal' CHECK(execution_mode IN('goal','continuous'));
ALTER TABLE tasks ADD COLUMN worker_limit integer;
ALTER TABLE tasks ADD COLUMN discovery_finish_request jsonb;
CREATE UNIQUE INDEX tasks_batch_position ON tasks(batch_id,batch_position) WHERE batch_id IS NOT NULL;
CREATE INDEX tasks_batch_queue ON tasks(queued_at,id) WHERE queued AND NOT paused AND deleted_at IS NULL;
INSERT INTO app_settings(key,value) VALUES('settings.batch_task_timeout_seconds','1800') ON CONFLICT DO NOTHING;
INSERT INTO tools(key,system,description,schema,agents,enabled,kind) VALUES('finish_discovery',true,'The continuous mining task submits a coverage review with actual basis and requests the host to close it.。','{}','["planner"]',true,'builtin') ON CONFLICT DO NOTHING;
INSERT INTO tool_defaults(key,description,schema,agents) SELECT key,description,schema,agents FROM tools WHERE key='finish_discovery' ON CONFLICT DO NOTHING;
