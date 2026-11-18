-- Preserve all rows; restore source task-rule fields and duplicate-rule semantics.
ALTER TABLE task_intercept_rules ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE task_intercept_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE task_intercept_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$ DECLARE name text; BEGIN
 FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='task_intercept_rules'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE task_intercept_rules DROP CONSTRAINT %I',name);
 END LOOP;
END $$;
CREATE FUNCTION asset_rules_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=NOW();RETURN NEW;END $$;
CREATE TRIGGER asset_rules_upd BEFORE UPDATE ON asset_intercept_rules FOR EACH ROW EXECUTE FUNCTION asset_rules_set_updated_at();
CREATE TRIGGER task_asset_rules_upd BEFORE UPDATE ON task_intercept_rules FOR EACH ROW EXECUTE FUNCTION asset_rules_set_updated_at();
