-- Original db/commands.go and db/llm_usage.go fields. Keep the early Pi-only
-- columns as legacy evidence; never fabricate raw HTTP bytes from their JSON.
ALTER TABLE llm_records ADD COLUMN profile_name text;
ALTER TABLE llm_records ADD COLUMN session_id text;
ALTER TABLE llm_records ADD COLUMN task_id text;
ALTER TABLE llm_records ADD COLUMN worker text;
ALTER TABLE llm_records ADD COLUMN latency_ms integer;
ALTER TABLE llm_records ADD COLUMN cache_read integer;
ALTER TABLE llm_records ADD COLUMN cache_write integer;
ALTER TABLE llm_records ADD COLUMN status text;
ALTER TABLE llm_records ADD COLUMN error text;
ALTER TABLE llm_records ADD COLUMN request_body text;
ALTER TABLE llm_records ADD COLUMN response_body text;
ALTER TABLE llm_records ADD COLUMN raw_request text;
ALTER TABLE llm_records ADD COLUMN raw_response text;
UPDATE llm_records r SET
 profile_name=(SELECT p.name FROM llm_profiles p WHERE p.id=r.profile_id),
 session_id=business_id,
 task_id=CASE WHEN business_kind IN ('task','worker','planner','mainagent') THEN
  COALESCE(substring(business_id from '^task-([0-9]+)(?:-|$)'),CASE WHEN business_id ~ '^[0-9]+$' THEN business_id END) END,
 worker=CASE WHEN business_kind IN ('worker','planner','mainagent','judge','goals') THEN business_kind END,
 status=CASE WHEN is_error THEN 'error' ELSE 'ok' END,error=NULLIF(error_text,''),
 request_body=NULLIF(request_text,''),response_body=NULLIF(response_text,'');
CREATE INDEX idx_llm_records_ts ON llm_records(ts);
CREATE INDEX idx_llm_records_session ON llm_records(session_id);

ALTER TABLE llm_usage ADD COLUMN task_id text;
ALTER TABLE llm_usage ADD COLUMN exploration_id bigint;
ALTER TABLE llm_usage ADD COLUMN worker text;
ALTER TABLE llm_usage ADD COLUMN profile_name text;
ALTER TABLE llm_usage ADD COLUMN latency_ms integer;
ALTER TABLE llm_usage ADD COLUMN status text;
UPDATE llm_usage u SET
 profile_name=(SELECT p.name FROM llm_profiles p WHERE p.id=u.profile_id),
 task_id=CASE WHEN business_kind IN ('task','worker','planner','mainagent') THEN
  COALESCE(substring(business_id from '^task-([0-9]+)(?:-|$)'),CASE WHEN business_id ~ '^[0-9]+$' THEN business_id END) END,
 worker=CASE WHEN business_kind IN ('worker','planner','mainagent','judge','goals') THEN business_kind END;
-- No historical latency/status/exploration id inference: those facts were not
-- recorded by the old writer. New calls supply explicit task registry identity.
CREATE INDEX idx_llm_usage_task ON llm_usage(task_id);
CREATE INDEX idx_llm_usage_model ON llm_usage(task_id,model);
CREATE INDEX idx_llm_usage_exp ON llm_usage(exploration_id);
