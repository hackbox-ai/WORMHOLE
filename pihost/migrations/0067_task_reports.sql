CREATE TABLE task_reports (
 task_id bigint PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 phase text NOT NULL CHECK(phase IN('draft','final')),
 reason text NOT NULL DEFAULT '',
 markdown text NOT NULL CHECK(length(btrim(markdown))>0),
 finding_count integer NOT NULL DEFAULT 0,
 generated_at timestamptz NOT NULL DEFAULT now()
);
