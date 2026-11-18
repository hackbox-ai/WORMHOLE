-- 0008_mcp.sql — F13 MCP。

CREATE TABLE IF NOT EXISTS mcp_servers (
  id        BIGSERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL DEFAULT 'stdio',  -- stdio | http
  command   TEXT NOT NULL DEFAULT '',
  args      JSONB NOT NULL DEFAULT '[]'::jsonb,
  env       JSONB NOT NULL DEFAULT '{}'::jsonb,
  url       TEXT NOT NULL DEFAULT '',
  enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  insecure  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_tools_cache (
  server_id BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema    JSONB NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, name)
);
