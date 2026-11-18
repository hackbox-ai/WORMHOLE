-- 0009_skills.sql — F14 Skill usage Ledger。
-- Skill The ontology is in the file system（skillDir/<name>/SKILL.md frontmatter + Resource file）。

CREATE TABLE IF NOT EXISTS skill_usage (
  id        BIGSERIAL PRIMARY KEY,
  skill     TEXT NOT NULL,
  agent_key TEXT NOT NULL DEFAULT '',
  business_kind TEXT NOT NULL DEFAULT '',
  business_id   TEXT NOT NULL DEFAULT '',
  ts        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_usage_idx ON skill_usage (skill, id);
