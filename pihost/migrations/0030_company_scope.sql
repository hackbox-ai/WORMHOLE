-- Normalize keys without merging or deleting colliding historical companies.
-- A collision aborts this migration for explicit reconciliation.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE companies SET nkey=lower(trim(regexp_replace(name,'[[:space:]]+',' ','g')));
CREATE UNIQUE INDEX uq_company_nkey ON companies(nkey);
CREATE UNIQUE INDEX uq_company_scope_domain ON company_scope(company_id,domain);
CREATE UNIQUE INDEX uq_company_scope_net ON company_scope(company_id,net);
CREATE UNIQUE INDEX uq_company_scope_value ON company_scope(company_id,kind,value) WHERE kind IN ('icp','keyword');
CREATE OR REPLACE FUNCTION try_inet(value TEXT) RETURNS INET AS $$
BEGIN RETURN value::inet; EXCEPTION WHEN others THEN RETURN NULL; END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;
