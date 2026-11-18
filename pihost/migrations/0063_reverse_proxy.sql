-- Add a JS reverse-engineering proxy registry (transparent crypto proxy).
-- Also removes the abandoned capability-v1 registry: its tables are empty and
-- its tool rows would otherwise remain as dead entries in the tool catalog.
DELETE FROM tool_defaults WHERE key IN ('prepare_reverse_target','find_request_capabilities',
  'request_reverse_capability','register_request_capability','verify_request_capability',
  'transform_payload','capability_http_request','http_request_bytes');
DELETE FROM tools WHERE system=TRUE AND key IN ('prepare_reverse_target','find_request_capabilities',
  'request_reverse_capability','register_request_capability','verify_request_capability',
  'transform_payload','capability_http_request','http_request_bytes');
DROP TABLE IF EXISTS capability_invocations, capability_dependencies, reverse_jobs,
  capability_validations, target_capabilities, reverse_targets;

CREATE TABLE reverse_proxies (
 id UUID PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 intent_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
 origin TEXT NOT NULL,
 method TEXT NOT NULL,
 path TEXT NOT NULL,
 listen_port INTEGER NOT NULL,
 pid INTEGER,
 status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN('starting','running','stopped','failed')),
 usage TEXT NOT NULL,
 script_path TEXT NOT NULL,
 log_path TEXT,
 error TEXT,
 fact_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 stopped_at TIMESTAMPTZ
);
CREATE INDEX reverse_proxies_task_status ON reverse_proxies(task_id,status);
-- At most one live proxy per task and interface: the planner must not fan out
-- duplicate reverse work for the same endpoint.
CREATE UNIQUE INDEX reverse_proxies_live_scope ON reverse_proxies(task_id,origin,method,path)
 WHERE status IN('starting','running');
