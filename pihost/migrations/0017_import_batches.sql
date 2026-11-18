-- 0017_import_batches.sql — P5 Import batches and sources→Target ID Mapping（owner Fifth round of acceptance requirements）。
-- Attribution determination only allows import_id_map Explicit logging; rollback by batch + Foreign key order deletion, name prohibited/Time/Fuzzy matching。

CREATE TABLE IF NOT EXISTS import_batches (
  id          BIGSERIAL PRIMARY KEY,
  source_label TEXT NOT NULL,           -- Source ID
  status      TEXT NOT NULL DEFAULT 'active',  -- active | rolled_back
  counts      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_label)
);

CREATE TABLE IF NOT EXISTS import_id_map (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,            -- tasks | explorations | exploration_nodes | assets | findings | conversations | conversation_activities
  src_id      TEXT NOT NULL,            -- Source library primary key (textual, compatible bigint/text）
  dst_id      TEXT NOT NULL,            -- Target library primary key
  UNIQUE (table_name, src_id, batch_id)
);
CREATE INDEX IF NOT EXISTS import_id_map_batch_idx ON import_id_map (batch_id, table_name);
