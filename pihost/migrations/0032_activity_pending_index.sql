-- Bound each live projection scan to pending work, rather than all prior steps.
ALTER TABLE business_events ADD COLUMN activity_projected BOOLEAN NOT NULL DEFAULT false;
UPDATE business_events SET activity_projected=true WHERE seq IN(SELECT event_seq FROM pi_activity_projected);
DROP INDEX business_events_activity_idx;
CREATE INDEX business_events_activity_idx ON business_events(seq) WHERE payload ? '_activity' AND NOT activity_projected;
