-- Original db/schema.sql startup placeholder. Never overwrite an existing datasource.
INSERT INTO mcp_servers(name,transport,url,env,enabled)
VALUES('ScopeSentry','http','', '{"X-API-Key":""}'::jsonb,false)
ON CONFLICT(name) DO NOTHING;
