-- One-time grants for the WORMHOLE methodology bundle. Subsequent startup never
-- regrants a removed binding and never edits operator prompts or MCP grants.
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_settings WHERE key='wormhole_methodology_seed_v1' AND value='true') THEN
  INSERT INTO agent_visibility(agent_key,resource_kind,resource_id)
  SELECT a.key,'skill',v.skill
  FROM (VALUES
   ('auto','wormhole-task-intake'),('mainagent','wormhole-task-intake'),
   ('goals','wormhole-test-plan'),('planner','wormhole-test-plan'),
   ('worker','wormhole-test-method'),('pentest','wormhole-test-method'),
   ('worker','wormhole-src-review'),('pentest','wormhole-src-review'),
   ('reporter','wormhole-finding-report'),('retester','wormhole-retest')
  ) AS v(agent_key,skill) JOIN agents a ON a.key=v.agent_key
  ON CONFLICT DO NOTHING;
  INSERT INTO app_settings(key,value) VALUES('wormhole_methodology_seed_v1','true')
  ON CONFLICT(key) DO UPDATE SET value='true';
 END IF;
END $$;
