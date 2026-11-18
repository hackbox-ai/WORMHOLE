-- One active global profile; deleted cursor references become NULL.
CREATE UNIQUE INDEX uq_llm_one_default ON llm_profiles(is_default) WHERE is_default;
ALTER TABLE llm_profiles ADD CONSTRAINT llm_profiles_format_check CHECK(format IN ('openai','anthropic','openai-responses')) NOT VALID;
ALTER TABLE tasks ADD CONSTRAINT tasks_active_llm_profile_id_fkey FOREIGN KEY(active_llm_profile_id) REFERENCES llm_profiles(id) ON DELETE SET NULL NOT VALID;
-- Dirty legacy references stop deployment rather than being silently cleared.
ALTER TABLE llm_profiles VALIDATE CONSTRAINT llm_profiles_format_check;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_active_llm_profile_id_fkey;
