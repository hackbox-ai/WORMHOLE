-- Source ownership constraint. Preserve historical orphan rows for explicit
-- P5 census/mapping; NOT VALID still enforces every new insert/update/delete.
ALTER TABLE task_intercept_rules ADD CONSTRAINT task_intercept_rules_task_id_fkey FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE NOT VALID;
