-- Business modeling is a task kind. Execution state continues to live in tasks.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'pentest' CHECK (kind IN ('pentest','modeling'));
ALTER TABLE tasks ADD COLUMN modeling_targets JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN modeling_initialized BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE business_systems (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'default',
  auth_context TEXT NOT NULL DEFAULT '',
  asset_id BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(target,environment,auth_context)
);
CREATE TABLE business_model_runs (
  task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  system_id BIGINT NOT NULL REFERENCES business_systems(id),
  scope_key TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('initial','discovery','manual')),
  source_task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  source_intent_id BIGINT REFERENCES exploration_nodes(id) ON DELETE SET NULL,
  source_conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  base_version_id BIGINT,
  document JSONB NOT NULL,
  entities JSONB NOT NULL DEFAULT '[]',
  submissions INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  finish_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX business_model_runs_system ON business_model_runs(system_id,task_id DESC);
CREATE TABLE business_model_versions (
  id BIGSERIAL PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES business_systems(id),
  scope_key TEXT NOT NULL,
  run_task_id BIGINT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  document JSONB NOT NULL,
  entities JSONB NOT NULL,
  summary TEXT NOT NULL,
  path_count INTEGER NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX business_model_versions_system_scope ON business_model_versions(system_id,scope_key,id DESC);
ALTER TABLE business_model_runs ADD FOREIGN KEY(base_version_id) REFERENCES business_model_versions(id);
CREATE TABLE task_business_models (
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  system_id BIGINT NOT NULL REFERENCES business_systems(id),
  modeling_task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  version_id BIGINT REFERENCES business_model_versions(id),
  initial_gate BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,system_id)
);
CREATE INDEX task_business_models_dependency ON task_business_models(modeling_task_id);
CREATE TABLE intent_business_models (
  intent_id BIGINT NOT NULL REFERENCES exploration_nodes(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL,
  system_id BIGINT NOT NULL,
  PRIMARY KEY(intent_id,system_id),
  FOREIGN KEY(task_id,system_id) REFERENCES task_business_models(task_id,system_id) ON DELETE CASCADE
);

INSERT INTO agents(key,name,description,role,builtin,enabled,run_seconds)
VALUES('modeler','Business Modeling','Restore target interfaces, business entities and relationships, and submit reusable models in batches','assistant',TRUE,TRUE,900)
ON CONFLICT(key) DO NOTHING;
INSERT INTO agent_prompts(agent_key,version,prompt) VALUES('modeler',1,
'You are a business modeler Agent。Collect and restore only within specified goals and operational constraints API、Business entities and relationships. Use api_model_submit Save in batches OpenAPI 3.0 Documentation, use after completion api_model_done Statement coverage and gaps. static inference、mock Observation and real backend verification must be distinguished, in description or x-wormhole-evidence marked. Do not make up interfaces, fields or validation results and do not save them Cookie、Token、Real credentials such as passwords. Only reconnaissance and modeling, no vulnerability exploitation, no recursive creation of modeling tasks。')
ON CONFLICT(agent_key,version) DO NOTHING;

INSERT INTO tool_defaults(key,description,schema,agents) VALUES
('request_business_model','Create or add modeling tasks for the target system','{}','["planner","worker","mainagent","auto","pentest"]'),
('list_business_models','Read the business model directory associated with the current task','{}','["planner","worker","mainagent","auto","pentest"]'),
('api_model_read','Read associated models by system and path','{}','["planner","worker","mainagent","auto","pentest","modeler"]'),
('api_model_submit','Save the current modeling task in batches OpenAPI Drafts and Entities','{}','["modeler"]'),
('api_model_done','Submit modeling delivery and coverage','{}','["modeler"]')
ON CONFLICT(key) DO NOTHING;
INSERT INTO tools(key,system,description,schema,agents,kind)
SELECT key,TRUE,description,schema,agents,'builtin' FROM tool_defaults
WHERE key IN ('request_business_model','list_business_models','api_model_read','api_model_submit','api_model_done') ON CONFLICT(key) DO NOTHING;
UPDATE tools SET agents=agents||'["modeler"]'::jsonb WHERE key IN
('Read','Write','Edit','MultiEdit','LS','Glob','Grep','Bash','sleep','TaskList','TaskOutput','TaskStop','http_request') AND NOT agents ? 'modeler';
UPDATE tool_defaults SET agents=agents||'["modeler"]'::jsonb WHERE key IN
('Read','Write','Edit','MultiEdit','LS','Glob','Grep','Bash','sleep','TaskList','TaskOutput','TaskStop','http_request') AND NOT agents ? 'modeler';
