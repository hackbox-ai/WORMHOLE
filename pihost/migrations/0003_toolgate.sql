-- 0003_toolgate.sql — B06 Tool/Approval gate persistence layer。
-- The iron law of execution sequence（RUNBOOK §2）：Visibility → Parameter verification → Interception Strategy → Manual approval → Execute → Audit。
-- Approval Binding run/tool_call，The status is clear after restarting（pending/Approved/executed/denied/timeout/cancelled），
-- Execute at most once after approval（executor Use executed Mark idempotent）。

CREATE TABLE IF NOT EXISTS tool_calls (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_kind TEXT NOT NULL,
  business_id   TEXT NOT NULL,
  run_id        TEXT,
  tool_key      TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB,
  is_error      BOOLEAN NOT NULL DEFAULT FALSE,
  error_text    TEXT,
  approval_id   BIGINT
);

CREATE INDEX IF NOT EXISTS tool_calls_business_idx
  ON tool_calls (business_kind, business_id, id);

CREATE TABLE IF NOT EXISTS tool_approvals (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  tool_call_id  BIGINT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','denied','timeout','cancelled','executed')),
  reason        TEXT,
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT
);
