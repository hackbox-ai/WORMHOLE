-- Per-task model quota chain, independent of the global pool.
CREATE TABLE task_llm_profiles (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL REFERENCES llm_profiles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN('ready','quota_exhausted')),
  last_error TEXT,
  exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,profile_id), UNIQUE(task_id,position)
);
CREATE INDEX idx_task_llm_profiles_order ON task_llm_profiles(task_id,position);
CREATE INDEX idx_task_llm_profiles_profile ON task_llm_profiles(profile_id,task_id);
INSERT INTO task_llm_profiles(task_id,profile_id,position)
  SELECT t.id,t.llm_profile_id,0 FROM tasks t JOIN llm_profiles p ON p.id=t.llm_profile_id
  WHERE t.llm_profile_id IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE tasks t SET active_llm_profile_id=t.llm_profile_id
  WHERE t.active_llm_profile_id IS NULL AND EXISTS(SELECT 1 FROM task_llm_profiles x WHERE x.task_id=t.id AND x.profile_id=t.llm_profile_id);
