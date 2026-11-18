-- 0016_align_closure.sql — Unify fields and associations for assets, tasks, intents and discoveries。
-- See details file/implementation/B03-table-mapping.md。

-- ── tasks ──
ALTER TABLE tasks RENAME COLUMN title TO name;
ALTER TABLE tasks RENAME COLUMN heartbeat_s TO plan_heartbeat_seconds;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_id BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS exploration_id BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS queue_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS active_llm_profile_id BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS llm_chain_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_ref TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS coverage_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
-- source_task_id → parent_ref（Type change: Move data first and then delete old columns）
UPDATE tasks SET parent_ref = source_task_id::text WHERE parent_ref IS NULL AND source_task_id IS NOT NULL;
ALTER TABLE tasks DROP COLUMN IF EXISTS source_task_id;

-- ── explorations（Task→Exploration map; intention=exploration_nodes） ──
CREATE TABLE IF NOT EXISTS explorations (
  id          BIGSERIAL PRIMARY KEY,
  description TEXT,
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  round_no    BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- task_intents → exploration_nodes
ALTER TABLE task_intents RENAME TO exploration_nodes;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS exploration_id BIGINT;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'intent';
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS delete_reason TEXT;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS cold_since_round BIGINT;
ALTER TABLE exploration_nodes ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
-- The intent status field is unified as state。
ALTER TABLE exploration_nodes RENAME COLUMN status TO state;
-- Backfilling tasks: one for each task exploration
DO $$
DECLARE t RECORD; e BIGINT;
BEGIN
  FOR t IN SELECT id, goal FROM tasks WHERE exploration_id IS NULL LOOP
    INSERT INTO explorations (goal) VALUES (t.goal) RETURNING id INTO e;
    UPDATE tasks SET exploration_id = e WHERE id = t.id;
    UPDATE exploration_nodes SET exploration_id = e WHERE task_id = t.id AND exploration_id IS NULL;
  END LOOP;
END $$;

-- ── assets ──
ALTER TABLE assets RENAME COLUMN kind TO type;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS company_source TEXT NOT NULL DEFAULT 'explicit';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS task_ids BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS root_domain TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS c_segment CIDR;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS port INTEGER;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS icp TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS bound_domains TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS open_ports JSONB[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS record_type TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS record_value TEXT[];
ALTER TABLE assets ADD COLUMN IF NOT EXISTS bundle_id TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS app_name TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS app_description TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS app_icp TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS service_type TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS favicon_mmh3 TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS status_code INTEGER;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS content_length BIGINT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS page_title TEXT;
-- Use partial unique index by asset type, replacing old (type,value) Globally unique index。
DROP INDEX IF EXISTS assets_dedup_idx;
CREATE UNIQUE INDEX IF NOT EXISTS assets_root_domain_uidx ON assets (domain) WHERE type = 'root_domain' AND domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assets_ip_uidx ON assets (ip) WHERE type = 'ip' AND ip IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assets_url_uidx ON assets (url) WHERE type = 'url' AND url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assets_domain_uidx ON assets (domain) WHERE type = 'domain' AND domain IS NOT NULL;
-- Existing row backfill type column
UPDATE assets SET domain = value WHERE type IN ('domain','root_domain') AND domain IS NULL;
UPDATE assets SET ip = value WHERE type = 'ip' AND ip IS NULL;
UPDATE assets SET url = value WHERE type = 'url' AND url IS NULL;

-- ── findings ──
ALTER TABLE findings RENAME COLUMN title TO name;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS vulnclass TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS worker TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS report_evidence_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS node_id BIGINT;
-- Single asset_id → asset_ids Array
UPDATE findings SET asset_ids = to_jsonb(ARRAY[asset_id]) WHERE asset_id IS NOT NULL AND asset_ids = '[]'::jsonb;
ALTER TABLE findings DROP COLUMN IF EXISTS asset_id;
-- Discovery Status：pending/false_positive/ignored/resolved。
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_status_check;
ALTER TABLE findings ADD CONSTRAINT findings_status_check CHECK (status IN ('pending','false_positive','ignored','resolved'));
UPDATE findings SET status = CASE status WHEN 'open' THEN 'pending' WHEN 'confirmed' THEN 'resolved' WHEN 'disputed' THEN 'false_positive' ELSE status END;

-- ── companies / company_scope ──
ALTER TABLE companies ADD COLUMN IF NOT EXISTS nkey TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo TEXT;
ALTER TABLE companies RENAME COLUMN remark TO description;
ALTER TABLE company_scopes RENAME TO company_scope;

-- findings Status default value is pending。
ALTER TABLE findings ALTER COLUMN status SET DEFAULT 'pending';

-- findings.summary
ALTER TABLE findings ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';

-- findings.evidence Use text，Keep existing evidence text。
ALTER TABLE findings ALTER COLUMN evidence TYPE TEXT USING evidence::text;
ALTER TABLE findings ALTER COLUMN evidence SET DEFAULT '';

-- findings.node_id is nullable bigint，Point to exploration_nodes。
ALTER TABLE findings ALTER COLUMN node_id DROP DEFAULT;
ALTER TABLE findings ALTER COLUMN node_id DROP NOT NULL;
ALTER TABLE findings ALTER COLUMN node_id TYPE BIGINT USING NULL;

-- exploration_nodes.state Enumeration extension
ALTER TABLE exploration_nodes DROP CONSTRAINT IF EXISTS task_intents_status_check;
ALTER TABLE exploration_nodes DROP CONSTRAINT IF EXISTS exploration_nodes_state_check;
ALTER TABLE exploration_nodes ADD CONSTRAINT exploration_nodes_state_check
  CHECK (state IN ('open','running','blocked','exhausted','stopped','done','failed','origin','fact','cancel','active'));
