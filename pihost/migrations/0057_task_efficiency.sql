CREATE TABLE IF NOT EXISTS task_efficiency_state (
 task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 progress_signature text NOT NULL DEFAULT '', plan_signature text NOT NULL DEFAULT '',
 round_progress text NOT NULL DEFAULT '', empty_rounds integer NOT NULL DEFAULT 0,
 last_progress_at timestamptz NOT NULL DEFAULT now(), last_tick_at timestamptz NOT NULL DEFAULT now(),
 active_seconds double precision NOT NULL DEFAULT 0,
 base_calls integer NOT NULL DEFAULT 0, base_output bigint NOT NULL DEFAULT 0, paused_reason text
);
ALTER TABLE exploration_edges DROP CONSTRAINT IF EXISTS exploration_edges_rel_check;
ALTER TABLE exploration_edges ADD CONSTRAINT exploration_edges_rel_check CHECK(rel IN('spawns','derived_from','yields','proves','covers','resolves'));
CREATE INDEX IF NOT EXISTS llm_usage_task_efficiency_idx ON llm_usage(task_id);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS preflight_ms integer;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS execution_ms integer;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS finished_at timestamptz;
CREATE INDEX IF NOT EXISTS exploration_intent_fingerprint_idx ON exploration_nodes(task_id,(payload->>'execution_fingerprint')) WHERE kind='intent';
CREATE INDEX IF NOT EXISTS exploration_fact_fingerprint_idx ON exploration_nodes(task_id,(payload->>'evidence_fingerprint')) WHERE kind='fact';
INSERT INTO tools(key,description,schema,agents,enabled,system,kind)
VALUES('resolve_goal','Use facts to record negative tests or insufficient conditions; do not treat negative results as confirmation of vulnerabilities。',
 '{"type":"object","properties":{"goal_id":{"type":"integer"},"evidence_id":{"type":"integer"},"outcome":{"type":"string","enum":["tested_negative","blocked"]},"reason":{"type":"string"}},"required":["goal_id","evidence_id","outcome","reason"]}',
 '["planner","mainagent"]',TRUE,TRUE,'builtin') ON CONFLICT(key) DO NOTHING;
INSERT INTO tool_defaults(key,description,schema,agents)
 SELECT key,description,schema,agents FROM tools WHERE key='resolve_goal' AND system=TRUE ON CONFLICT(key) DO NOTHING;
