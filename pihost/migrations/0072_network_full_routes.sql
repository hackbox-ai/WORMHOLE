ALTER TABLE network_channels ADD COLUMN parent_channel_id BIGINT REFERENCES network_channels(id) ON DELETE RESTRICT;
ALTER TABLE network_channels ADD COLUMN entry_port INTEGER CHECK(entry_port BETWEEN 1024 AND 65535);
ALTER TABLE network_channels ADD COLUMN relay_listen TEXT NOT NULL DEFAULT '';
ALTER TABLE network_channels ADD COLUMN full_network BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE network_channels ADD COLUMN packet_port INTEGER UNIQUE CHECK(packet_port BETWEEN 1024 AND 65535);
ALTER TABLE network_channels ADD CONSTRAINT network_parent_distinct CHECK(parent_channel_id IS NULL OR parent_channel_id<>id);
