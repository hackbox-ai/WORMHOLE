-- Activity and main-session read models.
CREATE TABLE activity (
 id BIGSERIAL PRIMARY KEY,
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 node_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
 worker TEXT, kind TEXT, tool TEXT, tool_use_id TEXT,
 is_error BOOLEAN NOT NULL DEFAULT false, summary TEXT, detail TEXT,
 metadata JSONB NOT NULL DEFAULT '{}',
 input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), main_seg INTEGER
);
CREATE INDEX idx_act_node ON activity(exploration_id,node_id,id);
CREATE INDEX idx_act_since ON activity(exploration_id,id);
CREATE INDEX idx_act_worker ON activity(exploration_id,worker,id);
CREATE INDEX idx_act_main_seg ON activity(exploration_id,main_seg,id) WHERE worker='mainagent';
CREATE INDEX idx_act_tool_call ON activity(exploration_id,tool_use_id,id) WHERE kind IN('tool_use','tool_result');
CREATE INDEX idx_act_result_usage ON activity(exploration_id) INCLUDE(input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) WHERE kind='result';
CREATE INDEX idx_act_latest ON activity(exploration_id,created_at DESC);
CREATE TABLE main_sessions (
 exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(exploration_id,seq)
);
-- Projection ownership is internal. No global cursor can skip a delayed commit
-- or a dead letter restored after a newer event has already been committed.
CREATE TABLE pi_activity_projected (event_seq BIGINT PRIMARY KEY REFERENCES business_events(seq) ON DELETE CASCADE);
CREATE TABLE pi_activity_capture (run_id TEXT PRIMARY KEY, next_ordinal INTEGER NOT NULL DEFAULT 0, state JSONB NOT NULL DEFAULT '{}');
CREATE INDEX business_events_activity_idx ON business_events(seq) WHERE payload ? '_activity';
