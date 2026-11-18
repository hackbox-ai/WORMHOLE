-- 0002_tasks.sql — B05 Equivalent task host core table。
--
-- Task status created/running/paused/done/failed/timeout + Independent queued/paused Boolean bit；
-- Intent open/running/blocked/exhausted/stopped；Collect and go CAS（UPDATE ... WHERE status='open'）。
-- Initial fields of mission and intent; subsequent versions will add the complete structure。

CREATE TABLE IF NOT EXISTS tasks (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  goal          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'created'
                CHECK (status IN ('created','running','paused','done','failed','timeout')),
  queued        BOOLEAN NOT NULL DEFAULT FALSE,
  paused        BOOLEAN NOT NULL DEFAULT FALSE,
  llm_profile   TEXT,
  heartbeat_s   INTEGER NOT NULL DEFAULT 600,   -- Application layer lower limit 600s（normalizeHeartbeat），History DDL Default value and application layer lower limit exist 300/600 Difference
  deadline_at   TIMESTAMPTZ,
  first_run_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_intents (
  id            BIGSERIAL PRIMARY KEY,
  task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','running','blocked','exhausted','stopped','done','failed')),
  priority      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  claimed_at    TIMESTAMPTZ,
  heartbeat_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_intents_claim_idx
  ON task_intents (task_id, status, priority DESC, id);
