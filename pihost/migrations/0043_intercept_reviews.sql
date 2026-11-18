-- Canonical original approval history; tool_calls/tool_approvals remain internal execution records.
-- Preserve existing saved rule values; only align defaults for future raw/imported rows.
ALTER TABLE intercept_rules ALTER COLUMN timeout_enabled SET DEFAULT TRUE;
ALTER TABLE intercept_rules ALTER COLUMN timeout_seconds SET DEFAULT 60;
CREATE TABLE intercept_pending (
 id BIGSERIAL PRIMARY KEY,
 rule_id BIGINT REFERENCES intercept_rules(id) ON DELETE SET NULL,
 conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
 task_id TEXT, agent_name TEXT NOT NULL DEFAULT '', tool_name TEXT NOT NULL,
 tool_input JSONB NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','allowed','denied','timeout')),
 reason TEXT NOT NULL DEFAULT '', decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 audit JSONB, decision_source TEXT NOT NULL DEFAULT '',
 tool_call_id BIGINT UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE
);
CREATE INDEX idx_intercept_pending_status ON intercept_pending(status,created_at DESC);
CREATE INDEX idx_intercept_pending_task ON intercept_pending(task_id,created_at DESC);
-- Historical origin/correlation cannot be inferred from a business_id string.
INSERT INTO intercept_pending(tool_call_id,tool_name,tool_input,status,reason,decided_at,created_at,decision_source)
 SELECT a.tool_call_id,c.tool_key,c.params,CASE a.status WHEN 'approved' THEN 'allowed' WHEN 'executed' THEN 'allowed' WHEN 'cancelled' THEN 'denied' ELSE a.status END,
 COALESCE(a.reason,''),a.decided_at,a.ts,'unknown' FROM tool_approvals a JOIN tool_calls c ON c.id=a.tool_call_id
 ON CONFLICT(tool_call_id) DO NOTHING;
