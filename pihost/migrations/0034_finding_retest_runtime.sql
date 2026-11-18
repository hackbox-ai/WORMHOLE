-- Original retest history/ownership model; preserve old registration rows.
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_status_check;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report_evidence_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE finding_retests ADD COLUMN conversation_id BIGINT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE finding_retests ADD COLUMN verdict TEXT NOT NULL DEFAULT '' CHECK(verdict IN('','reproduced','fixed','inconclusive'));
ALTER TABLE finding_retests ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE finding_retests ADD COLUMN snapshot JSONB NOT NULL DEFAULT '{}';
ALTER TABLE finding_retests ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE finding_retests ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
ALTER TABLE finding_retests ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE finding_retests ADD COLUMN started_at TIMESTAMPTZ;
ALTER TABLE finding_retests ADD COLUMN finished_at TIMESTAMPTZ;
UPDATE finding_retests SET finished_at=completed_at WHERE completed_at IS NOT NULL;
UPDATE finding_retests SET status='stopped',error='The old retest registration did not create a running session, please re-initiate',finished_at=now()
 WHERE conversation_id IS NULL AND status IN('pending','running');
ALTER TABLE finding_retests ADD CONSTRAINT finding_retests_status_check CHECK(status IN('pending','running','completed','failed','stopped'));
CREATE INDEX idx_finding_retests_history ON finding_retests(finding_id,id DESC);
CREATE UNIQUE INDEX idx_finding_retests_active ON finding_retests(finding_id) WHERE status IN('pending','running');
CREATE FUNCTION stop_deleted_conversation_retest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE finding_retests SET status='stopped',error='Retest session deleted',finished_at=now()
 WHERE conversation_id=OLD.id AND status IN('pending','running');
 RETURN OLD;
END; $$;
CREATE TRIGGER trg_conversation_retest_delete BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION stop_deleted_conversation_retest();
