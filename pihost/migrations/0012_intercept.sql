-- 0012_intercept.sql — F17 Interception Rules + F19 Approval record。
-- The order of rules is the priority; approval binding tool_call（B06 tool_approvals Built）。

CREATE TABLE IF NOT EXISTS intercept_rules (
  id            BIGSERIAL PRIMARY KEY,
  priority      INTEGER NOT NULL DEFAULT 0,
  tool_pattern  TEXT NOT NULL,
  param_pattern TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL DEFAULT 'allow',  -- allow | block | ask
  reason        TEXT NOT NULL DEFAULT '',
  judge_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
  timeout_action TEXT NOT NULL DEFAULT 'deny', -- judge/Approval timeout action
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
