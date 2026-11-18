CREATE TABLE IF NOT EXISTS email_alert_receipts (
 channel_id bigint NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
 finding_id bigint NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,finding_id)
);
