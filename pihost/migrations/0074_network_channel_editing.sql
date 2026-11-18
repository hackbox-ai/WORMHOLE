ALTER TABLE network_channels ADD COLUMN probe_url TEXT NOT NULL DEFAULT '';
CREATE TABLE network_channel_versions (
 channel_id BIGINT NOT NULL REFERENCES network_channels(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL, config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,version)
);
CREATE OR REPLACE FUNCTION bind_new_task_network() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM pg_advisory_xact_lock(hashtext('wormhole-network-config'));
  SELECT * INTO channel FROM network_channels WHERE id=NEW.network_channel_id FOR SHARE;
  IF NOT FOUND OR NOT channel.enabled THEN RAISE EXCEPTION 'Springboard channel does not exist or is disabled'; END IF;
  IF NEW.network_version IS NOT NULL AND NEW.network_version<>channel.version THEN
   RAISE EXCEPTION 'The network configuration has been updated, please reselect the channel and create the task' USING ERRCODE='40001';
  END IF;
  NEW.network_version:=channel.version;
 ELSIF NEW.network_mode='standard' THEN
  NEW.network_channel_id:=NULL; NEW.network_version:=NULL;
 ELSE
  RAISE EXCEPTION 'Invalid network access mode';
 END IF;
 RETURN NEW;
END $$;
