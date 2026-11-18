-- 0018_conv_align.sql — Session fields, activity ownership and exploration node owners。
--
-- Difference record（B03-table-mapping.md Synchronization）：
-- - conversations.pinned(bool) is the target side historical deviation → Alignment pinned_at TIMESTAMPTZ（bool Delete after data migration）
-- - conversation_activities Added executor, tool call and cache usage fields；
--   ts Change name created_at；seq Reserved as target internal sort key

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
UPDATE conversations SET pinned_at = now() WHERE pinned = TRUE AND pinned_at IS NULL;
ALTER TABLE conversations DROP COLUMN IF EXISTS pinned;

ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS worker TEXT;
ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS tool TEXT;
ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS tool_use_id TEXT;
ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
ALTER TABLE conversation_activities ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
ALTER TABLE conversation_activities RENAME COLUMN ts TO created_at;

-- exploration_nodes.owner
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
