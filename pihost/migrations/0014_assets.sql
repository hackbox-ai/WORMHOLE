-- 0014_assets.sql — F08 Asset/Enterprise + F18 Asset Interception。

CREATE TABLE IF NOT EXISTS companies (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  remark     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_scopes (
  id         BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  UNIQUE (company_id, scope)
);

CREATE TABLE IF NOT EXISTS assets (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,               -- domain | ip | url | service | ...
  value       TEXT NOT NULL,
  company_id  BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  task_id     BIGINT,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | agent | sync
  remark      TEXT NOT NULL DEFAULT '',
  attrs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_dedup_idx ON assets (kind, value);
CREATE INDEX IF NOT EXISTS assets_company_idx ON assets (company_id);
CREATE INDEX IF NOT EXISTS assets_task_idx ON assets (task_id);

CREATE TABLE IF NOT EXISTS task_assets (
  task_id  BIGINT NOT NULL,
  asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  rel      TEXT NOT NULL DEFAULT 'scope',
  UNIQUE (task_id, asset_id)
);

-- F18：Global/Task level blacklist（block takes precedence over allow）；kind: domain|ip|cidr|url
CREATE TABLE IF NOT EXISTS asset_intercept_rules (
  id         BIGSERIAL PRIMARY KEY,
  scope_kind TEXT NOT NULL DEFAULT 'domain',  -- domain | ip | cidr | url
  value      TEXT NOT NULL,
  action     TEXT NOT NULL DEFAULT 'block',   -- block | allow
  remark     TEXT NOT NULL DEFAULT '',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_intercept_rules (
  id         BIGSERIAL PRIMARY KEY,
  task_id    BIGINT NOT NULL,
  scope_kind TEXT NOT NULL DEFAULT 'domain',
  value      TEXT NOT NULL,
  action     TEXT NOT NULL DEFAULT 'block',   -- block | allow
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (task_id, scope_kind, value, action)
);
