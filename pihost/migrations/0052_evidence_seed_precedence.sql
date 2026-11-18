-- 0051 inserted missing host rows ahead of the dedicated evidence seeder.
-- Repair only rows provably created by that transaction and never subsequently
-- edited. Existing user binding/disable/description/schema/exec edits stay intact.
UPDATE tools t SET agents=s.agents,updated_at=now()
FROM (VALUES
('get_finding_traffic','["auto", "reporter", "worker", "planner", "mainagent", "pentest"]'::jsonb),('bind_finding_traffic','["reporter"]'::jsonb),('update_finding_report','["auto", "reporter"]'::jsonb)) AS s(key,agents),tool_defaults d,schema_migrations m
WHERE t.key=s.key AND d.key=t.key AND m.name='0051_platform_tool_defaults.sql'
AND t.created_at=m.applied_at AND t.updated_at=t.created_at
AND t.system=TRUE AND t.enabled=TRUE AND t.kind='builtin' AND t.deferred=FALSE AND t.exec='{}'::jsonb
AND t.description=d.description AND t.schema=d.schema
AND t.agents=CASE WHEN t.key='bind_finding_traffic' THEN '["reporter","auto"]'::jsonb ELSE '["auto"]'::jsonb END;
