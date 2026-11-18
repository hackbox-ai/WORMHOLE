-- Public vulnerability intelligence hunting (first version).
CREATE TABLE IF NOT EXISTS hunt_runs (
  id          uuid PRIMARY KEY,
  task_id     bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  intent_id   bigint,
  goal        text NOT NULL DEFAULT 'understand',
  input       jsonb NOT NULL,
  query_text  text,
  source_ids  uuid[] NOT NULL DEFAULT '{}',
  status      text NOT NULL,
  counts      jsonb NOT NULL DEFAULT '{}',
  gaps        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS hunt_runs_task ON hunt_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hunt_sources (
  id              uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES hunt_runs(id) ON DELETE CASCADE,
  task_id         bigint NOT NULL,
  url             text NOT NULL,
  fetch_url       text,
  url_key         text NOT NULL,
  title           text,
  site            text,
  authority       integer,
  rerank          numeric,
  published_at    timestamptz,
  http_status     integer,
  failure         text,
  content_sha256  text,
  markdown        text,
  bytes           integer NOT NULL DEFAULT 0,
  original_bytes  integer,
  truncated       boolean NOT NULL DEFAULT false,
  has_code        boolean NOT NULL DEFAULT false,
  kind            text NOT NULL DEFAULT 'unknown',
  summary         text,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hunt_sources_run ON hunt_sources(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS hunt_sources_dedupe ON hunt_sources(run_id, url_key);
CREATE INDEX IF NOT EXISTS hunt_sources_task_url ON hunt_sources(task_id, url_key, fetched_at DESC);
