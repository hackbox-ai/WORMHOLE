-- 0006_agents.sql — F12 Agent。
-- Built-in role seed and application startup idempotent supplement（goals/planner/mainagent/worker/auto/pentest/reporter/retester）。

CREATE TABLE IF NOT EXISTS agents (
  id                            BIGSERIAL PRIMARY KEY,
  key                           TEXT NOT NULL UNIQUE,
  name                          TEXT NOT NULL DEFAULT '',
  description                   TEXT NOT NULL DEFAULT '',
  role                          TEXT NOT NULL DEFAULT 'assistant',
  builtin                       BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                       BOOLEAN NOT NULL DEFAULT TRUE,
  llm_profile_id                BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
  max_turns                     INTEGER NOT NULL DEFAULT 0,
  run_seconds                   INTEGER NOT NULL DEFAULT 600,
  web_search                    BOOLEAN NOT NULL DEFAULT FALSE,
  interactive_shell             BOOLEAN NOT NULL DEFAULT FALSE,
  wrapup_prompt                 TEXT NOT NULL DEFAULT '',
  wrapup_max_turns              INTEGER NOT NULL DEFAULT 0,
  task_timeout_wrapup_prompt    TEXT NOT NULL DEFAULT '',
  task_timeout_wrapup_max_turns INTEGER NOT NULL DEFAULT 0,
  trigger_run_mode              TEXT NOT NULL DEFAULT 'serial',
  trigger_merge_mode            TEXT NOT NULL DEFAULT 'all',
  trigger_max_parallel          INTEGER NOT NULL DEFAULT 5,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_prompts (
  id         BIGSERIAL PRIMARY KEY,
  agent_key  TEXT NOT NULL REFERENCES agents(key) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  prompt     TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_key, version)
);

CREATE TABLE IF NOT EXISTS agent_triggers (
  id               BIGSERIAL PRIMARY KEY,
  agent_key        TEXT NOT NULL REFERENCES agents(key) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  interval_sec     INTEGER NOT NULL DEFAULT 0,
  on_finding       BOOLEAN NOT NULL DEFAULT FALSE,
  on_goal_met      BOOLEAN NOT NULL DEFAULT FALSE,
  on_task_timeout  BOOLEAN NOT NULL DEFAULT FALSE,
  on_tool_call     BOOLEAN NOT NULL DEFAULT FALSE,
  on_task_create   BOOLEAN NOT NULL DEFAULT FALSE,
  interval_message TEXT NOT NULL DEFAULT '',
  finding_message  TEXT NOT NULL DEFAULT '',
  goal_message     TEXT NOT NULL DEFAULT '',
  timeout_message  TEXT NOT NULL DEFAULT '',
  toolcall_message TEXT NOT NULL DEFAULT '',
  taskcreate_message TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_visibility (
  id            BIGSERIAL PRIMARY KEY,
  agent_key     TEXT NOT NULL,
  resource_kind TEXT NOT NULL,   -- mcp | tool | skill
  resource_id   TEXT NOT NULL,
  UNIQUE (agent_key, resource_kind, resource_id)
);

CREATE TABLE IF NOT EXISTS agent_variables (
  agent_key TEXT NOT NULL,
  name      TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  UNIQUE (agent_key, name)
);

-- Built-in role seed (compare to baseline /api/agents Empty database echo）
INSERT INTO agents (key, name, description, role, builtin) VALUES
  ('goals',    'Target Teardown', 'Break down the penetration mission goal into several independent and verifiable sub-goals。', 'goals',     TRUE),
  ('planner',  'Planning',     '', 'planner', TRUE),
  ('mainagent','Main',       '', 'main',    TRUE),
  ('worker',   'Execute',     '', 'worker',  TRUE),
  ('auto',     'Auto',     '', 'assistant', TRUE),
  ('pentest',  'Penetration Testing', '', 'assistant', TRUE),
  ('reporter', 'Report Writing', '', 'assistant', TRUE),
  ('retester', 'Vulnerability retest', '', 'assistant', TRUE)
ON CONFLICT (key) DO NOTHING;
