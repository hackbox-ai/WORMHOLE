-- 0045_reporter_metadata.sql
-- Restore the WORMHOLE reporter card text only when it is still blank.
UPDATE agents
SET description='Writing a detailed vulnerability report: automatically triggered when a vulnerability is discovered, and written after checking the evidence and execution process Markdown Report and write back。', updated_at=now()
WHERE key='reporter' AND coalesce(description,'')='';
