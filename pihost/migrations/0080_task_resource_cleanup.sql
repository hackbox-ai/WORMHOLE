CREATE TABLE task_resource_paths (
 task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('sessions','runtime')),
 path text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,kind,path)
);
CREATE TABLE task_resource_cleanup_runs (
 id uuid PRIMARY KEY,
 task_id bigint NOT NULL,
 state text NOT NULL CHECK(state IN('preview','running','completed','partial','interrupted')),
 categories jsonb NOT NULL,
 manifest jsonb NOT NULL,
 fingerprint text NOT NULL,
 expires_at timestamptz NOT NULL,
 progress jsonb NOT NULL DEFAULT '{}'::jsonb,
 result jsonb,
 error text,
 requested_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX task_resource_cleanup_task ON task_resource_cleanup_runs(task_id,requested_at DESC);
ALTER TABLE llm_records ADD COLUMN workspace_cleaned_at timestamptz;

CREATE INDEX llm_records_task_resource_idx ON llm_records(task_id,id) WHERE workspace_cleaned_at IS NULL;
