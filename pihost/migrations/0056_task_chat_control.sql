-- Task-scoped controls; existing role bindings and user configuration remain intact.
INSERT INTO tools(key,system,description,schema,agents,kind) VALUES
 ('pause_current_task',TRUE,'Pause execution of current task, retain conversation to summarize existing findings。','{"type":"object","properties":{},"additionalProperties":false}','["mainagent"]','builtin'),
 ('stop_current_task',TRUE,'Stop the execution of the current task, retain the generated findings and evidence, and continue to summarize。','{"type":"object","properties":{},"additionalProperties":false}','["mainagent"]','builtin')
ON CONFLICT(key) DO NOTHING;
CREATE INDEX IF NOT EXISTS business_events_activity_run_idx ON business_events((payload->'_activity'->>'runId'),seq)
 WHERE payload ? '_activity' AND NOT activity_projected;
INSERT INTO tool_defaults(key,description,schema,agents)
 SELECT key,description,schema,agents FROM tools WHERE key IN('pause_current_task','stop_current_task') AND system=TRUE
 ON CONFLICT(key) DO NOTHING;
