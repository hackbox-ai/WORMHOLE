-- 0007_tools.sql — F15 Tool Catalog。
-- Built-in tools key/handler At the code level; this table only saves the editable side of the page (description/schema Documentation/agent Binding/Switch）。

CREATE TABLE IF NOT EXISTS tools (
  key         TEXT PRIMARY KEY,
  system      BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL DEFAULT '',
  schema      JSONB NOT NULL DEFAULT '{}'::jsonb,
  agents      JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  kind        TEXT NOT NULL DEFAULT 'builtin',   -- builtin | command | script | http
  exec        JSONB NOT NULL DEFAULT '{}'::jsonb, -- Custom tool execution specifications
  deferred    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Built-in core seed
INSERT INTO tools (key, system, description, agents, kind) VALUES
  ('bash',        TRUE, 'Execute shell Command', '["worker","auto"]', 'builtin'),
  ('read_file',   TRUE, 'Read file',        '["worker","planner","auto"]', 'builtin'),
  ('write_file',  TRUE, 'Write file',        '["worker","auto"]', 'builtin'),
  ('list_dir',    TRUE, 'List directory',        '["worker","planner","auto"]', 'builtin'),
  ('insert_assets', TRUE, 'Asset storage (go F18 Gate）', '["worker"]', 'builtin'),
  ('submit_debrief', TRUE, 'Submit task summary',  '["worker","mainagent"]', 'builtin')
ON CONFLICT (key) DO NOTHING;
