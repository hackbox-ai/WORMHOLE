export interface ModelEntity {
  name: string;
  description?: string;
  fields?: { name: string; type?: string; description?: string }[];
  relations?: { target: string; kind?: string; description?: string }[];
}
export interface BusinessModel {
  task_id: string | number;
  system_id: string | number;
  name: string;
  target: string;
  environment: string;
  auth_context: string;
  status: string;
  paused: boolean;
  queued: boolean;
  trigger_kind: "initial" | "discovery" | "manual";
  source_task_id: string | number | null;
  source_intent_id?: string | number | null;
  base_version_id: string | number | null;
  path_count?: number;
  entity_count?: number;
  version_count?: number;
  submissions: number;
  summary: string;
  stopped_reason: string;
  updated_at: string;
  linked_tasks:
    | { id?: string | number; task_id?: string | number; name: string; version_id: string | number | null }[]
    | null;
}
export interface ModelVersion {
  id: string | number;
  run_task_id: string | number | null;
  summary: string;
  path_count: number;
  operation_count: number;
  created_at: string;
  document?: Record<string, unknown>;
  entities?: ModelEntity[];
}
export interface BusinessModelDetail extends BusinessModel {
  document: Record<string, unknown>;
  entities: ModelEntity[];
  versions: ModelVersion[];
  endpoints: { method: string; path: string; summary: string }[];
  events: { seq: string | number; event_type: string; created_at: string; payload: Record<string, unknown> }[];
}
