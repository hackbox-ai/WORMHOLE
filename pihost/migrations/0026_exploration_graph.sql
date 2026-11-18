-- Graph edges, asset provenance and typed node states.
-- Internal task_id/title/lease columns remain for the Pi scheduler.
ALTER TABLE exploration_nodes DROP CONSTRAINT IF EXISTS task_intents_status_check;
ALTER TABLE exploration_nodes DROP CONSTRAINT IF EXISTS exploration_nodes_state_check;
ALTER TABLE exploration_nodes ADD CONSTRAINT ck_node_kind
  CHECK (kind IN ('begin','goal','intent','fact','finding','hint','digest')) NOT VALID;
ALTER TABLE exploration_nodes ADD CONSTRAINT ck_node_state CHECK (
  (kind='begin' AND state='open') OR
  (kind='intent' AND state IN ('open','running','paused','done','blocked','exhausted','stopped','deleted','failed')) OR
  (kind='goal' AND state IN ('open','met','abandoned')) OR
  (kind='fact' AND state IN ('confirmed','dismissed','origin')) OR
  (kind='finding' AND state IN ('confirmed','dismissed')) OR
  (kind='hint' AND state IN ('active','consumed')) OR
  (kind='digest' AND state IN ('active','superseded'))
) NOT VALID;
CREATE TABLE exploration_edges (
  exploration_id BIGINT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
  src_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  dst_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('spawns','derived_from','yields','proves','covers')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(exploration_id,src_id,rel,dst_id), CHECK(src_id<>dst_id)
);
CREATE INDEX idx_expedges_src ON exploration_edges(src_id,rel);
CREATE INDEX idx_expedges_dst ON exploration_edges(dst_id,rel);
CREATE TABLE exploration_anchors (
  node_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY(node_id,asset_id)
);
CREATE INDEX idx_anchor_asset ON exploration_anchors(asset_id);
ALTER TABLE task_constraints ADD COLUMN exploration_id BIGINT REFERENCES explorations(id) ON DELETE CASCADE;
ALTER TABLE task_constraints ADD COLUMN kind TEXT NOT NULL DEFAULT 'deny' CHECK(kind IN ('allow','deny'));
ALTER TABLE task_constraints ADD COLUMN origin TEXT;
ALTER TABLE task_constraints ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE task_constraints c SET exploration_id=t.exploration_id FROM tasks t WHERE c.task_id=t.id;
-- Backfill missing exploration references without fabricating goals/evidence/edges.
DO $$ DECLARE t RECORD; e BIGINT; BEGIN
  FOR t IN SELECT id,goal,description FROM tasks WHERE exploration_id IS NULL LOOP
    INSERT INTO explorations(goal,description) VALUES(t.goal,t.description) RETURNING id INTO e;
    UPDATE tasks SET exploration_id=e WHERE id=t.id;
  END LOOP;
END $$;
UPDATE exploration_nodes n SET exploration_id=t.exploration_id FROM tasks t WHERE n.task_id=t.id AND n.exploration_id IS NULL;
ALTER TABLE tool_calls ADD COLUMN native_tool_call_id TEXT;
CREATE TABLE task_relations (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,source_task_id), CHECK(task_id<>source_task_id)
);
CREATE INDEX idx_task_relations_source ON task_relations(source_task_id);
