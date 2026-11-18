-- 0011_conversations.sql — F02 Dialogue。
-- and tasks activity（business_events kind=task/worker）Source separation; messages per session seq Increment。

CREATE TABLE IF NOT EXISTS conversations (
  id             BIGSERIAL PRIMARY KEY,
  agent_key      TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT 'New conversation',
  pinned         BOOLEAN NOT NULL DEFAULT FALSE,
  llm_profile_id BIGINT REFERENCES llm_profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_activities (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,             -- user | assistant | usage | error
  summary         TEXT NOT NULL DEFAULT '',
  detail          TEXT NOT NULL DEFAULT '',
  is_error        BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
