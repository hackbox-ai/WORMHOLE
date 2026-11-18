-- Existing artifacts remain readable; only new large artifacts use seekable frames.
ALTER TABLE storage_artifacts ADD COLUMN layout text NOT NULL DEFAULT 'body-v1'
  CHECK(layout IN ('body-v1','frames-v2'));
ALTER TABLE storage_artifacts ADD COLUMN manifest_sha256 text;
ALTER TABLE storage_artifacts ADD CONSTRAINT storage_artifacts_manifest_check
  CHECK((layout='body-v1' AND manifest_sha256 IS NULL) OR (layout='frames-v2' AND manifest_sha256 ~ '^[a-f0-9]{64}$' AND manifest_sha256 IS NOT NULL));
CREATE INDEX storage_artifacts_hash_idx ON storage_artifacts(hash,created_at);
ALTER TABLE llm_usage ADD COLUMN performance jsonb;
ALTER TABLE llm_usage ADD CONSTRAINT llm_usage_performance_object_check
  CHECK(performance IS NULL OR jsonb_typeof(performance)='object');
