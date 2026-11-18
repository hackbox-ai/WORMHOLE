-- Immutable creation notices, committed atomically with the actual finding.
CREATE TABLE finding_alerts (
 id bigserial PRIMARY KEY,
 finding_id bigint NOT NULL UNIQUE REFERENCES findings(id) ON DELETE CASCADE,
 task_id bigint NOT NULL,
 name text NOT NULL,severity text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 insert_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX finding_alerts_xid ON finding_alerts(insert_xid,id);
CREATE FUNCTION capture_finding_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.task_id IS NOT NULL AND NEW.task_id>0 THEN
  INSERT INTO finding_alerts(finding_id,task_id,name,severity) VALUES(NEW.id,NEW.task_id,NEW.name,NEW.severity);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_alert_created AFTER INSERT ON findings FOR EACH ROW EXECUTE FUNCTION capture_finding_alert();
