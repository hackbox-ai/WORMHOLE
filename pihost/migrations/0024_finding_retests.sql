-- 0024_finding_retests.sql — F04 Retest table。
CREATE TABLE IF NOT EXISTS finding_retests (
  id          BIGSERIAL PRIMARY KEY,
  finding_id  BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  agent_key   TEXT NOT NULL DEFAULT 'retester',
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- task_constraints
CREATE TABLE IF NOT EXISTS task_constraints (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
