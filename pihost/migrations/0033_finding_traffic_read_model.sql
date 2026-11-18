-- Traffic metadata tables; capture and blobs are managed by the traffic service.
CREATE TABLE IF NOT EXISTS traffic_evidence_snapshots (
 id TEXT PRIMARY KEY, source_traffic_id TEXT NOT NULL, captured_at BIGINT NOT NULL,
 url TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL,
 content_type TEXT NOT NULL DEFAULT '', req_head TEXT NOT NULL, resp_head TEXT NOT NULL,
 req_hash TEXT NOT NULL, resp_hash TEXT NOT NULL, req_len BIGINT NOT NULL, resp_len BIGINT NOT NULL,
 unreferenced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finding_traffic_bindings (
 id BIGSERIAL PRIMARY KEY, finding_id BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 snapshot_id TEXT NOT NULL REFERENCES traffic_evidence_snapshots(id),
 role TEXT NOT NULL DEFAULT 'supporting', note TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(finding_id,snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_traffic_order ON finding_traffic_bindings(finding_id,position,id);
CREATE INDEX IF NOT EXISTS idx_finding_traffic_snapshot ON finding_traffic_bindings(snapshot_id);
