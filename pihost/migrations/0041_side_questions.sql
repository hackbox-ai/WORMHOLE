-- 0041_side_questions.sql — F02 Bypass question (compare with original db/schema.sql §side_question_* + v3 Additional columns）
-- Session snapshots are unique by parent key; request by (session_key,generation,client_id) Idempotent；
-- At most one row per key in run (partially unique index）；generation When clearing +1 and reset memory。

CREATE TABLE IF NOT EXISTS side_question_sessions (
    session_key    TEXT PRIMARY KEY,
    conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id        BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
    exploration_id BIGINT REFERENCES explorations(id) ON DELETE CASCADE,
    intent_id      BIGINT REFERENCES exploration_nodes(id) ON DELETE CASCADE,
    run_id         BIGINT NOT NULL,
    version        BIGINT NOT NULL,
    snapshot       JSONB NOT NULL,
    generation     BIGINT NOT NULL DEFAULT 0,
    memory         JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK ((conversation_id IS NOT NULL AND task_id IS NULL AND exploration_id IS NULL AND intent_id IS NULL)
        OR (conversation_id IS NULL AND task_id IS NOT NULL AND exploration_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_side_sessions_conv ON side_question_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_task ON side_question_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_exp ON side_question_sessions(exploration_id);
CREATE INDEX IF NOT EXISTS idx_side_sessions_intent ON side_question_sessions(intent_id);

CREATE TABLE IF NOT EXISTS side_question_requests (
    id          TEXT PRIMARY KEY,
    ordinal     BIGSERIAL UNIQUE,
    session_key TEXT NOT NULL REFERENCES side_question_sessions(session_key) ON DELETE CASCADE,
    generation  BIGINT NOT NULL,
    client_id   TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
    error       TEXT NOT NULL DEFAULT '',
    model       JSONB NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sequence    BIGINT NOT NULL DEFAULT 0,
    usage       JSONB NOT NULL DEFAULT '{}'::jsonb,
    context_info JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(session_key,generation,client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_side_request_running ON side_question_requests(session_key) WHERE status='running';
CREATE INDEX IF NOT EXISTS idx_side_requests_history ON side_question_requests(session_key,ordinal DESC);
