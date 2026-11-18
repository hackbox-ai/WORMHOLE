CREATE TABLE workspace_cleanup_runs (
  id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  actor text NOT NULL DEFAULT 'WORMHOLE',
  state text NOT NULL CHECK (state IN ('running','completed','partial','failed','interrupted')),
  paths jsonb NOT NULL,
  task_ids bigint[] NOT NULL DEFAULT '{}',
  manifest jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  error text NOT NULL DEFAULT ''
);
CREATE INDEX workspace_cleanup_runs_requested_idx ON workspace_cleanup_runs(requested_at DESC);
