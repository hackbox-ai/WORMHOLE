/**
 * F11 Model configuration, pool routing and retry services。
 * Release gate：compileToPiRuntime Put the activated profile compiles to Pi models.json and rebuild
 * runtime，profile corresponds to runnable Pi session。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import {randomUUID} from 'node:crypto';
import path from "node:path";
import type { Pool } from "pg";
import { appendEvent } from "../../events/ledger.ts";
import {healthRegistry} from './health.ts';
import {profileProvider,validProfile} from './profile-runtime.ts';
import {profileLayers,retryRules,storedRetryRules} from './policy.ts';
import {deleteBoundProfile} from './profile-delete.ts';
import {testConnection} from './probes.ts';

export interface ProfileInput {
  name?: string;
  format?: string;
  base_url?: string;
  proxy?: string;
  model?: string;
  api_key?: string | null; // null/undefined/""-Semantics: Leave blank and do not overwrite（PUT），Required when creating WORMHOLE
  rate_per_second?: number;
  rate_per_minute?: number;
  context_window_k?: number;
  thinking_type?: string;
  reasoning_effort?: string;
  is_default?: boolean;
  priority?: number;
  pool_exclude?: boolean;
  streaming?: boolean;
  max_tokens?: number;
  max_tokens_field?: string;
  session_header_key?: string;
  retry?: Record<string, unknown>;
}

const PROFILE_COLS = `id, name, format, base_url, proxy, model, api_key, api_key_hint,
  rate_per_second, rate_per_minute, context_window_k, thinking_type, reasoning_effort,
  is_default, priority, pool_exclude, streaming, max_tokens, max_tokens_field,
  session_header_key, retry`;

type ProfileRow = Record<string, unknown> & { id: number; api_key: string; name: string; model: string; format: string; base_url: string };

/** Serialize to UI：api_key Never echo（json:"-" Control） */
function toUI(r: ProfileRow): Record<string, unknown> {
  const fields=['name','format','model','thinking_type','reasoning_effort','max_tokens_field','session_header_key'];
  const result:Record<string,unknown>={id:String(r.id)};
  for(const k of fields)result[k]=r[k]??'';
  for(const k of ['rate_per_second','rate_per_minute','context_window_k','priority','max_tokens'])result[k]=Number(r[k]??0);
  for(const k of ['is_default','pool_exclude'])result[k]=Boolean(r[k]);
  result.streaming=r.streaming??true;result.base_url=r.base_url??'';result.proxy=r.proxy??'';result.api_key_hint=r.api_key_hint??'';
  result.retry=storedRetryRules(r.retry,profileLayers);return result;
}
function keyHint(key:string,hint=''){const bytes=Buffer.from(key);return bytes.length>=4?'…'+bytes.subarray(-4).toString():hint;}

export class LlmService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    private readonly modelsPath: string,
  ) {}

  async listProfiles(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(`SELECT ${PROFILE_COLS} FROM llm_profiles ORDER BY id ASC`);
    return r.rows.map((row) => toUI(row as ProfileRow));
  }

  async createProfile(input: ProfileInput): Promise<{ ok: true; profile: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    if (!input.name?.trim()) return { ok: false, status: 400, error: "name cannot be empty" };
    if (!input.model?.trim()) return { ok: false, status: 400, error: "model cannot be empty" };
    const format = input.format ?? "anthropic";
    const hint = keyHint(input.api_key??'');
    const r = await this.pool.query(
      `INSERT INTO llm_profiles (name, format, base_url, proxy, model, api_key, api_key_hint,
         rate_per_second, rate_per_minute, context_window_k, thinking_type, reasoning_effort,
         is_default, priority, pool_exclude, streaming, max_tokens, max_tokens_field, session_header_key, retry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING ${PROFILE_COLS}`,
      [
        input.name.trim(), format, input.base_url ?? "", input.proxy ?? "", input.model.trim(),
        input.api_key ?? "", hint,
        input.rate_per_second ?? 0, input.rate_per_minute ?? 0, input.context_window_k ?? 0,
        input.thinking_type ?? "", input.reasoning_effort ?? "",
        input.is_default ?? false, input.priority ?? 0, input.pool_exclude ?? false,
        input.streaming ?? true, Math.max(0,input.max_tokens ?? 0), format==='openai'&&input.max_tokens_field==='max_completion_tokens'?'max_completion_tokens':'',
        input.session_header_key ?? "", JSON.stringify(retryRules(input.retry,profileLayers)),
      ],
    );
    await this.audit("profile_created", { name: input.name });
    return { ok: true, profile: toUI(r.rows[0] as ProfileRow) };
  }

  /** Original POST form is full replacement; a blank key retains the stored key. */
  async saveProfile(input:Record<string,any>):Promise<number>{
    const id=Number(input.id??0),format=input.format??'',key=input.api_key??'';
    const columns=['name','format','base_url','proxy','model','rate_per_second','rate_per_minute','context_window_k','reasoning_effort','priority','pool_exclude','thinking_type','streaming','max_tokens','max_tokens_field','session_header_key','retry'];
    const values:unknown[]=[input.name??'',format,input.base_url??'',input.proxy??'',input.model??'',input.rate_per_second??0,input.rate_per_minute??0,input.context_window_k??0,input.reasoning_effort??'',input.priority??0,input.pool_exclude??false,input.thinking_type??'',input.streaming??true,Math.max(0,input.max_tokens??0),format==='openai'&&input.max_tokens_field==='max_completion_tokens'?'max_completion_tokens':'',input.session_header_key??'',JSON.stringify(retryRules(input.retry,profileLayers))];
    if(!id||key){columns.push('api_key','api_key_hint');values.push(key,keyHint(key,input.api_key_hint??''));}
    let saved=id;
    if(!id){const placeholders=values.map((_,i)=>'$'+(i+1));saved=Number((await this.pool.query(`INSERT INTO llm_profiles(${columns.join(',')}) VALUES(${placeholders.join(',')}) RETURNING id`,values)).rows[0].id);}
    else{values.push(id);await this.pool.query(`UPDATE llm_profiles SET ${columns.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length}`,values);}
    await this.audit(id?'profile_updated':'profile_created',{id:saved});return saved;
  }

  /** Original legacy /api/llm edits only config fields on the named default. */
  async saveGlobalConfiguration(cfg:Record<string,any>):Promise<ProfileRow>{
    const existing=(await this.pool.query("SELECT id FROM llm_profiles WHERE name='default'")).rows[0];
    const columns=['format','model','base_url','proxy','api_key','api_key_hint','rate_per_second','rate_per_minute','context_window_k','thinking_type','reasoning_effort'];
    const values:unknown[]=[cfg.format,cfg.model,cfg.base_url,cfg.proxy,cfg.api_key,keyHint(cfg.api_key),cfg.rate_per_second,cfg.rate_per_minute,cfg.context_window_k,cfg.thinking_type,cfg.reasoning_effort];
    let row:ProfileRow;if(existing){values.push(existing.id);row=(await this.pool.query(`UPDATE llm_profiles SET ${columns.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length} RETURNING ${PROFILE_COLS}`,values)).rows[0];}
    else{row=(await this.pool.query(`INSERT INTO llm_profiles(name,${columns.join(',')}) VALUES('default',${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING ${PROFILE_COLS}`,values)).rows[0];}
    const r=await this.activate(Number(row.id));if(!r.ok)throw new Error(r.error);return {...row,is_default:true};
  }

  /** Legacy target-only partial PUT; original UI uses POST saveProfile. */
  async updateProfile(id: number, input: ProfileInput): Promise<{ ok: true; profile: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    const cur = await this.pool.query(`SELECT ${PROFILE_COLS} FROM llm_profiles WHERE id=$1`, [id]);
    if ((cur.rowCount ?? 0) === 0) return { ok: false, status: 404, error: "profile does not exist" };
    const row = cur.rows[0] as ProfileRow;
    const merged: Record<string, unknown> = { ...toUI(row) };
    for (const [k, v] of Object.entries(input)) {
      if (v === null || v === undefined) continue;
      merged[k] = v;
    }
    if (!input.api_key) {
      merged.api_key = row.api_key; // Internally reserved, not echoed
    } else {
      merged.api_key_hint = keyHint(input.api_key);
    }
    const r = await this.pool.query(
      `UPDATE llm_profiles SET name=$2, format=$3, base_url=$4, proxy=$5, model=$6, api_key=$7,
         api_key_hint=$8, rate_per_second=$9, rate_per_minute=$10, context_window_k=$11,
         thinking_type=$12, reasoning_effort=$13, is_default=$14, priority=$15, pool_exclude=$16,
         streaming=$17, max_tokens=$18, max_tokens_field=$19, session_header_key=$20, retry=$21,
         updated_at=now()
       WHERE id=$1 RETURNING ${PROFILE_COLS}`,
      [
        id, merged.name, merged.format, merged.base_url, merged.proxy, merged.model,
        merged.api_key ?? "", merged.api_key_hint,
        merged.rate_per_second, merged.rate_per_minute, merged.context_window_k,
        merged.thinking_type, merged.reasoning_effort, merged.is_default, merged.priority,
        merged.pool_exclude, merged.streaming, merged.max_tokens, merged.max_tokens_field,
        merged.session_header_key, JSON.stringify(merged.retry ?? {}),
      ],
    );
    await this.audit("profile_updated", { id });
    return { ok: true, profile: toUI(r.rows[0] as ProfileRow) };
  }

  async deleteProfile(id: number): Promise<number[]> {
    const tasks=await deleteBoundProfile(this.pool,id);const health=await healthRegistry(this.pool);health.reset(id);await health.flush();
    await this.audit('profile_deleted',{id});return tasks;
  }

  /** Activate=Set to is_default（Original default downgrade); the head of the chain is always the active item */
  async activate(id: number): Promise<{ ok: boolean; error?: string }> {
    const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('pihost_llm_activation'))");
      if(!(await c.query('SELECT id FROM llm_profiles WHERE id=$1 FOR UPDATE',[id])).rowCount){await c.query('ROLLBACK');return {ok:false,error:'LLM profile not found'};}
      await c.query('UPDATE llm_profiles SET is_default=false,updated_at=now() WHERE is_default');await c.query('UPDATE llm_profiles SET is_default=true,updated_at=now() WHERE id=$1',[id]);await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    await this.audit("profile_activated", { id });
    return { ok: true };
  }

  /** Failover Chain：is_default is always the head of the chain, and the rest priority DESC；pool_exclude Do not enter the link */
  async poolChain(): Promise<Record<string, unknown>[]> {
    const health=await healthRegistry(this.pool),rows=(await this.pool.query('SELECT id,name,model,format,priority,is_default,pool_exclude FROM llm_profiles ORDER BY is_default DESC,priority DESC,id')).rows;
    return rows.map(p=>({profile_id:String(p.id),name:p.name,model:p.model,format:p.format,priority:p.priority,active:p.is_default,excluded:p.pool_exclude,...health.status(Number(p.id))}));
  }

  async resetPool(id=0): Promise<void> {
    const health=await healthRegistry(this.pool);if(id>0)health.reset(id);else health.resetAll();await health.flush();
    await this.audit("pool_reset", {});
  }

  async retryPolicy(): Promise<Record<string, unknown>> {
    const r = await this.pool.query("SELECT value FROM app_settings WHERE key='llm.retry_policy'");
    return storedRetryRules(r.rows[0]?.value??'{}');
  }

  async setRetryPolicy(p: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('llm.retry_policy',$1,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
      [JSON.stringify(retryRules(p))],
    );
    await this.audit("retry_policy_updated", {});
  }

  /** Internal convenience shares the original form probe, never a second transport. */
  async testProfile(id: number): Promise<{ ok: boolean; latency_ms?: number; reply?: string; error?: string }> {
    const r = await this.pool.query("SELECT * FROM llm_profiles WHERE id=$1", [id]);
    const p = r.rows[0] as ProfileRow | undefined;
    if (!p) return { ok: false, latency_ms: 0, error: "profile does not exist" };
    return testConnection(this.pool,{provider:p.format,model:p.model,base_url:p.base_url,proxy:p.proxy,profile_id:Number(p.id),streaming:p.streaming,thinking_type:p.thinking_type,reasoning_effort:p.reasoning_effort,session_header_key:p.session_header_key});
  }

  /**
   * Release gate core: activate profile Compile into Pi models.json（provider=profile-<id>），
   * Keep existing manual work provider；Need to rebuild after calling runtime（session-host.resetPiRuntime）。
   */
  async compileToPiRuntime(): Promise<{ provider: string; modelId: string } | { error: string }> {
    const previous=compilations.get(this.modelsPath)??Promise.resolve();let release!:()=>void;const next=new Promise<void>(r=>release=r);compilations.set(this.modelsPath,next);await previous;
    try{
    const rows=(await this.pool.query('SELECT * FROM llm_profiles ORDER BY id')).rows;
    const p = rows.find(r=>r.is_default) as ProfileRow | undefined;
    let raw: { providers?: Record<string, unknown> } = {};
    try {
      raw = JSON.parse(await readFile(this.modelsPath, "utf8"));
    } catch {
      /* No existing file */
    }
    const providers = raw.providers ?? {};
    for(const id of Object.keys(providers))if(/^profile-\d+$/.test(id))delete providers[id];
    for(const profile of rows)if(validProfile(profile))providers[`profile-${profile.id}`]=profileProvider(profile);
    await mkdir(path.dirname(this.modelsPath),{recursive:true});const temporary=this.modelsPath+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,JSON.stringify({...raw,providers},null,1),{mode:0o600});await rename(temporary,this.modelsPath);
    if(p&&validProfile(p as any))return {provider:`profile-${p.id}`,modelId:profileProvider(p as any).models[0]!.id};
    return { error: "No active profile (leave status quo)" };
    }finally{release();if(compilations.get(this.modelsPath)===next)compilations.delete(this.modelsPath);}
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, {
      business_kind: "llm",
      business_id: "global",
      event_type: event,
      payload,
    });
  }
}
const compilations=new Map<string,Promise<void>>();

export function llmModelsPath(piModelsPath: string): string {
  return piModelsPath;
}

export function dlqOf(dataDir: string): string {
  return path.join(dataDir, "events-dlq.jsonl");
}
