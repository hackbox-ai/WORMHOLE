-- 0015_findings_notify.sql — F04 Discovery + F16 Notice + F05 Flow Record (Minimum Closed Loop）。
-- Notice：finding Status Event → notify_events（Transaction outbox）→ Delivery notify_deliveries（Try again）。
-- Traffic: Exchange Records + finding Evidence snapshot (immutable, still readable after source is deleted)）。

CREATE TABLE IF NOT EXISTS findings (
  id          BIGSERIAL PRIMARY KEY,
  task_id     BIGINT,
  node_id     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',  -- info | low | medium | high | critical
  status      TEXT NOT NULL DEFAULT 'open',     -- open | confirmed | disputed | resolved | ignored
  asset_id    BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  detail      TEXT NOT NULL DEFAULT '',
  evidence    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_task_idx ON findings (task_id);

CREATE TABLE IF NOT EXISTS notify_channels (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,                    -- webhook | wecom | dingtalk | feishu
  target     TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notify_events (
  id         BIGSERIAL PRIMARY KEY,
  finding_id BIGINT REFERENCES findings(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- created | status_changed
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS notify_deliveries (
  id         BIGSERIAL PRIMARY KEY,
  event_id   BIGINT NOT NULL REFERENCES notify_events(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notify_deliveries_pending_idx ON notify_deliveries (status, id);

-- F05 Minimum traffic record (agent captures the record area before access）
CREATE TABLE IF NOT EXISTS traffic_exchanges (
  id         BIGSERIAL PRIMARY KEY,
  host       TEXT NOT NULL,
  method     TEXT NOT NULL DEFAULT 'GET',
  path       TEXT NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 0,
  req_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  res_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  req_body   TEXT NOT NULL DEFAULT '',
  res_body   TEXT NOT NULL DEFAULT '',
  task_id    BIGINT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traffic_host_idx ON traffic_exchanges (host, id DESC);

-- finding Evidence snapshot (immutable; still readable after source traffic is deleted)）
CREATE TABLE IF NOT EXISTS finding_traffic_evidence (
  id           BIGSERIAL PRIMARY KEY,
  finding_id   BIGINT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  exchange_id  BIGINT,                          -- Source reference (the source after deletion is NULL，Snapshot still intact）
  snapshot     JSONB NOT NULL,                  -- host/method/path/status/bodies Full snapshot
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
