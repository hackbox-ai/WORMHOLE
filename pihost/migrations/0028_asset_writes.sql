-- Typed asset write columns and all eight natural keys.
-- Never delete/merge preexisting rows to make a unique index succeed. A conflict
-- aborts the migration and requires an explicit id/ownership mapping.
ALTER TABLE assets ALTER COLUMN value SET DEFAULT '';
ALTER TABLE asset_intercept_rules ALTER COLUMN value SET DEFAULT '';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS method TEXT;
ALTER TABLE assets ADD CONSTRAINT ck_asset_source_port CHECK(port BETWEEN 1 AND 65535) NOT VALID;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS technologies TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS auth JSONB[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS params JSONB[] NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT now();
-- Early ad-hoc test migrations converted open_ports to jsonb. Restore the
-- source array representation without losing its element values/order.
CREATE FUNCTION wormhole_jsonb_elements_array(v JSONB) RETURNS JSONB[] LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(array_agg(value),'{}'::jsonb[]) FROM jsonb_array_elements(v)
$$;
DO $$ BEGIN
  IF (SELECT udt_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='assets' AND column_name='open_ports')='jsonb' THEN
    ALTER TABLE assets ALTER COLUMN open_ports DROP DEFAULT;
    ALTER TABLE assets ALTER COLUMN open_ports TYPE JSONB[] USING wormhole_jsonb_elements_array(open_ports);
    ALTER TABLE assets ALTER COLUMN open_ports SET DEFAULT '{}'::jsonb[];
  END IF;
END $$;
DROP FUNCTION wormhole_jsonb_elements_array(JSONB);
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_root_domain ON assets(domain) WHERE type='root_domain';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_ip ON assets(ip) WHERE type='ip';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_subdomain ON assets(domain,COALESCE(record_type,'')) WHERE type='subdomain';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_app_bundle ON assets(bundle_id) WHERE type='app' AND bundle_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_app_name ON assets(app_name) WHERE type='app' AND bundle_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_service_http ON assets(url) WHERE type='service' AND service_type='http';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_service_other ON assets(COALESCE(domain,''),COALESCE(ip,''),port,service_name) WHERE type='service' AND service_type='other';
CREATE UNIQUE INDEX IF NOT EXISTS uq_av2_endpoint ON assets(url,method) WHERE type='endpoint';
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS kind TEXT;
-- Original scope rows are typed; the old adapter's scope column is internal.
ALTER TABLE company_scope ALTER COLUMN scope SET DEFAULT '';
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS net CIDR;
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS value TEXT;
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS raw TEXT;
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE company_scope ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Legacy scope strings are retained; domain-shaped rules are additionally
-- projected into the source columns. Network/keyword normalization belongs to
-- the source-compatible scope parser, not a blanket relabel of all rows.
UPDATE company_scope SET kind='domain',domain=lower(trim(trailing '.' FROM trim(scope))),raw=scope
WHERE kind IS NULL AND scope ~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+\.?$';
CREATE INDEX IF NOT EXISTS idx_company_scope_domain ON company_scope(domain) WHERE kind='domain';
CREATE INDEX IF NOT EXISTS idx_company_scope_net ON company_scope USING GIST(net inet_ops) WHERE kind IN ('ip','cidr');
