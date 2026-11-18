-- Nullable activity text and usage counters.
-- Keep defaults for new Pi writes; preserve null when importing original rows.
ALTER TABLE conversation_activities ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE conversation_activities ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE conversation_activities ALTER COLUMN detail DROP NOT NULL;
ALTER TABLE conversation_activities ALTER COLUMN input_tokens DROP NOT NULL;
ALTER TABLE conversation_activities ALTER COLUMN output_tokens DROP NOT NULL;
