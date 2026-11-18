-- Original db/schema.sql tool_usage; one call receipt before the catalog effect.
-- Historic target native calls retain counts; attribution remains NULL when unknown.
CREATE TABLE IF NOT EXISTS tool_usage (
 id BIGSERIAL PRIMARY KEY,ts TIMESTAMPTZ NOT NULL DEFAULT now(),
 tool_key TEXT NOT NULL,agent_key TEXT,task_id BIGINT,exploration_id BIGINT,
 intent_id BIGINT,session_id TEXT,legacy_tool_call_id BIGINT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_key,ts DESC);
CREATE INDEX IF NOT EXISTS idx_tool_usage_task ON tool_usage(task_id);
INSERT INTO tool_usage(ts,tool_key,legacy_tool_call_id)
 SELECT c.ts,c.tool_key,c.id FROM tool_calls c JOIN tools t ON t.key=c.tool_key
 WHERE c.native_tool_call_id IS NOT NULL
 ON CONFLICT(legacy_tool_call_id) DO NOTHING;
