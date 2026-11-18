-- Original notification tables; earlier notify_* tables remain as migration evidence.
CREATE FUNCTION notification_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TABLE IF NOT EXISTS notification_channels (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    -- dingtalk DingTalk / feishu Feishu / wecom Enterprise WeChat / webhook General / telegram / email
    kind         TEXT NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    -- Credentials(Plain text storage，UI Mask echo; see server Side maskChannelSecrets)。The six channel fields are very different，
    -- Unification JSONB + Go Side press kind Strict verification to avoid adding a bunch for each channel NULL Column：
    --   dingtalk {webhook,secret}
    --   feishu   {webhook,secret}
    --   wecom    {webhook}
    --   webhook  {url,method,content_type,headers{},body_template}
    --   telegram {bot_token,chat_id,base_url}
    --   email    {host,port,username,password,from,to[],tls}
    config       JSONB NOT NULL DEFAULT '{}',
    -- Push timing：realtime Hit and push / digest Incoming batches are summarized into one according to the global cycle。
    mode         TEXT NOT NULL DEFAULT 'realtime',
    -- Filter conditions, all fields are optional(Default=No filtering)：
    --   min_severity       ''|low|medium|high|critical
    --   task_ids/asset_ids Empty array=No limit; if it is not empty, the intersection must be non-empty
    --   vulnclass_include/exclude Keyword array(Case-insensitive substring)；include Empty=Receive all
    --   on_status_change   bool，Only realtime Pattern makes sense
    filter       JSONB NOT NULL DEFAULT '{}',
    -- Delivery limit per minute；0=No current limit. Default 20 Align DingTalk/Qiwei official hard limit。
    -- No message will be lost if the limit is exceeded, only delivery will be postponed to the next one tick。
    rate_per_min INTEGER NOT NULL DEFAULT 20,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_notification_channels_upd ON notification_channels;
CREATE TRIGGER trg_notification_channels_upd BEFORE UPDATE ON notification_channels
    FOR EACH ROW EXECUTE FUNCTION notification_set_updated_at();

-- Facts of the event. by RecordFindingTx / Status change transaction**Same transaction**Write to ensure that ”vulnerabilities are logged into the library」
-- It is consistent with the ”push task exists” atom - there is no window where the submission is successful but not queued, and the message is permanently lost.。
-- snapshot Intentional redundancy: vulnerabilities will be renamed afterwards/Change level/Change the status and push content should reflect ”the time when the incident occurred”」，
-- and fan-out No need to check back with rendering findings/tasks/assets Multiple tables。
-- finding Events are not deleted cascaded after deletion: with findings The semantics of the table ”Task deletion still remains independently” are consistent。
CREATE TABLE IF NOT EXISTS notification_events (
    id         BIGSERIAL PRIMARY KEY,
    -- finding_created | finding_status_changed
    kind       TEXT NOT NULL,
    finding_id BIGINT NOT NULL,
    snapshot   JSONB NOT NULL,
    -- fan-out Idempotent tag：dispatcher Click this column to get the events to be dispatched, and reset them after processing. true。
    -- Use columns instead of deleting rows so that delivery history goes back to events。
    fanned_out BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_events_pending
    ON notification_events(id) WHERE NOT fanned_out;

-- Delivery task: an event × An enabled channel = One line。fan-out Do it outside the transaction, so channel
-- The history will not be updated when opening later ”Late opening” of(and agent_triggers ”Late opening” trigger ”Do not add history” has consistent semantics，
-- Avoid one-time refresh history backlog when enabling channels)。
-- channel_id Cascade deletion: The channel configuration is gone and its delivery history is meaningless。
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id          BIGSERIAL PRIMARY KEY,
    event_id    BIGINT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    channel_id  BIGINT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    -- pending Ready to go / sent Sent / failed Retry exhausted(Can be manually resent) / skipped Channel deactivation or batch cancellation
    -- pending Ready to go / sending has been dispatcher Receive(Lease has not expired) / sent Sent /
    -- failed Retries exhausted or permanently failed(Can be manually resent) / skipped Channel deactivated. Value is not added CHECK，
    -- and findings.status For the same reason, due to server Side whitelist verification。
    state       TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    -- It doubles as ”the next time you can collect it” and ”the lease expiration time”: pushing it to the future when you collect it constitutes a lease，
    -- So ”the lease has not expired” and ”the retry time has not expired” share the same conditional expression, and no additional
    -- lease_until column. Process crash left behind sending The guild will be re-claimed in the next round due to the expiration of the lease.。
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error  TEXT NOT NULL DEFAULT '',
    -- digest Pattern shared with batch；realtime Hengwei NULL。The entire batch is rendered into one message and then placed together sent。
    batch_id    BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
    ON notification_deliveries(next_attempt_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_history
    ON notification_deliveries(id DESC);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_batch
    ON notification_deliveries(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel
    ON notification_deliveries(channel_id, id DESC);

-- Keep IDs so legacy delivery/event references remain inspectable. This migration
-- runs once in a transaction; it neither deletes legacy records nor overwrites facts.
INSERT INTO notification_channels(id,name,kind,enabled,config,created_at,updated_at)
SELECT id,name,kind,enabled,CASE WHEN kind='webhook' THEN jsonb_build_object('url',target)
 ELSE jsonb_build_object('webhook',target) END,created_at,created_at FROM notify_channels;
INSERT INTO notification_events(id,kind,finding_id,snapshot,fanned_out,created_at)
SELECT e.id,CASE e.kind WHEN 'created' THEN 'finding_created' WHEN 'status_changed' THEN 'finding_status_changed' ELSE e.kind END,
 COALESCE(e.finding_id,0), e.payload || jsonb_build_object('finding_id',COALESCE(e.finding_id,0)) ||
 CASE WHEN e.payload->>'task_id' ~ '^[0-9]+$' THEN jsonb_build_object('task_id',(e.payload->>'task_id')::bigint) ELSE '{}'::jsonb END,
 e.processed OR EXISTS(SELECT 1 FROM notify_deliveries d WHERE d.event_id=e.id),e.created_at FROM notify_events e;
INSERT INTO notification_deliveries(id,event_id,channel_id,state,attempts,last_error,sent_at,created_at)
SELECT id,event_id,channel_id,status,attempts,last_error,sent_at,created_at FROM notify_deliveries;
SELECT setval(pg_get_serial_sequence('notification_channels','id'),COALESCE(max(id),1),max(id) IS NOT NULL) FROM notification_channels;
SELECT setval(pg_get_serial_sequence('notification_events','id'),COALESCE(max(id),1),max(id) IS NOT NULL) FROM notification_events;
SELECT setval(pg_get_serial_sequence('notification_deliveries','id'),COALESCE(max(id),1),max(id) IS NOT NULL) FROM notification_deliveries;
