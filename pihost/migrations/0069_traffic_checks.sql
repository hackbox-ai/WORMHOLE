-- Task-scoped observations and shared work claims; capture never schedules probes.
CREATE TABLE task_traffic_endpoints (
 id bigserial PRIMARY KEY,task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 endpoint_key text NOT NULL,method text NOT NULL,url_template text NOT NULL,auth_key text NOT NULL,
 parameters jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 1,
 capture_id text NOT NULL,request_id text NOT NULL,observations integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,endpoint_key)
);
CREATE TABLE task_http_checks (
 id uuid PRIMARY KEY,task_id bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 endpoint_id bigint NOT NULL REFERENCES task_traffic_endpoints(id) ON DELETE CASCADE,
 revision integer NOT NULL,evidence_id bigint NOT NULL DEFAULT 0,parameter text NOT NULL,check_type text NOT NULL,
 owner_intent_id bigint REFERENCES exploration_nodes(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN('running','negative','inconclusive','suspected')),
 summary text NOT NULL DEFAULT '',capture_ids jsonb NOT NULL DEFAULT '[]',requests integer NOT NULL DEFAULT 0,
 lease_until timestamptz NOT NULL DEFAULT now()+interval '2 minutes',updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,endpoint_id,revision,parameter,check_type,evidence_id)
);

ALTER TABLE reverse_proxies ADD COLUMN mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN('adapter','legacy'));
ALTER TABLE reverse_proxies ADD COLUMN route_hash text NOT NULL DEFAULT '';
