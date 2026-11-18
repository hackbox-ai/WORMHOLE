--
-- Restore WORMHOLE agent metadata, MCP defaults, and destructive-operation guards.
-- Existing user settings and custom rows are preserved; only absent rows are inserted.

UPDATE agents SET
  description = CASE WHEN coalesce(description,'')='' THEN CASE key
    WHEN 'planner' THEN 'Read the situation, determine the target, and only add exploration intentions when there are new directions that are not covered (one planning cycle for each task）。'
    WHEN 'mainagent' THEN 'Human-computer interface: observe progress and implement human intentions hint or high priority intent。'
    WHEN 'worker' THEN 'Receive an intention to execute and put the discovered facts/Stop after the vulnerability is written back to the knowledge graph。'
    WHEN 'auto' THEN 'Platform Operation Assistant: Use Tools to Manage Tasks(Build/Look/Pause/Give tips)with assets and can be created/Modification skill、Custom tools、MCP。'
    WHEN 'pentest' THEN 'Independent Penetration agent：One person from reconnaissance→Find the attack surface→In-depth utilization→Verification→Finish the entire chain, plan by yourself, execute by yourself, and verify by yourself against each other。'
    ELSE description
  END ELSE description END,
  builtin = CASE WHEN key IN ('reporter','retester') THEN FALSE ELSE TRUE END,
  updated_at = now()
WHERE key IN ('goals','planner','mainagent','worker','auto','pentest','reporter','retester');

-- WORMHOLE ships browser MCP disabled by default; visibility is granted to all built-in agents.
INSERT INTO mcp_servers(name, transport, command, args, env, enabled)
SELECT 'browser','stdio','npx','["@playwright/mcp","--headless"]'::jsonb,'{}'::jsonb,false
WHERE NOT EXISTS (SELECT 1 FROM mcp_servers WHERE name='browser');

INSERT INTO agent_visibility(agent_key,resource_kind,resource_id)
SELECT a.key,'mcp',m.id::text
FROM agents a CROSS JOIN mcp_servers m
WHERE a.key IN ('goals','planner','mainagent','worker','auto','pentest','reporter','retester')
  AND m.name IN ('ScopeSentry','browser')
  AND NOT EXISTS (
    SELECT 1 FROM agent_visibility v
    WHERE v.agent_key=a.key AND v.resource_kind='mcp' AND v.resource_id=m.id::text
  )
ON CONFLICT (agent_key,resource_kind,resource_id) DO NOTHING;

-- api-recon is the shipped skill visible by default to these three WORMHOLE agents.
INSERT INTO agent_visibility(agent_key,resource_kind,resource_id)
SELECT a.key,'skill','api-recon'
FROM agents a
WHERE a.key IN ('auto','pentest','worker')
  AND NOT EXISTS (
    SELECT 1 FROM agent_visibility v
    WHERE v.agent_key=a.key AND v.resource_kind='skill' AND v.resource_id='api-recon'
  )
ON CONFLICT (agent_key,resource_kind,resource_id) DO NOTHING;

WITH defaults(name,priority,match_target,match_type,pattern,action,message,enabled) AS (VALUES
  ('[Built-in] Recursive forced deletion rm -rf',100,'tool_input','regex',$$(?i)\brm\b.{0,80}(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive|--no-preserve-root)$$,'deny','Disable recursive force delete（rm -rf / rm --recursive），May permanently damage the system or drone environment',true),
  ('[Built-in] Delete system key directory',100,'tool_input','regex',$$ \brm\b[^"'\n]{0,60}["'\s](/|/etc|/bin|/usr|/boot|/var|/lib|/sys|/proc|/dev|/sbin|/root)$$,'deny','Disable deletion of system critical paths',true),
  ('[Built-in] Disk format mkfs',100,'tool_input','regex',$$ \bmkfs\b$$,'deny','Disable formatting of disk（mkfs）',true),
  ('[Built-in] Overwriting disk device dd',100,'tool_input','regex',$$ \bdd\b[^|\n]{0,100}\bof=\s*/dev/[a-zA-Z]$$,'deny','Use prohibited dd Overwriting disk device',true),
  ('[Built-in] Fork Bomb',100,'tool_input','regex',$$ :\(\)\s*\{[^}]*:\|:$$,'deny','Execution prohibited Fork Bomb',true),
  ('[Built-in] Shutdown / Restart',100,'tool_input','regex',$$ \b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b$$,'deny','Disable execution of shutdown or restart commands',true),
  ('[Built-in] Kill all processes',100,'tool_input','regex',$$ \bkill\s+-9\s+-1\b|\bkillall\s+-9\b$$,'deny','Prohibited kill -9 -1 or killall -9（Kill all processes）',true),
  ('[Built-in] Disk Wipe shred / wipe',100,'tool_input','regex',$$ \b(?:shred|wipe)\b[^|\n]{0,80}/dev/[a-zA-Z]$$,'deny','Disable execution on disk device shred/wipe Erase',true),
  ('[Built-in] Clear firewall rules',100,'tool_input','regex',$$ \biptables\s+(?:-F|--flush)\b|\bnft\s+flush\s+ruleset\b$$,'deny','Disable clearing of firewall rules（iptables -F / nft flush）',true),
  ('[Built-in] SQL DROP DATABASE / TABLE / SCHEMA',90,'tool_input','regex',$$(?i)\bDROP\s+(?:DATABASE|TABLE|SCHEMA|INDEX|VIEW|TABLESPACE|USER|ROLE)\b$$,'deny','Execution prohibited DROP Operation, may irreversibly destroy database objects',true),
  ('[Built-in] SQL TRUNCATE',90,'tool_input','regex',$$(?i)\bTRUNCATE\s+(?:TABLE\s+)?\w$$,'deny','Execution prohibited TRUNCATE，It is possible to clear all data in the data table',true),
  ('[Built-in] MongoDB drop / dropDatabase',90,'tool_input','regex',$$(?i)\.(?:dropDatabase|dropCollection|drop)\s*\($$,'deny','Execution prohibited MongoDB drop Actions',true),
  ('[Built-in] Redis FLUSHALL / FLUSHDB',90,'tool_input','regex',$$(?i)\b(?:FLUSHALL|FLUSHDB)\b$$,'deny','Execution prohibited Redis FLUSHALL / FLUSHDB，Possibility of clearing all cached data',true),
  ('[Built-in] curl / wget Send DELETE Request',80,'tool_input','regex',$$(?i)\bcurl\b[^|\n&;"]{0,300}(?:-X\s*DELETE|--request\s+DELETE|-XDELETE)|\bwget\b[^|\n&;"]{0,300}--method[=\s]+DELETE$$,'deny','Pass prohibited curl/wget Send HTTP DELETE Request that target system data may be deleted',true),
  ('[Built-in] Python HTTP Client DELETE（requests/httpx/aiohttp）',80,'tool_input','regex',$$(?i)\b(?:requests|httpx|aiohttp|urllib\.request)\.delete\s*\(|session\.delete\s*\(|client\.delete\s*\($$,'deny','Use prohibited Python HTTP Client sends DELETE Request',true),
  ('[Built-in] Statement in script HTTP DELETE Method（JS/General）',80,'tool_input','regex',$$(?i)axios\.delete\s*\(|method\s*[:=]\s*['"]DELETE['"]$$,'deny','Disable declaring and sending in scripts HTTP DELETE Request',true),
  ('[Built-in] Batch clear / Clear interface path',80,'tool_input','regex',$$(?i)/(?:clear|wipe|flush|purge|truncate|drop|destroy|factory[-_]reset|reset[-_]all)(?:[/?#"'\s]|$)$$,'deny','It is forbidden to call batch clearing or destroying class interfaces（/clear /wipe /flush /purge etc.）',true),
  ('[Built-in] Destructive system commands',100,'tool_input','regex',$$(?i)\b(rm\s+-rf\s+/|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*/dev/sd)$$,'deny','Destructive command rejected（rm -rf / / mkfs / dd / fork bomb / Shut down and restart / Overwriting disk device）',true),
  ('[Built-in] Data leakage pipeline',80,'tool_input','regex',$$(?i)(curl|wget|nc|ncat)\b[^|]*\b(\|\s*(curl|wget|nc))$$,'deny','The suspected data leakage pipeline was rejected (the command output was curl/wget/nc Side story）',false),
  ('[Built-in] Remove class interface path',80,'tool_input','regex',$$(?i)/(?:(?:delete|remove|unlink|erase|destroy)[-\w]*|del)(?:[/?#"'\s]|$)$$,'deny','It is forbidden to call the delete class interface（/delete /remove /unlink /erase etc.), regardless of which HTTP Method—Delete interface for most applications GET/POST will be triggered, and the target data will also be truly deleted.',true)
)
INSERT INTO intercept_rules(name,enabled,priority,match_target,match_type,pattern,action,message,timeout_enabled,timeout_seconds,timeout_action)
SELECT d.name,d.enabled,d.priority,d.match_target,d.match_type,btrim(d.pattern),d.action,d.message,false,60,'deny'
FROM defaults d
WHERE NOT EXISTS (SELECT 1 FROM intercept_rules r WHERE r.name=d.name);
