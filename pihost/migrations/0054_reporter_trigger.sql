-- Restore the missing finding -> reporter execution edge exactly once.
-- An intentionally deleted/disabled trigger is preserved on later restarts.
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_settings WHERE key='reporter_trigger_seed_pihost_v1' AND value='true') THEN
  IF EXISTS(SELECT 1 FROM agents WHERE key='reporter') AND NOT EXISTS(SELECT 1 FROM agent_triggers WHERE agent_key='reporter') THEN
   UPDATE agents SET builtin=FALSE,trigger_run_mode='parallel',trigger_merge_mode='none',trigger_max_parallel=5 WHERE key='reporter';
   UPDATE tools SET agents=agents||'"reporter"'::jsonb WHERE key IN('update_finding_report','get_task_node_detail','list_task_findings','get_task_worker_trace','list_task_worker_traces','search_task_worker_traces','get_task_graph','get_finding_traffic') AND NOT agents @> '["reporter"]'::jsonb;
   INSERT INTO agent_triggers(agent_key,enabled,on_tool_call,tool_names,tool_call_message)
   VALUES('reporter',TRUE,TRUE,'["report_finding"]','A vulnerability has just been report_finding Registration. read return JSON of finding_id（Vulnerability record ID）and finding_node_id（Explore nodes ID），Use get_task_node_detail Read the node and use get_finding_traffic(finding_id) Read the evidence list and version（Empty list is OK). Written based on original evidence and execution records including overview, impact, reproduction steps, and evidence、PoC、Root cause and repair suggestions in English Markdown Report. No evidence may be fabricated or the target re-attacked. last call update_finding_report(finding_id=finding_node_id,report,evidence_version=Actual read version) Save; do not mix two numbers。');
  END IF;
  INSERT INTO app_settings(key,value) VALUES('reporter_trigger_seed_pihost_v1','true') ON CONFLICT(key) DO UPDATE SET value='true';
 END IF;
END $$;
