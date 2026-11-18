ALTER TABLE assets ADD COLUMN IF NOT EXISTS fingerprint_technologies text[] NOT NULL DEFAULT '{}';
CREATE TABLE fingerprint_rules (
 id text PRIMARY KEY, family text NOT NULL CHECK(family IN('ehole','goby','wappalyzer','fingers','fingerprinthub','arl')),
 name text NOT NULL, raw jsonb NOT NULL, builtin boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true, compile_status text NOT NULL DEFAULT 'pending', compile_reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fingerprint_rules_family ON fingerprint_rules(family,name);
CREATE TABLE fingerprint_snapshots(id text PRIMARY KEY,rules jsonb NOT NULL,diagnostics jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE task_fingerprint_state (
 task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 snapshot_id text NOT NULL REFERENCES fingerprint_snapshots(id), revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fingerprint_materials (
 id text PRIMARY KEY,task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 asset_id bigint REFERENCES assets(id) ON DELETE SET NULL,intent_id bigint,identity_key text NOT NULL,
 url text NOT NULL,method text NOT NULL,status integer NOT NULL,response_sha256 text NOT NULL,
 response_base64 text NOT NULL, favicon_base64 text NOT NULL DEFAULT '',favicon_sha256 text NOT NULL DEFAULT '',source text NOT NULL DEFAULT 'http_request',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fingerprint_materials_task ON fingerprint_materials(task_id,url,created_at DESC);
CREATE TABLE fingerprint_jobs (
 id bigserial PRIMARY KEY,material_id text NOT NULL REFERENCES fingerprint_materials(id) ON DELETE CASCADE,
 snapshot_id text NOT NULL REFERENCES fingerprint_snapshots(id),state text NOT NULL DEFAULT 'pending',
 error text NOT NULL DEFAULT '',missing_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(material_id,snapshot_id)
);
CREATE INDEX fingerprint_jobs_pending ON fingerprint_jobs(state,id);
CREATE TABLE fingerprint_observations (
 id bigserial PRIMARY KEY,job_id bigint NOT NULL REFERENCES fingerprint_jobs(id) ON DELETE CASCADE,
 rule_id text NOT NULL,family text NOT NULL,product text NOT NULL,version text NOT NULL DEFAULT '',
 locations jsonb NOT NULL,evidence text NOT NULL,state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,rule_id)
);
INSERT INTO app_settings(key,value) VALUES('fingerprint_enabled','true') ON CONFLICT(key) DO NOTHING;
