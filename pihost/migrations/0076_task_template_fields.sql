ALTER TABLE task_templates ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE task_templates ADD COLUMN category_id bigint REFERENCES task_categories(id) ON DELETE SET NULL;
ALTER TABLE task_templates ADD COLUMN intercept_rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(intercept_rules)='array');
ALTER TABLE task_templates ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE task_templates t SET category_id=c.id FROM task_categories c WHERE t.category=c.name;
