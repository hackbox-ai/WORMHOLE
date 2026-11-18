-- F12: original trigger fields plus independent persisted event watermarks.
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS task_timeout_message TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS tool_call_message TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS task_create_message TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS tool_names TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS last_fire TIMESTAMPTZ;
UPDATE agent_triggers SET task_timeout_message=timeout_message WHERE task_timeout_message='' AND timeout_message<>'';
UPDATE agent_triggers SET tool_call_message=toolcall_message WHERE tool_call_message='' AND toolcall_message<>'';
UPDATE agent_triggers SET task_create_message=taskcreate_message WHERE task_create_message='' AND taskcreate_message<>'';
CREATE TABLE IF NOT EXISTS scheduler_watermarks(key TEXT PRIMARY KEY,value TEXT NOT NULL);
-- Legacy scheduler_state remains an interval read model. Its per-Agent timestamps
-- cannot represent source finding/tool/goal cursors or per-trigger last_fire.
