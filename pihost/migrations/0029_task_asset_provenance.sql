-- Original task_asset_links/task_scope; legacy task_assets stays internal.
CREATE TABLE task_asset_links (
 task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
 source TEXT NOT NULL DEFAULT 'system',source_summary TEXT NOT NULL DEFAULT '',
 source_node_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,asset_id)
);
CREATE INDEX idx_task_asset_links_asset ON task_asset_links(asset_id,task_id);
CREATE INDEX idx_task_asset_links_node ON task_asset_links(source_node_id) WHERE source_node_id IS NOT NULL;
CREATE OR REPLACE FUNCTION sync_task_asset_links() RETURNS trigger AS $$
BEGIN
 INSERT INTO task_asset_links(task_id,asset_id,source,source_summary)
 SELECT task.id,NEW.id,'system','Automatic association during task execution'
 FROM unnest(NEW.task_ids) AS requested(task_id)
 JOIN tasks task ON task.id=requested.task_id AND task.deleted_at IS NULL
 ON CONFLICT(task_id,asset_id) DO NOTHING;
 DELETE FROM task_asset_links link WHERE link.asset_id=NEW.id AND NOT(link.task_id=ANY(NEW.task_ids));
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_assets_task_links AFTER INSERT OR UPDATE OF task_ids ON assets FOR EACH ROW EXECUTE FUNCTION sync_task_asset_links();
INSERT INTO task_asset_links(task_id,asset_id,source,source_summary)
SELECT task.id,asset.id,'legacy','Migration by historical task asset association'
FROM assets asset CROSS JOIN LATERAL unnest(asset.task_ids) AS requested(task_id)
JOIN tasks task ON task.id=requested.task_id AND task.deleted_at IS NULL
ON CONFLICT(task_id,asset_id) DO NOTHING;
CREATE TABLE task_scope (
 id BIGSERIAL PRIMARY KEY,task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('company','root_domain','subdomain','ip','cidr','icp','keyword')),
 company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,domain TEXT,net CIDR,value TEXT,
 source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','agent','manual')),reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_task_scope_v2 ON task_scope(task_id,kind,COALESCE(domain,''),COALESCE(net::text,''),COALESCE(company_id,0),COALESCE(value,''));
CREATE INDEX idx_ts_domain ON task_scope(domain) WHERE kind IN ('root_domain','subdomain');
CREATE INDEX idx_ts_net ON task_scope USING GIST(net inet_ops) WHERE kind IN ('ip','cidr');
CREATE INDEX idx_ts_company ON task_scope(company_id) WHERE kind='company';
