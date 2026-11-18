-- New recordings use one lossless compressed envelope. Legacy rows are read as-is.
-- No historical UPDATE, DELETE or table rewrite at startup.
ALTER TABLE llm_records ADD COLUMN body_storage bytea;
ALTER TABLE llm_records ADD COLUMN body_codec text;
ALTER TABLE llm_records ADD COLUMN body_raw_bytes integer;
ALTER TABLE llm_records ADD COLUMN body_sha256 text;
-- The application already compresses this envelope; avoid a second TOAST codec.
ALTER TABLE llm_records ALTER COLUMN body_storage SET STORAGE EXTERNAL;
ALTER TABLE llm_records ADD CONSTRAINT llm_record_body_valid CHECK (
  (body_storage IS NULL AND body_codec IS NULL AND body_raw_bytes IS NULL AND body_sha256 IS NULL)
  OR
  (body_storage IS NOT NULL AND body_codec IS NOT NULL AND body_codec IN ('identity','gzip','zstd')
   AND body_raw_bytes IS NOT NULL AND body_raw_bytes BETWEEN 0 AND 268435456
   AND body_sha256 IS NOT NULL AND body_sha256 ~ '^[0-9a-f]{64}$')
);
