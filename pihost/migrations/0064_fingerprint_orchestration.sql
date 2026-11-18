
ALTER TABLE task_fingerprint_state ADD COLUMN bootstrap_started_at timestamptz,
 ADD COLUMN bootstrap_finished_at timestamptz, ADD COLUMN bootstrap_state text NOT NULL DEFAULT 'pending',
 ADD COLUMN planner_revision bigint NOT NULL DEFAULT 0, ADD COLUMN settlement_deadline_at timestamptz,
 ADD COLUMN completion_requested boolean NOT NULL DEFAULT false, ADD COLUMN settlement_outcome text NOT NULL DEFAULT '', ADD COLUMN gaps jsonb NOT NULL DEFAULT '{}';
CREATE TABLE fingerprint_task_entries (
 task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,url text NOT NULL,
 state text NOT NULL DEFAULT 'pending',http_status integer,tool_call_id bigint,error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(task_id,url)
);
CREATE TABLE fingerprint_deliveries (
 id bigserial PRIMARY KEY,task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 intent_id bigint,recipient text NOT NULL,revision bigint NOT NULL,observation_ids bigint[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fingerprint_delivery_once ON fingerprint_deliveries(task_id,recipient,COALESCE(intent_id,0),revision);
