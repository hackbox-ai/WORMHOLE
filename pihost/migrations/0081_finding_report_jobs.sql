ALTER TABLE findings ADD COLUMN report_status text NOT NULL DEFAULT 'basic';
ALTER TABLE findings ADD COLUMN report_quality jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE findings ADD COLUMN report_updated_at timestamptz;
UPDATE findings SET report_status='completed' WHERE btrim(report)<>'' AND report NOT LIKE '%Compiled based on registered evidence. Scope of influence%';
CREATE TABLE finding_report_jobs(
 id bigserial PRIMARY KEY,
 finding_id bigint NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 evidence_version bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','completed','needs_evidence','failed','cancelled','superseded')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
 lease_token text,
 lease_until timestamptz,
 base_report_hash text NOT NULL DEFAULT '',
 draft text NOT NULL DEFAULT '',
 assessment jsonb NOT NULL DEFAULT '{}'::jsonb,
 checks jsonb NOT NULL DEFAULT '{}'::jsonb,
 gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
 progress text NOT NULL DEFAULT '',
 error text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(finding_id,evidence_version)
);
CREATE INDEX finding_report_pending ON finding_report_jobs(next_attempt_at,id) WHERE state='pending';
CREATE TABLE finding_report_reads(
 job_id bigint NOT NULL REFERENCES finding_report_jobs(id) ON DELETE CASCADE,
 attempt integer NOT NULL,
 ref text NOT NULL,
 body_hash text NOT NULL,
 bytes integer NOT NULL,
 PRIMARY KEY(job_id,attempt,ref)
);
CREATE TABLE finding_report_versions(
 id bigserial PRIMARY KEY,
 finding_id bigint NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 evidence_version bigint NOT NULL,
 body text NOT NULL,
 body_hash text NOT NULL,
 source text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(finding_id,body_hash)
);
CREATE FUNCTION queue_finding_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('wormhole.finding_report_restore',true)='on' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' OR NEW.evidence_version<>OLD.evidence_version THEN
  INSERT INTO finding_report_jobs(finding_id,evidence_version) VALUES(NEW.id,NEW.evidence_version) ON CONFLICT DO NOTHING;
  UPDATE finding_report_jobs SET state='superseded',updated_at=now(),finished_at=now()
   WHERE finding_id=NEW.id AND evidence_version<>NEW.evidence_version AND state IN('pending','running');
  UPDATE findings SET report_status='pending' WHERE id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_report_insert AFTER INSERT ON findings FOR EACH ROW EXECUTE FUNCTION queue_finding_report();
CREATE TRIGGER finding_report_evidence AFTER UPDATE OF evidence_version ON findings FOR EACH ROW
 WHEN(OLD.evidence_version IS DISTINCT FROM NEW.evidence_version) EXECUTE FUNCTION queue_finding_report();
CREATE FUNCTION retain_finding_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.report IS DISTINCT FROM NEW.report AND btrim(OLD.report)<>'' THEN
  INSERT INTO finding_report_versions(finding_id,evidence_version,body,body_hash,source)
   VALUES(OLD.id,OLD.report_evidence_version,OLD.report,md5(OLD.report),'previous') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_report_history BEFORE UPDATE OF report ON findings FOR EACH ROW EXECUTE FUNCTION retain_finding_report();
-- Fixed report jobs replace the built-in report_finding trigger. Do not wake
-- historical test tasks or change any unrelated user trigger.
UPDATE agent_triggers SET enabled=false WHERE agent_key='reporter' AND on_tool_call AND tool_names::jsonb='["report_finding"]'::jsonb
 AND tool_call_message='A vulnerability has just been report_finding Registration. read return JSON of finding_id（Vulnerability record ID）and finding_node_id（Explore nodes ID），Use get_task_node_detail Read the node and use get_finding_traffic(finding_id) Read the evidence list and version（Empty list is OK). Written based on original evidence and execution records including overview, impact, reproduction steps, and evidence、PoC、Root cause and repair suggestions in English Markdown Report. No evidence may be fabricated or the target re-attacked. last call update_finding_report(finding_id=finding_node_id,report,evidence_version=Actual read version) Save; do not mix two numbers。';
