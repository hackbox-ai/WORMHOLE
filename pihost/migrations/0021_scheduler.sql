-- 0021_scheduler.sql — F12 Trigger persistent water level Input fields and compatible columns for。
CREATE TABLE IF NOT EXISTS scheduler_state (
  agent_key     TEXT PRIMARY KEY,
  last_fired_at TIMESTAMPTZ,
  next_fire_at  TIMESTAMPTZ
);
