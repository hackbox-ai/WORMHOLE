-- Cold payloads retain ledger identities and projection receipts. File publication
-- and pointer replacement commit together; the original event bytes stay in frames.
CREATE TABLE storage_event_archives (
  id text PRIMARY KEY,
  task_id bigint,
  first_seq bigint NOT NULL,
  last_seq bigint NOT NULL,
  rows integer NOT NULL CHECK (rows > 0),
  raw_bytes bigint NOT NULL,
  stored_bytes bigint NOT NULL,
  raw_hash text NOT NULL,
  manifest_hash text NOT NULL,
  codec text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business_events ADD COLUMN cold_archive_id text REFERENCES storage_event_archives(id);
CREATE INDEX business_events_cold_pending_idx ON business_events(business_id text_pattern_ops,seq)
  WHERE event_type='message_update' AND cold_archive_id IS NULL;
CREATE INDEX business_events_cold_archive_idx ON business_events(cold_archive_id,seq) WHERE cold_archive_id IS NOT NULL;

CREATE TABLE worker_handoffs (
  intent_id bigint PRIMARY KEY REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  checkpoint jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_artifacts (
  task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  intent_id bigint NOT NULL DEFAULT 0,
  hash text NOT NULL,
  raw_bytes bigint NOT NULL,
  stored_bytes bigint NOT NULL,
  codec text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,intent_id,hash)
);
CREATE TABLE storage_maintenance_state (
  job text PRIMARY KEY,
  last_success_at timestamptz,
  last_error text,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE storage_recording_failures (
  record_id bigint PRIMARY KEY REFERENCES llm_records(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM tools WHERE key IN('save_worker_checkpoint','read_worker_handoff','read_worker_artifact') AND system=FALSE) THEN
    RAISE EXCEPTION 'Worker storage tool name conflicts with an existing custom tool';
  END IF;
END $$;
INSERT INTO tools(key,description,schema,agents,enabled,system,kind) VALUES
('save_worker_checkpoint','Save this Short structured handover status for Worker ; only progress, next step, blocking and evidence references saved。',
 '{"type":"object","additionalProperties":false,"properties":{"progress":{"type":"string","maxLength":2000},"next_step":{"type":"string","maxLength":2000},"blockers":{"type":"string","maxLength":1000},"evidence_ids":{"type":"array","maxItems":32,"items":{"type":"integer","minimum":1}}},"required":["progress","next_step"]}',
 '["worker"]',TRUE,TRUE,'builtin'),
('read_worker_handoff','Read this Worker ’s latest tasks, constraints, handover status, and evidence citations; large text press section and offset Pagination。',
 '{"type":"object","additionalProperties":false,"properties":{"section":{"type":"string","enum":["overview","goal","intent"]},"offset":{"type":"integer","minimum":0}}}',
 '["worker"]',TRUE,TRUE,'builtin'),
('read_worker_artifact','To read the losslessly saved tool results of this task according to the character range, use nextOffset Continue。',
 '{"type":"object","additionalProperties":false,"properties":{"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":16000}},"required":["hash"]}',
 '["worker"]',TRUE,TRUE,'builtin') ON CONFLICT(key) DO NOTHING;
INSERT INTO tool_defaults(key,description,schema,agents)
 SELECT key,description,schema,agents FROM tools WHERE key IN('save_worker_checkpoint','read_worker_handoff','read_worker_artifact') AND system=TRUE ON CONFLICT(key) DO NOTHING;
