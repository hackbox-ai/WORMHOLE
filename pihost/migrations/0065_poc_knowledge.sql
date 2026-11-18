CREATE TABLE poc_sources (
 key text PRIMARY KEY, title text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 current_revision text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poc_source_revisions (
 id text PRIMARY KEY, source_key text NOT NULL REFERENCES poc_sources(key),
 provenance jsonb NOT NULL, diagnostics jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poc_entries (
 id text PRIMARY KEY, revision_id text NOT NULL REFERENCES poc_source_revisions(id),
 source_key text NOT NULL REFERENCES poc_sources(key), native_id text NOT NULL, content_hash text NOT NULL,
 title text NOT NULL, products text[] NOT NULL, cves text[] NOT NULL, severity text NOT NULL,
 kind text NOT NULL, description text NOT NULL, conditions text NOT NULL,
 refs jsonb NOT NULL, requirements jsonb NOT NULL, diagnostics jsonb NOT NULL,
 raw text NOT NULL, metadata jsonb NOT NULL, UNIQUE(revision_id,native_id)
);
CREATE INDEX poc_entries_revision ON poc_entries(revision_id);
CREATE INDEX poc_entries_products ON poc_entries USING gin(products);
CREATE TABLE poc_entry_overrides (
 entry_id text PRIMARY KEY REFERENCES poc_entries(id), enabled boolean NOT NULL DEFAULT true,
 version_range text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poc_product_aliases (alias text PRIMARY KEY, product text NOT NULL);
CREATE TABLE poc_snapshots (
 id text PRIMARY KEY, sources jsonb NOT NULL, aliases jsonb NOT NULL, overrides jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_poc_state (
 task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, snapshot_id text NOT NULL REFERENCES poc_snapshots(id),
 fingerprint_revision bigint NOT NULL DEFAULT -1, revision bigint NOT NULL DEFAULT 0, planner_revision bigint NOT NULL DEFAULT 0,
 settlement_deadline_at timestamptz, settlement_outcome text NOT NULL DEFAULT '', completion_requested boolean NOT NULL DEFAULT false,
 gaps jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poc_candidates (
 id bigserial PRIMARY KEY, task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 entry_id text NOT NULL REFERENCES poc_entries(id), match_key text NOT NULL,
 asset_id bigint, url text NOT NULL, identity_key text NOT NULL, product text NOT NULL, version text NOT NULL,
 observation_ids bigint[] NOT NULL, applicability text NOT NULL, reason text NOT NULL,
 active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,match_key)
);
CREATE INDEX poc_candidates_task ON poc_candidates(task_id,active,id);
CREATE TABLE poc_deliveries (
 id bigserial PRIMARY KEY, task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 intent_id bigint, recipient text NOT NULL, revision bigint NOT NULL, candidate_ids bigint[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX poc_delivery_once ON poc_deliveries(task_id,recipient,COALESCE(intent_id,0),revision);
