-- Immutable task bindings; channel secrets live in protected runtime files.
CREATE TABLE network_channels (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 server_host TEXT NOT NULL,
 control_port INTEGER NOT NULL UNIQUE CHECK(control_port BETWEEN 1024 AND 65535),
 socks_port INTEGER NOT NULL UNIQUE CHECK(socks_port BETWEEN 1024 AND 65535),
 version INTEGER NOT NULL DEFAULT 1,
 scopes JSONB NOT NULL CHECK(jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes)>0),
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN network_mode TEXT;
ALTER TABLE tasks ADD COLUMN network_channel_id BIGINT REFERENCES network_channels(id) ON DELETE RESTRICT;
ALTER TABLE tasks ADD COLUMN network_version INTEGER;
UPDATE tasks SET network_mode='standard';
ALTER TABLE tasks ALTER COLUMN network_mode SET NOT NULL;
ALTER TABLE tasks ADD CONSTRAINT task_network_binding CHECK (
 (network_mode='standard' AND network_channel_id IS NULL AND network_version IS NULL)
 OR (network_mode='jump' AND network_channel_id IS NOT NULL AND network_version IS NOT NULL)
);
CREATE FUNCTION bind_new_task_network() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel network_channels; configured TEXT; configured_id TEXT;
BEGIN
 IF NEW.network_mode IS NULL THEN
  SELECT max(value) FILTER(WHERE key='settings.network_mode'),max(value) FILTER(WHERE key='settings.network_channel_id') INTO configured,configured_id FROM app_settings WHERE key IN ('settings.network_mode','settings.network_channel_id');
  NEW.network_mode:=CASE WHEN configured='jump' THEN 'jump' ELSE 'standard' END;
  IF NEW.network_mode='jump' THEN
   NEW.network_channel_id:=CASE WHEN configured_id ~ '^[1-9][0-9]*$' THEN configured_id::bigint ELSE NULL END;
  END IF;
 END IF;
 IF NEW.network_mode='jump' THEN
  SELECT * INTO channel FROM network_channels WHERE id=NEW.network_channel_id;
  IF NOT FOUND OR NOT channel.enabled THEN RAISE EXCEPTION 'Springboard channel does not exist or is disabled'; END IF;
  NEW.network_version:=COALESCE(NEW.network_version,channel.version);
 ELSIF NEW.network_mode='standard' THEN
  NEW.network_channel_id:=NULL; NEW.network_version:=NULL;
 ELSE
  RAISE EXCEPTION 'Invalid network access mode';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_bind_network BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION bind_new_task_network();
CREATE INDEX idx_tasks_network_channel ON tasks(network_channel_id) WHERE network_channel_id IS NOT NULL;
