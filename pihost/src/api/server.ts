import {routeFindingReports} from './finding-reports.ts';
import {extensionStates} from '../domains/extensions/availability.ts';
import {TokenMeter,MeterQueryError} from '../domains/observability/token-meter.ts';
import {routeTaskTemplates} from './task-templates.ts';
import {routeReverseSettings} from './reverse-settings.ts';
import {routeNetworkChannels} from './network-channels.ts';
import {routeFindingAlerts} from './finding-alerts.ts';
import {routeModeling} from './modeling.ts';
import {routePocs} from './pocs.ts';
import {routeTaskBatches} from './task-batches.ts';
import {FindingLineage} from '../domains/findings/lineage.ts';
import {routeFingerprints} from './fingerprints.ts';
import {routeAgents} from './agents.ts';
import {taskMarkdown} from '../domains/tasks/report.ts';
import {reopenExploration} from '../domains/tasks/completion.ts';
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { PihostConfig } from "../config.ts";
import { AuthService, extractToken } from "../auth/service.ts";
import type { SettingsService } from "../domains/settings/service.ts";
import type { SettingsConsumers } from "../domains/settings/consumers.ts";
import type { LlmService } from "../domains/llm/service.ts";
import type { AgentsService } from "../domains/agents/service.ts";
import type { ToolsService } from "../domains/tools/service.ts";
import type { McpService } from "../domains/mcp/service.ts";
import type { SkillsService } from "../domains/skills/service.ts";
import type { WorkspaceService } from "../domains/workspace/service.ts";
import type { TaskService, TaskEngine } from "../domains/tasks/index.ts";
import type { ConversationsService } from "../domains/conversations/service.ts";
import type { InterceptService } from "../domains/intercept/service.ts";
import type { ObservabilityService } from "../domains/observability/service.ts";
import type { AssetsService } from "../domains/assets/service.ts";
import type { FindingsService } from "../domains/findings/service.ts";
import type { FindingsWorkflow } from "../domains/findings/workflow.ts";
import type { SyncService } from "../domains/sync/service.ts";
import { resetPiRuntime } from "../pi/session-host.ts";
import { getHealth } from "./handlers.ts";
import { streamEvents } from "./events.ts";
import {routeExploration} from './exploration.ts';
import {routeTools} from './tools.ts';
import {routeAssets} from './assets.ts';
import {routeAssetRules} from './asset-rules.ts';
import {routeCompanies} from './companies.ts';
import {routeAssetContext} from './asset-context.ts';
import {routeActivity} from './activity.ts';
import {routeWorkspace} from './workspace.ts';
import {routeFindingFollowUp} from './finding-follow-up.ts';
import {routeFindingRetests} from './finding-retests.ts';
import {routeTraffic} from './traffic.ts';
import {routeFindingEvidence} from './finding-evidence.ts';
import {routeFindingView} from './finding-view.ts';
import {routeNotify} from './notify.ts';
import {routeTaskLLM} from './task-llm.ts';
import {routeLlmManagement} from './llm-management.ts';
import {routeLlmRecords} from './llm-records.ts';
import {routeScopeSentry} from './scopesentry.ts';
import {routeTaskBrowser} from './task-browser.ts';
import {routeConversations} from './conversations.ts';
import {readObject} from './json-body.ts';
import {logSink, recentDbLogs,logInteger,streamLogs} from '../domains/observability/logsink.ts';
import {routeSideQuestions} from './side-questions.ts';
import {validAttachments} from '../domains/workspace/attachments.ts';
import {routeInterceptReviews} from './intercept-reviews.ts';
import {storageStatus} from '../storage/lifecycle.ts';
import {storagePolicy} from '../storage/policy.ts';
import {hydrateColdEvents} from '../storage/cold-events.ts';
import {replaySessionPayload} from '../pi/event-payload.ts';

export interface AppContext {
  networkChannels?:import('../domains/network/channels.ts').NetworkChannels;
  pocs?:import('../domains/pocs/service.ts').PocService;
  fingerprints?:import('../domains/fingerprints/service.ts').FingerprintService;
  pool: Pool;
  config: PihostConfig;
  startedAt: number;
  auth: AuthService;
  settings: SettingsService;
  settingsConsumers: SettingsConsumers;
  llm: LlmService;
  agents: AgentsService;
  tools: ToolsService;
  mcp: McpService;
  skills: SkillsService;
  workspace: WorkspaceService;
  tasks: TaskService;
  taskEngine: TaskEngine;
  conversations: ConversationsService;
  taskBrowsers?: import('../domains/browser/task-browser.ts').TaskBrowsers;
  intercept: InterceptService;
  obs: ObservabilityService;
  assets: AssetsService;
  findings: FindingsService;
  findingsWorkflow: FindingsWorkflow;
  findingReports?:import('../domains/findings/report-jobs.ts').FindingReports;
  findingRetests?:import('../domains/findings/retests.ts').FindingRetests;
  traffic?:import('../domains/traffic/runtime.ts').TrafficRuntime;
  sync: SyncService;
  taskChat: import("../domains/tasks/chat.ts").TaskChatService;
  sideQuestions?: import('../domains/sidequestions/service.ts').SideRuntime;
  taskArchives?: import('../domains/tasks/archives.ts').TaskArchives;
}

/**
 * Routing and Authentication（/api/health and /api/auth/* Public, rest /api/* Required
 * Bearer token；Unregistered API Path return 404。
 */
export async function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  console.log("[http] " + (req.method ?? "?") + " " + path);
  try {
    // ── Static frontend - not /api/ of GET/HEAD Always go static ──
    if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/")) {
      const { serveStatic } = await import("./static.ts");
      return serveStatic(req, res, path);
    }
    const isPublicApi =
      path === "/api/health" || path.startsWith("/api/auth/");

    if (req.method === "GET" && path === "/api/health") return await getHealth(res, ctx);

    if (path.startsWith("/api/auth/")) {
      if (req.method === "GET" && path === "/api/auth/status") {
        const initialized = await ctx.auth.initialized();
        return json(res, 200, { initialized });
      }
      if(path==="/api/auth/account" && (req.method==="GET"||req.method==="PATCH")){
        const token=extractToken(req.headers,url.searchParams.get("token"));
        if(!token||!await ctx.auth.verifyToken(token))return json(res,401,{error:"Unauthorized"});
        if(req.method==="GET")return json(res,200,{username:await ctx.auth.username()});
        const body=await readJson(req);
        if(typeof body?.username!=="string"||typeof body?.current_password!=="string")return json(res,400,{error:"Please fill in the username and current password"});
        const result=await ctx.auth.changeUsername(body.username,body.current_password);
        return result.ok?json(res,200,result):json(res,result.status,{error:result.error});
      }
      if (req.method === "POST" && (path === "/api/auth/init" || path === "/api/auth/login" || path === "/api/auth/change-password")) {
        const body = await readJson(req);
        if (path === "/api/auth/init") {
          if(body?.username!==undefined&&typeof body.username!=="string")return json(res,400,{error:"Username must be a string"});
          const r = await ctx.auth.init(String(body?.password ?? ""),body?.username===undefined?undefined:String(body.username));
          return r.ok ? json(res, 200, { token: r.token }) : json(res, r.status, { error: r.error });
        }
        if (path === "/api/auth/login") {
          const r = await ctx.auth.login(String(body?.username ?? ""), String(body?.password ?? ""));
          return r.ok ? json(res, 200, { token: r.token }) : json(res, r.status, { error: r.error });
        }
        // change-password：Route is in exempt area，handler Internal self-check token（Control authChangePassword）
        const token = extractToken(req.headers, url.searchParams.get("token"));
        if (!token || !(await ctx.auth.verifyToken(token))) return json(res, 401, { error: "Unauthorized" });
        const r = await ctx.auth.changePassword(String(body?.old_password ?? ""), String(body?.new_password ?? ""));
        return r.ok ? json(res, 200, { token: r.token }) : json(res, r.status, { error: r.error });
      }
      return json(res, 404, { error: "not_found", path });
    }

    if (path === "/api" || path.startsWith("/api/")) {
      if (!isPublicApi) {
        // Control extractToken/requireAuth：Bearer → wormhole_token cookie → ?token=
        const token = extractToken(req.headers, url.searchParams.get("token"));
        if (!token) return json(res, 401, { error: "Unauthorized" });
        if (!(await ctx.auth.verifyToken(token))) return json(res, 401, { error: "token is invalid or expired" });
      }
      if(path==='/api/extensions'&&req.method==='GET')return json(res,200,{extensions:await extensionStates(url.searchParams.get('refresh')==='1')});
      if(await routeReverseSettings(req,res,url,ctx,json))return;
      if(await routeNetworkChannels(req,res,url,ctx,json))return;
      if(await routeFindingAlerts(req,res,url,ctx,json))return;
      if(await routeExploration(req,res,url,ctx,json,readJson))return;
      if(await routeModeling(req,res,url,ctx,json))return;
      if(await routeFingerprints(req,res,url,ctx,json))return;
      if(await routePocs(req,res,url,ctx,json))return;
      if(await routeTaskBatches(req,res,url,ctx,json))return;
      if(await routeAssetRules(req,res,url,ctx,json,readJson))return;
      if(await routeAssets(req,res,url,ctx,json,readJson))return;
      if(await routeCompanies(req,res,url,ctx,json))return;
      if(await routeAssetContext(req,res,url,ctx,json,readJson))return;
      if(await routeActivity(req,res,url,ctx,json))return;
      if(await routeWorkspace(req,res,url,ctx,json,readJson))return;
      if(await routeFindingFollowUp(req,res,url,ctx,json))return;
      if(await routeFindingReports(req,res,url,ctx,json))return;
      if(await routeFindingRetests(req,res,url,ctx,json))return;
      if(await routeTraffic(req,res,url,ctx,json,readJson))return;
      if(await routeFindingEvidence(req,res,url,ctx,json,readJson))return;
      if(await routeNotify(req,res,url,ctx,json))return;
      if(await routeFindingView(req,res,url,ctx,json))return;
      if(await routeTaskLLM(req,res,url,ctx,json))return;
      if(req.method==='GET'&&path==='/api/storage/status')return json(res,200,{policy:storagePolicy(ctx.config.storage),...await storageStatus(ctx.pool)});
      if(await routeLlmRecords(req,res,url,ctx,json))return;
      if(await routeScopeSentry(req,res,url,ctx,json))return;
      if(await routeTaskBrowser(req,res,url,ctx,json))return;
      if(await routeConversations(req,res,url,ctx,json))return;
      if(await routeInterceptReviews(req,res,url,ctx,json))return;
      if(await routeLlmManagement(req,res,url,ctx,json))return;
      if (req.method === "GET" && path === "/api/settings") {
        return json(res, 200, await ctx.settings.payload());
      }
      if (req.method === "PUT" && path === "/api/settings") {
        const body = await readJson(req);
        const r = await ctx.settings.apply(body ?? {});
        if (r.ok && r.changed.length > 0 && ctx.settingsConsumers) {
          // F21 Consumer: Rebuild Assembly+Concurrent snapshot refresh+Audit
          await ctx.settingsConsumers.onSettingsChanged(r.changed);
          ctx.traffic?.applySettings();
        }
        // Contract Control: Baseline PUT Successfully returned the updated complete settings Load
        return r.ok ? json(res, 200, await ctx.settings.payload()) : json(res, r.status, { error: r.error });
      }
      // ── F12 Agents ──
      if(await routeAgents(req,res,url,ctx,json))return;
      const triggerMatch=path.match(/^\/api\/triggers\/(\d+)$/);
      if(triggerMatch){
        const id=Number(triggerMatch[1]);
        if(req.method==='PATCH'){try{await ctx.agents.updateTrigger(id,await (await import('./json-body.ts')).readObject(req,Number.MAX_SAFE_INTEGER,true));return json(res,200,{ok:true});}catch(error){const e=error as Error&{status?:number};if(e.status||error instanceof SyntaxError)return json(res,e.status??400,{error:e.message});throw error;}}
        if(req.method==='DELETE'){await ctx.agents.removeTrigger(id);return json(res,200,{deleted:id});}
      }
      if(await routeTools(req,res,url,ctx,json))return;
      // ── F13 MCP ──
      if (path === "/api/mcp" && req.method === "GET") {
        return json(res, 200, { servers: await ctx.mcp.list() });
      }
      if (path === "/api/mcp" && req.method === "POST") {
        const id=await ctx.mcp.save((await readJson(req))??{});
        return json(res,200,{id});
      }
      const mcpMatch = path.match(/^\/api\/mcp\/(\d+)(\/tools|\/refresh)?$/);
      if (mcpMatch) {
        const id = Number(mcpMatch[1]);
        if (mcpMatch[2] === "/tools" && req.method === "GET") {
          const tools = await ctx.mcp.cachedTools(id);
          return json(res,200,{tools:(tools??[]).map(({name,description})=>({name,description}))});
        }
        if (mcpMatch[2] === "/refresh" && req.method === "POST") {
          const r = await ctx.mcp.refresh(id);
          return r.ok ? json(res,200,{tools:(await ctx.mcp.cachedTools(id)??[]).map(({name,description})=>({name,description}))}) : json(res,r.error==="MCP does not exist"?404:502,{error:r.error==="MCP does not exist"?r.error:"Tool discovery failed:"+r.error});
        }
        if (!mcpMatch[2] && req.method === "DELETE") {
          const ok = await ctx.mcp.remove(id);
          return json(res,200,{deleted:id});
        }
      }
      // ── F14 Skills ──
      if (path === "/api/skills" && req.method === "GET") {
        // WORMHOLE SkillItem：name/description/files + skill_usage Ledger aggregation（calls/tasks/usage_agents/last_used）。
        const skills = await ctx.skills.list();
        const agg = await ctx.pool.query(
          `SELECT skill, count(*)::int AS calls,
                  count(DISTINCT business_id) FILTER (WHERE business_kind <> 'conversation')::int AS tasks,
                  array_agg(DISTINCT agent_key) FILTER (WHERE agent_key <> '') AS usage_agents,
                  max(ts) AS last_used
           FROM skill_usage GROUP BY skill`,
        );
        const bySkill = new Map<string, Record<string, unknown>>(agg.rows.map((r: Record<string, unknown>) => [String(r.skill), r]));
        const out = [];
        for (const s of skills) {
          const name = String(s.name ?? s.display_name ?? "");
          const a = bySkill.get(name);
          const files = (await ctx.skills.listFiles(name)) ?? [];
          out.push({
            name,
            description: s.description ?? "",
            ...(s.license?{license:s.license}:{}),
            ...(s.compatibility?{compatibility:s.compatibility}:{}),
            ...(s.mcps?{mcps:s.mcps}:{}),
            files: files.map((f: Record<string, unknown>) => String(f.path)),
            calls: Number(a?.calls ?? s.uses ?? 0),
            tasks: Number(a?.tasks ?? 0),
            usage_agents: (a?.usage_agents as string[] | null) ?? [],
            last_used: a?.last_used ?? undefined,
          });
        }
        return json(res, 200, { skills: out });
      }
      if (path === "/api/skills" && req.method === "POST") {
        const body = await readJson(req);
        const r = await ctx.skills.create(String(body?.name ?? ""), String(body?.description ?? ""));
        return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
      }
      if (path === "/api/skills/upload" && req.method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const r = await ctx.skills.uploadZip(name, new Uint8Array(Buffer.concat(chunks)));
        return r.ok ? json(res, 200, { status: "ok", files: r.files }) : json(res, r.status!, { error: r.error });
      }
      if (path === "/api/skills/missing" && req.method === "GET") {
        return json(res, 200, { missing: await ctx.skills.missing() });
      }
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)(\/.*)?$/);
      if (skillMatch && skillMatch[1] !== "upload" && skillMatch[1] !== "missing") {
        const name = decodeURIComponent(skillMatch[1]!);
        if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return json(res, 400, { error: "Illegal Skill name" });
        const sub = skillMatch[2] ?? "";
        if (sub === "" && req.method === "DELETE") {
          const ok = await ctx.skills.remove(name);
          return ok ? json(res, 200, { status: "ok" }) : json(res, 404, { error: "Skill does not exist" });
        }
        if (sub === "/files" && req.method === "GET") {
          const files = await ctx.skills.listFiles(name);
          return files ? json(res, 200, files) : json(res, 404, { error: "Skill does not exist" });
        }
        if (sub === "/meta" && req.method === "PUT") {
          const r = await ctx.skills.updateMeta(name, (await readJson(req)) ?? {});
          return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
        }
        if (sub === "/dirs" && req.method === "POST") {
          const body = await readJson(req);
          const r = await ctx.skills.makeDir(name, String(body?.dir ?? ""));
          return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
        }
        if (sub === "/usage" && req.method === "GET") {
          return json(res, 200, await ctx.skills.usage(name));
        }
        const fileMatch = sub.match(/^\/files\/(.+)$/);
        if (fileMatch) {
          const file = decodeURIComponent(fileMatch[1]!);
          if (req.method === "GET") {
            const content = await ctx.skills.readFile(name, file);
            return content === null ? json(res, 404, { error: "File does not exist" }) : json(res, 200, { path: file, content });
          }
          if (req.method === "PUT") {
            const body = await readJson(req);
            const r = await ctx.skills.writeFile(name, file, String(body?.content ?? ""));
            return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
          }
          if (req.method === "DELETE") {
            const ok = await ctx.skills.deleteFile(name, file);
            return ok ? json(res, 200, { status: "ok" }) : json(res, 404, { error: "File does not exist" });
          }
        }
      }
      // ── F03 Tasks ──
      if (path === "/api/tasks" && req.method === "GET") {
        return json(res, 200, { active: "", tasks: await ctx.tasks.list({ status: url.searchParams.get("status") ?? undefined, archived: url.searchParams.get("archived") === "true" }) });
      }
      if (path === "/api/tasks" && req.method === "POST") {
        const r = await ctx.tasks.create((await readJson(req)) ?? {});
        if (r.ok) {
          const task = r.task as Record<string, unknown>;
          const ts = (v: unknown) => (v ? Math.floor(new Date(v as string).getTime() / 1000) : 0);
          return json(res, 201, {
            id: Number(task.id), exploration_id: Number(task.exploration_id), name: task.name ?? "",network_mode:task.network_mode,network_channel_id:task.network_channel_id,network_version:task.network_version,
            description: task.description ?? "", goal: task.goal ?? "", status: task.status ?? "created",
            paused: task.paused ?? false, queued: task.queued ?? false, pinned: false,
            coverage_enabled: task.coverage_enabled ?? true,
            company_ids: [] as number[], source_task_ids: (await ctx.tasks.list({id:Number(task.id),archived:null}))[0]?.source_task_ids??[], llm_profile_ids: task.llm_profile_ids,
            goals_met: 0, goals_total: 0, findings: { critical: 0, high: 0, medium: 0, low: 0 }, tokens: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, in_flight: 0,
            llm_profile_id:task.llm_profile_id,active_llm_profile_id:task.active_llm_profile_id,llm_failover_state: task.llm_failover_state,
            created_at: task.created_at, created_unix: ts(task.created_at),
            completed_at: "", completed_unix: 0,
            last_activity_unix: ts(task.created_at),
          });
        }
        return json(res, r.status, { error: r.error });
      }
      if (path === '/api/tasks/control/batch' && req.method === 'POST') {
        let body;try{body=await readObject(req,256*1024,true);}catch(e){return json(res,400,{error:'bad json: '+(e as Error).message});}
        if(!['pause','resume'].includes(String(body.action))||!Array.isArray(body.task_ids)||body.task_ids.some((v:unknown)=>typeof v!=='string'))return json(res,400,{error:'bad json'});
        const ids=[...new Set((body.task_ids as string[]).map(v=>/^[+]?[0-9]+$/.test(v.trim())&&Number(v)>0&&Number.isSafeInteger(Number(v))?String(Number(v)):v.trim()))];
        if(!ids.length||ids.length>100)return json(res,400,{error:"The number of task_ids must be 1-100"});
        const items=[];
        for(const raw of ids){
          if(!/^[1-9]\d*$/.test(raw)){items.push({id:raw,ok:false,error:'bad task id'});continue;}
          const id=Number(raw);
          const r=await ctx.tasks.control(id,String(body.action));
          const task=r.ok?(await ctx.tasks.list({id,archived:null}))[0]:undefined;
          items.push({id:String(id),ok:r.ok,...(task?{status:task.status,paused:task.paused,queued:task.queued}:{error:r.error})});
        }
        return json(res,200,{items});
      }
      const controlMatch=path.match(/^\/api\/tasks\/(\d+)\/control$/);
      if(controlMatch && req.method==='POST'){
        let body;try{body=await readObject(req,1024*1024,true);}catch(e){return json(res,400,{error:'bad json: '+(e as Error).message});}
        if(body.action!=='pause'&&body.action!=='resume')return json(res,400,{error:'bad action'});
        const id=Number(controlMatch[1]),r=await ctx.tasks.control(id,body.action);
        if(!r.ok)return json(res,r.status,{error:r.error});
        const task=(await ctx.tasks.list({id,archived:null}))[0];
        return json(res,200,{id:String(id),paused:!!task?.paused,queued:!!task?.queued,status:task?.status});
      }
      const taskMatch = path.match(/^\/api\/tasks\/(\d+)(\/(run|pause|resume|stop|archive|restore))?$/);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        const action = taskMatch[3];
        if (!action && req.method === "GET") {
          const t = await ctx.tasks.get(id);
          if (!t) return json(res, 404, { error: "Task does not exist" });
          const dtos = await ctx.tasks.list({ id, archived: null });
          return json(res, 200, { ...(dtos[0] ?? {}), ...t });
        }
        if (!action && req.method === "DELETE") {
          // G03：Delete barrier - period master Agent New messages are rejected, the engine is terminated and no more writing is done after the final state
          await ctx.taskEngine.beginDelete(id);
          try {
            await ctx.taskChat?.stopTask(id);
            const r = await ctx.tasks.remove(id);
            // Files are cleaned only if they are actually deleted; archiving is drainSide，Won’t get here
            if (r.ok) await ctx.taskEngine.purgeTaskData(id).catch(() => {});
            return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
          } finally {
            ctx.taskEngine.endDelete(id);
          }
        }
        if (action && req.method === "POST") {
          if (action === "restore") {
            const ok = await ctx.tasks.restore(id);
            return ok ? json(res, 200, { status: "ok" }) : json(res, 404, { error: "Task does not exist" });
          }
          if (action === "archive") {
            try { return json(res, 202, await ctx.taskArchives!.queue(id)); } catch (e) { return json(res, (e as { status?: number }).status ?? 500, { error: String((e as Error).message ?? e) }); }
            const r = await ctx.tasks.archive(id);
            return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
          }
          const r = await ctx.tasks.control(id, action);
          if (r.ok && action === "run") ctx.taskEngine.launch(id);
          return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
        }
      }
      // The conversation CRUD/message contracts live in conversations.ts.
      if(await routeSideQuestions(req,res,url,{pool:ctx.pool,config:ctx.config,runtime:ctx.sideQuestions!,isTaskDeleting:(id)=>ctx.taskEngine.isDeleting(id)},json,readObject as never))return;
      // ── F17 Interception Rules / F19 Approval ──
      if (path === "/api/intercept/rules" && req.method === "GET") {
        return json(res, 200, { rules: await ctx.intercept.listRules() });
      }
      if (path === "/api/intercept/rules" && req.method === "POST") {
        let input:Record<string,unknown>;try{input=await readObject(req,1024*1024,true);}catch(error){return json(res,400,{error:(error as Error).message});}
        const r = await ctx.intercept.createRule(input);
        if (r.ok) {
          const rule = r.rule as Record<string, unknown>;
          return json(res, 200, { id: Number(rule.id), name: rule.name, enabled: rule.enabled, priority: Number(rule.priority), match_target: rule.match_target, match_type: rule.match_type, pattern: rule.pattern, action: rule.action, message: rule.message, timeout_enabled: rule.timeout_enabled, timeout_seconds: Number(rule.timeout_seconds), timeout_action: rule.timeout_action, created_at: rule.created_at, updated_at: rule.created_at });
        }
        return json(res, r.status, { error: r.error });
      }
      const ruleMatch = path.match(/^\/api\/intercept\/rules\/(\d+)$/);
      if (ruleMatch) {
        const id = Number(ruleMatch[1]);
        if (req.method === "PUT") {
          let input:Record<string,unknown>;try{input=await readObject(req,1024*1024,true);}catch(error){return json(res,400,{error:(error as Error).message});}
          const invalid=ctx.intercept.ruleError(input);if(invalid)return json(res,400,{error:invalid});
          const ok = await ctx.intercept.updateRule(id,input);
          return ok ? json(res, 200, (await ctx.intercept.listRules()).find(r=>r.id===id)) : json(res, 500, { error: "sql: no rows in result set" });
        }
        if (req.method === "DELETE") {
          await ctx.intercept.removeRule(id);
          return json(res, 200, { deleted:id });
        }
      }
      const ruleToggle=path.match(/^\/api\/intercept\/rules\/(\d+)\/toggle$/);
      if(ruleToggle&&req.method==='POST'){
        let input:Record<string,unknown>;try{input=await readObject(req,1024*1024,true);}catch(error){return json(res,400,{error:(error as Error).message});}
        if(input.enabled!=null&&typeof input.enabled!=='boolean')return json(res,400,{error:`json: cannot unmarshal ${typeof input.enabled} into Go struct field .enabled of type bool`});
        const enabled=input.enabled??false;await ctx.pool.query('UPDATE intercept_rules SET enabled=$2,updated_at=now() WHERE id=$1',[Number(ruleToggle[1]),enabled]);
        return json(res,200,{ok:true,enabled});
      }
      if (path === "/api/intercept/pending" && req.method === "GET") {
        return json(res, 200, { pending: await ctx.intercept.pending() });
      }
      if (path === "/api/intercept/history" && req.method === "GET") {
        const hist = await ctx.intercept.history();
        return json(res, 200, { items: hist, total: hist.length });
      }
      const apprMatch = path.match(/^\/api\/intercept\/(pending|history)\/(\d+)$/);
      if (apprMatch && req.method === "GET") {
        const d = await ctx.intercept.detail(Number(apprMatch[2]));
        return d ? json(res, 200, d) : json(res, 404, { error: "The approval form does not exist" });
      }
      if (path === "/api/intercept/decide" && req.method === "POST") {
        const body = await readJson(req);
        const decision = String(body?.decision ?? "");
        if (!["approved", "denied"].includes(decision)) return json(res, 400, { error: "decision must be approved|denied" });
        const r = await ctx.intercept.decideReview(Number(body?.id), decision as "approved" | "denied");
        return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
      }
      const originalDecide=path.match(/^\/api\/intercept\/pending\/(\d+)\/decide$/);
      if(originalDecide&&req.method==='POST'){
        let input:Record<string,unknown>;try{input=await readObject(req,1024*1024,true);}catch(error){return json(res,400,{error:(error as Error).message});}
        if(input.decision!=='allowed'&&input.decision!=='denied')return json(res,400,{error:"decision must be allowed or denied"});
        const result=await ctx.intercept.decide(Number(originalDecide[1]),input.decision==='allowed'?'approved':'denied');
        return result.ok?json(res,200,{ok:true}):json(res,result.status,{error:result.status===409?"The approval has been processed or does not exist, please refresh the record":result.error});
      }
      // ── F06 Tool execution read model ──
      if (path === "/api/commands" && req.method === "GET") {
        // ListCommands：activity Table tool_use Left pair tool_result
        // （Unpaired running tools reserved); zero-based paging default 0/50；q Match tool or enter detail；
        // task The parameters are exploration id（Original commandTaskFilter Direct analysis）；total Same filter。
        const page = Math.max(0,logInteger(url.searchParams.get("page"),0));
        const requestedSize=logInteger(url.searchParams.get("size"),50),size=requestedSize<=0?50:requestedSize;
        const q = url.searchParams.get("q") ?? "";
        const expID = await commandExplorationFilter(ctx.pool,url);
        const where: string[] = ["u.kind = 'tool_use'"];
        const args: unknown[] = [];
        if (expID !== null) { args.push(expID); where.push(`u.exploration_id = $${args.length}`); }
        if (q) { args.push(`%${q}%`); where.push(`(u.tool ILIKE $${args.length} OR u.detail ILIKE $${args.length})`); }
        const whereSql = "WHERE " + where.join(" AND ");
        const total = (await ctx.pool.query(`SELECT count(*)::int AS n FROM activity u ${whereSql}`, args)).rows[0] as { n: number };
        const rows = await ctx.pool.query(
          `SELECT u.id, u.exploration_id, COALESCE(u.worker,'') AS worker, COALESCE(u.tool,'') AS tool,
                  COALESCE(u.detail,'') AS command, COALESCE(r.detail,'') AS output,
                  COALESCE(r.is_error,false) AS is_error, u.created_at
           FROM activity u
           LEFT JOIN activity r ON r.tool_use_id = u.tool_use_id AND r.kind = 'tool_result'
           ${whereSql} ORDER BY u.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, size, page * size],
        );
        return json(res, 200, {
          commands: rows.rows.map((c: Record<string, unknown>) => ({
            id: Number(c.id),
            exploration_id: Number(c.exploration_id),
            worker: String(c.worker),
            tool: String(c.tool),
            command: String(c.command),
            output: String(c.output),
            is_error: c.is_error === true,
            created_at: c.created_at,
          })),
          total: total.n,
        });
      }
      if (path === "/api/commands/stats" && req.method === "GET") {
        // ToolStats：Aggregation by tool under the same filter total/errors（Complete collection, not the current page）
        const q = url.searchParams.get("q") ?? "";
        const expID = await commandExplorationFilter(ctx.pool,url);
        const where: string[] = ["u.kind = 'tool_use'"];
        const args: unknown[] = [];
        if (expID !== null) { args.push(expID); where.push(`u.exploration_id = $${args.length}`); }
        if (q) { args.push(`%${q}%`); where.push(`(u.tool ILIKE $${args.length} OR u.detail ILIKE $${args.length})`); }
        const rows = await ctx.pool.query(
          `SELECT COALESCE(NULLIF(u.tool,''),'-') AS tool, count(*)::int AS total,
                  count(*) FILTER (WHERE COALESCE(r.is_error,false))::int AS errors
           FROM activity u
           LEFT JOIN activity r ON r.tool_use_id = u.tool_use_id AND r.kind = 'tool_result'
           ${"WHERE " + where.join(" AND ")} GROUP BY 1 ORDER BY count(*) DESC,tool ASC`,
          args,
        );
        return json(res, 200, { stats: rows.rows });
      }
      // ── F20 Log ──
      if (path === "/api/logs" && req.method === "GET") {
        // Control getLogs：Memory ring of since/limit Incremental read，cursor=Current maximum seq
        const since = logInteger(url.searchParams.get("since"),0);
        const limit = logInteger(url.searchParams.get("limit"),500);
        const { lines, cursor } = logSink.recent(since, limit);
        return json(res, 200, { items: lines, cursor });
      }
      if (path === "/api/logs/history" && req.method === "GET") {
        // Control getLogsHistory：DB Reverse paging before=<db_id>，limit≤500，has_more
        const before = logInteger(url.searchParams.get("before"),0);
        const limit = logInteger(url.searchParams.get("limit"),200);
        try{return json(res,200,await recentDbLogs(ctx.pool,before,limit));}catch(error){return json(res,500,{error:'db: '+(error as Error).message});}
      }
      if (path === "/api/logs/stream" && req.method === "GET") {
        streamLogs(req,res);
        return;
      }
      // ── F07 LLM Recording/Dosage ──
      if (path === "/api/llm/records" && req.method === "GET") {
        const recs = await ctx.obs.llmRecords(200, url.searchParams.get("model") ?? undefined);
        return json(res, 200, { records: recs, total: recs.length });
      }
      const llmRecMatch = path.match(/^\/api\/llm\/records\/(\d+)$/);
      if (llmRecMatch && req.method === "GET") {
        const d = await ctx.obs.llmRecordDetail(Number(llmRecMatch[1]));
        return d ? json(res, 200, d) : json(res, 404, { error: "Record does not exist" });
      }
      if (path === "/api/llm/records/by-model" && req.method === "GET") {
        // WORMHOLE Contract：{models:[ModelTokenStat]}；task=40 Filter business task-40*（planner/worker）。
        const task = url.searchParams.get("task");
        const model = url.searchParams.get("model");
        const where: string[] = [];
        const args: unknown[] = [];
        if (model) { args.push(model); where.push(`model=$${args.length}`); }
        if (task) { args.push(task); where.push(`(business_id=$${args.length} OR business_id LIKE 'task-' || $${args.length} || '%')`); }
        const r = await ctx.pool.query(
          `SELECT COALESCE(model,'') AS model, count(*)::int AS calls,
                  sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
                  sum(cache_read)::int AS cache_read_tokens, sum(cache_write)::int AS cache_write_tokens
           FROM llm_usage ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY 1 ORDER BY 1`,
          args,
        );
        return json(res, 200, { models: r.rows });
      }
      if (path === "/api/llm/records/tasks" && req.method === "GET") {
        const r = await ctx.pool.query(
          `SELECT business_id, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
           FROM llm_usage WHERE business_kind IN ('task','worker','planner') GROUP BY business_id ORDER BY input_tokens DESC LIMIT 100`,
        );
        return json(res, 200, r.rows);
      }
      if((path==='/api/tokens/usage'||path==='/api/tokens/usage/calls')&&req.method==='GET'){
        try{
          const meter=new TokenMeter(ctx.pool);
          return json(res,200,path.endsWith('/calls')?await meter.calls(url.searchParams):await meter.usage(url.searchParams));
        }catch(e){if(e instanceof MeterQueryError)return json(res,400,{error:e.message});throw e;}
      }
      if (path === "/api/tokens/daily" && req.method === "GET") {
        return json(res, 200, await ctx.obs.usageDaily());
      }
      if (path === "/api/tokens/conversations" && req.method === "GET") {
        return json(res, 200, await ctx.obs.usageByConversation());
      }
      // ── F08 Asset / F18 Asset Interception ──
      const taskAssetMatch = path.match(/^\/api\/tasks\/(\d+)\/assets$/);
      if (taskAssetMatch && req.method === "GET") {
        return json(res, 200, await ctx.assets.taskAssets(Number(taskAssetMatch[1])));
      }
      // ── F04 Discovery / F16 Notice / F05 Traffic Record ──
      if (path === "/api/exploration/findings" && req.method === "GET") {
        // WORMHOLE Dual Mode Contract: With page/limit → {items,total,page,page_size}（Discovery page paging）；
        // Without → Naked array（dashboard Summary，api.findings().then(arr)，Upper limit 500 alignment baseline）。
        const hasPaging = url.searchParams.get("page") !== null || url.searchParams.get("limit") !== null;
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
        const pageSize = Math.max(1, Number(url.searchParams.get("limit") ?? "10") || 10);
        const taskParam = url.searchParams.get("task");
        const r = await ctx.findings.page({
          task: taskParam && taskParam !== "all" ? Number(taskParam) : undefined,
          severity: url.searchParams.get("severity") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
        }, page, hasPaging ? pageSize : 500);
        const items = r.items.map((f: Record<string, unknown>) => ({
          id: String(f.id),
          finding_id: String(f.id),
          vulnclass: String(f.vulnclass ?? ""),
          name: String(f.name ?? ""),
          severity: String(f.severity ?? "medium"),
          status: String(f.status ?? "pending"),
          summary: String(f.summary ?? f.detail ?? ""),
          evidence: typeof f.evidence === "string" ? f.evidence : JSON.stringify(f.evidence ?? ""),
          task_id: f.task_id != null ? String(f.task_id) : undefined,
          ts: f.created_at,
          assets: ((f.asset_values as unknown[] | null) ?? []).filter((v) => v != null).map((v) => ({ id: String(v), type: "", label: String(v) })),
        }));
        return json(res, 200, hasPaging ? { items, total: r.total, page, page_size: pageSize } : items);
      }
      if (path === "/api/exploration/findings" && req.method === "POST") {
        res.writeHead(405); res.end(); return;
      }
      const findingMatch = path.match(/^\/api\/exploration\/findings\/(\d+)(\/status)?$/);
      if (findingMatch) {
        const id = Number(findingMatch[1]);
        if (!findingMatch[2] && req.method === "GET") {
          const f = await ctx.findings.get(id);
          return f ? json(res, 200, f) : json(res, 404, { error: "finding does not exist" });
        }
        if (!findingMatch[2] && req.method === "DELETE") {
          const ok = await ctx.findings.remove(id);
          return ok ? json(res, 200, { status: "ok" }) : json(res, 404, { error: "finding does not exist" });
        }
        if (findingMatch[2] === "/status" && req.method === "PUT") {
          const body = await readJson(req);
          const r = await ctx.findings.changeStatus(id, String(body?.status ?? ""));
          return r.ok ? json(res, 200, { status: "ok" }) : json(res, r.status!, { error: r.error });
        }
      }
// ── F01 Dashboard ──
      if (path === "/api/stats" && req.method === "GET") {
        const counts = await ctx.assets.counts();
        const assetsTotal = Object.values(counts).reduce((a, b) => a + b, 0);
        const running = await ctx.pool.query("SELECT count(*)::int AS n FROM tasks WHERE status='running' AND archived=FALSE");
        const hasProfile = await ctx.pool.query("SELECT 1 FROM llm_profiles WHERE is_default=TRUE LIMIT 1");
        const s = await ctx.settings.payload();
        return json(res, 200, {
          asset_counts: counts,
          assets: assetsTotal,
          roe_enabled: false,
          findings_confirmed: 0,
          engine_mode: (running.rows[0] as { n: number }).n > 0 ? "running" : "idle",
          llm_configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) || (hasProfile.rowCount ?? 0) > 0,
          traffic: ctx.traffic?.store.count()??0,
          traffic_enabled: ctx.traffic?.enabled()??false,
        });
      }
      // Mission details each Data entry for tab data entry。
      const tabMatch = path.match(/^\/api\/tasks\/(\d+)\/(overview|coverage|sessions|graph|broadcast|retests|report)$/);
      if (tabMatch && req.method === "GET") {
        const id = Number(tabMatch[1]);
        const tab = tabMatch[2]!;
        const task = await ctx.tasks.get(id);
        if (!task) return json(res, 404, { error: "Task does not exist" });
        if (tab === "overview") {
          return json(res, 200, { task, tabs: ["overview", "coverage", "assets", "intercept-rules", "findings", "sessions", "graph", "broadcast", "retests", "report"] });
        }
        if (tab === "sessions") {
          const s = await ctx.pool.query(
            "SELECT id, title, state, claimed_by, attempts FROM exploration_nodes WHERE task_id=$1 ORDER BY id",
            [id],
          );
          return json(res, 200, { sessions: s.rows });
        }
        if (tab === "graph") {
          const nodes = await ctx.pool.query(
            "SELECT id, title AS label, state, priority FROM exploration_nodes WHERE task_id=$1 ORDER BY id",
            [id],
          );
          return json(res, 200, { nodes: nodes.rows, edges: [] });
        }
        if (tab === "broadcast") {
          const m = await ctx.pool.query(
            `SELECT e.seq,e.event_type,e.payload,e.cold_archive_id,a.manifest_hash AS cold_manifest_hash FROM business_events e
             LEFT JOIN storage_event_archives a ON a.id=e.cold_archive_id WHERE e.business_kind='task' AND e.business_id=$1 ORDER BY seq DESC LIMIT 50`,
            [String(id)],
          );
          return json(res, 200, { messages: (await hydrateColdEvents(m.rows.reverse(),ctx.config.dataDir)).map(row=>({seq:row.seq,event_type:row.event_type,payload:replaySessionPayload(row.event_type,row.payload)})) });
        }
        if (tab === "retests") {
          const r = await ctx.pool.query(
            "SELECT fr.id, fr.status, fr.created_at, f.name AS finding_name FROM finding_retests fr JOIN findings f ON f.id = fr.finding_id WHERE f.task_id = $1 ORDER BY fr.id",
            [id],
          );
          return json(res, 200, { retests: r.rows });
        }
        if (tab === "report") {
          const markdown=await taskMarkdown(ctx.pool,id);
          res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8'});res.end(markdown);return;
        }
      }
      // ── Equivalence Alignment: New Routing for Baseline Measured Shapes ──
      if (path === "/api/task-categories" && req.method === "GET") {
        const r = await ctx.pool.query("SELECT c.*, (SELECT count(*)::int FROM tasks t WHERE t.category_id = c.id AND t.kind='pentest' AND t.deleted_at IS NULL AND NOT t.archived) AS task_count FROM task_categories c ORDER BY id");
        return json(res, 200, { categories: r.rows.map((row: Record<string, unknown>) => ({ ...row, id: Number(row.id), updated_at: row.updated_at ?? row.created_at })) });
      }
      if (path === "/api/task-categories" && req.method === "POST") {
        const body = await readJson(req);
        const name = String(body?.name ?? "").trim();
        if (!name) return json(res, 400, { error: "Category name cannot be empty" });
        const exists = await ctx.pool.query("SELECT 1 FROM task_categories WHERE name=$1", [name]);
        if ((exists.rowCount ?? 0) > 0) return json(res, 400, { error: "Category already exists" });
        const r = await ctx.pool.query("INSERT INTO task_categories (name) VALUES ($1) RETURNING *", [name]);
        return json(res, 201, { id: Number((r.rows[0] as { id: string }).id), name: (r.rows[0] as { name: string }).name, task_count: 0, created_at: (r.rows[0] as { created_at: Date }).created_at, updated_at: (r.rows[0] as { created_at: Date }).created_at });
      }
      const catMatch = path.match(/^\/api\/task-categories\/(\d+)$/);
      if (catMatch && req.method === "DELETE") {
        const r = await ctx.pool.query("DELETE FROM task_categories WHERE id=$1", [Number(catMatch[1])]);
        return (r.rowCount ?? 0) > 0 ? json(res, 200, { status: "ok" }) : json(res, 404, { error: "Category does not exist" });
      }
      if(await routeTaskTemplates(req,res,url,ctx.pool,json))return;
      if (path === "/api/exploration/findings/stats" && req.method === "GET") {
        const s = await ctx.pool.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE severity='critical')::int AS critical, count(*) FILTER (WHERE severity='high')::int AS high, count(*) FILTER (WHERE severity='medium')::int AS medium, count(*) FILTER (WHERE severity='low')::int AS low FROM findings",
        );
        const vc = await ctx.pool.query("SELECT DISTINCT vulnclass FROM findings WHERE vulnclass <> '' ORDER BY 1");
        // tasks：Vulnerable task drop-down item（FindingTaskOption），pending Credited open（Difference in target side status naming）。
        const tk = await ctx.pool.query(
          `SELECT t.id::text AS id, COALESCE(t.name,'') AS name, COALESCE(t.description,'') AS description, count(f.id)::int AS count
           FROM findings f JOIN tasks t ON t.id = f.task_id GROUP BY t.id, t.name, t.description ORDER BY count(f.id) DESC`,
        );
        const st = s.rows[0] as Record<string, number>;
        const pend = (await ctx.pool.query("SELECT count(*)::int AS n FROM findings WHERE status IN ('pending','open')")).rows[0] as { n: number };
        return json(res, 200, {
          total: st.total, pending: pend.n, critical: st.critical, high: st.high, medium: st.medium, low: st.low,
          vulnclasses: vc.rows.map((x) => (x as { vulnclass: string }).vulnclass), tasks: tk.rows,
        });
      }
      if (path === "/api/exploration/findings/groups" && req.method === "GET") {
        // WORMHOLE FindingGroup：Group by task（task_id null=Not associated) with severity binning and last discovery time。
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
        const pageSize = Math.max(1, Number(url.searchParams.get("page_size") ?? url.searchParams.get("limit") ?? "10") || 10);
        const total = (await ctx.pool.query("SELECT count(DISTINCT task_id)::int AS n FROM findings")).rows[0] as { n: number };
        const items = await ctx.pool.query(
          `SELECT COALESCE(f.task_id, 0)::bigint AS task_key,
                  CASE WHEN t.id IS NULL THEN '' ELSE COALESCE(t.name,'') END AS task_name,
                  COALESCE(t.description,'') AS task_description, COALESCE(t.status,'') AS task_status,
                  count(*)::int AS count,
                  count(*) FILTER (WHERE f.severity='critical')::int AS critical,
                  count(*) FILTER (WHERE f.severity='high')::int AS high,
                  count(*) FILTER (WHERE f.severity='medium')::int AS medium,
                  count(*) FILTER (WHERE f.severity='low')::int AS low,
                  max(f.created_at) AS last_found_at
           FROM findings f LEFT JOIN tasks t ON t.id = f.task_id
           GROUP BY f.task_id, t.id, t.name, t.description, t.status
           ORDER BY count(*) DESC LIMIT $1 OFFSET $2`,
          [pageSize, (page - 1) * pageSize],
        );
        const ft = (await ctx.pool.query("SELECT count(*)::int AS n FROM findings")).rows[0] as { n: number };
        const mapped = items.rows.map((g: Record<string, unknown>) => ({
          task_id: Number(g.task_key) === 0 ? null : String(g.task_key),
          task_name: g.task_name || undefined,
          task_description: String(g.task_description ?? ""),
          task_status: String(g.task_status ?? ""),
          count: Number(g.count), critical: Number(g.critical), high: Number(g.high), medium: Number(g.medium), low: Number(g.low),
          last_found_at: g.last_found_at,
        }));
        return json(res, 200, { finding_total: ft.n, items: mapped, page, page_size: pageSize, total: total.n });
      }
      if (path === "/api/intercept/tool-config" && req.method === "GET") {
        // Baseline semantics: List of built-in tools that enable interception control (code constants), non-catalog full set
        return json(res, 200, { enabled_tools: ["Bash", "WebFetch", "web_search", "shell_open", "shell_send", "Write", "Edit", "MultiEdit"] });
      }
      if (path === "/api/intercept/judge" && req.method === "GET") {
        const r = await ctx.pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'");
        const def = { enabled: false, profile_id: 0, prompt: "", timeout_seconds: 15, fail_action: "allow", ask_timeout_seconds: 300, ask_timeout_action: "deny" };
        const cfg = r.rows[0] ? (JSON.parse(String(r.rows[0].value)) as typeof def) : def;
        return json(res, 200, cfg);
      }
      if (path === "/api/intercept/judge" && req.method === "POST") {
        const body = (await readJson(req)) ?? {};
        const cur = await ctx.pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'");
        const defaults = { enabled: false, profile_id: 0, prompt: "", timeout_seconds: 15, fail_action: "allow", ask_timeout_seconds: 300, ask_timeout_action: "deny" };
        const cfg = cur.rows[0] ? { ...defaults, ...JSON.parse(String(cur.rows[0].value)) } : defaults;
        const next = { ...cfg, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null)) };
        await ctx.pool.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('intercept.judge',$1,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(next)]);
        return json(res, 200, next);
      }
      if (path === "/api/chat" && req.method === "POST") {
        const taskId = Number(url.searchParams.get("task") ?? "0");
        const body = await readJson(req);
        let attachments;try{attachments=validAttachments(body?.attachments);}catch(e){return json(res,400,{error:(e as Error).message});}
        const r = await ctx.taskChat.send(taskId, String(body?.message ?? ""), body?.seg !== undefined && body.seg !== null ? Number(body.seg) : undefined,attachments);
        return r.status === 202 ? json(res, 202, { status: "accepted" }) : json(res, r.status, { error: r.error });
      }
      if (path === "/api/exploration/findings/export" && req.method === "GET") {
        return json(res, 200, await ctx.findingsWorkflow.export({ severity: url.searchParams.get("severity") ?? undefined, status: url.searchParams.get("status") ?? undefined }));
      }
      // ── Remaining 39 routes (front-end page depends on）──

      // ── F03 rerun：Single/Batch rerun──
      const rerunBlockedM = path.match(/^\/api\/tasks\/(\d+)\/intents\/rerun-blocked$/);
      if (rerunBlockedM && req.method === "POST") {
        const id = Number(rerunBlockedM[1]);
        if (ctx.taskEngine.isDeleting(id)) return json(res, 409, { error: "The task is being deleted and the intent cannot be rerun." });
        // Snapshot (for rollback)）→ Batch reopening blocked → Resurrection task; rollback each task if failed
        const before = await ctx.pool.query("SELECT id, state, blocked_reason FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state='blocked'", [id]);
        const reopened = await ctx.pool.query(
          "UPDATE exploration_nodes SET state='open', completed_at=NULL, blocked_reason=NULL, updated_at=now() WHERE task_id=$1 AND kind='intent' AND state='blocked' RETURNING id",
          [id],
        );
        const n = reopened.rowCount ?? 0;
        if (n > 0) {
          const revived = await reviveTaskForRerun(ctx, id);
          if (!revived.ok) {
            for (const b of before.rows as { id: number; state: string; blocked_reason: string | null }[]) {
              await ctx.pool.query("UPDATE exploration_nodes SET state=$2, blocked_reason=$3, completed_at=CASE WHEN $2 IN ('blocked','exhausted','stopped') THEN now() ELSE NULL END WHERE id=$1", [b.id, b.state, b.blocked_reason]).catch(() => {});
            }
            return json(res, 500, { error: revived.error });
          }
          await appendTaskEvent(ctx, id, "intents_rerun_blocked", { reopened: n });
        }
        return json(res, 200, { id: String(id), reopened: n, queued: false });
      }
      const rerunM = path.match(/^\/api\/tasks\/(\d+)\/intents\/(\d+)\/rerun$/);
      if (rerunM && req.method === "POST") {
        const id = Number(rerunM[1]);
        const iid = Number(rerunM[2]);
        if (ctx.taskEngine.isDeleting(id)) return json(res, 409, { error: "The task is being deleted and the intent cannot be rerun." });
        const before = (await ctx.pool.query("SELECT id, state, blocked_reason FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND kind='intent'", [iid, id])).rows[0] as { id: number; state: string; blocked_reason: string | null } | undefined;
        if (!before) return json(res, 404, { error: "Intent does not exist" });
        const reopened = await ctx.pool.query(
          "UPDATE exploration_nodes SET state='open', completed_at=NULL, blocked_reason=NULL, updated_at=now() WHERE id=$1 AND task_id=$2 AND kind='intent' AND state IN ('blocked','exhausted','stopped') RETURNING id",
          [iid, id],
        );
        if ((reopened.rowCount ?? 0) === 0) return json(res, 409, { error: "The intent is not rerunable (only blocked/exhausted/stopped can be rerun)" });
        const revived = await reviveTaskForRerun(ctx, id);
        if (!revived.ok) {
          await ctx.pool.query("UPDATE exploration_nodes SET state=$2, blocked_reason=$3, completed_at=CASE WHEN $2 IN ('blocked','exhausted','stopped') THEN now() ELSE NULL END WHERE id=$1", [before.id, before.state, before.blocked_reason]).catch(() => {});
          return json(res, 500, { error: revived.error });
        }
        await appendTaskEvent(ctx, id, "intent_rerun", { intentId: iid });
        return json(res, 200, { id: String(id), reopened: iid, queued: false });
      }
      if (path === "/api/exploration/intents" && req.method === "GET") {
        // WORMHOLE Contract: Naked TaskNode[]（api.intents.then(arr)），type=Node kind、payload=Title。
        const taskId = Number(url.searchParams.get("task") ?? "0");
        const rows = await ctx.pool.query("SELECT id, kind, title, priority, state, origin, delete_reason, created_at FROM exploration_nodes WHERE task_id=$1 ORDER BY priority DESC, id", [taskId]);
        return json(res, 200, rows.rows.map((n: Record<string, unknown>) => ({
          id: String(n.id), type: String(n.kind ?? "intent"), payload: String(n.title ?? ""),
          priority: Number(n.priority ?? 0), state: String(n.state ?? "open"),
          origin: String(n.origin ?? ""), ts: n.created_at,
          delete_reason: n.delete_reason ?? undefined,
        })));
      }
      if (path === "/api/exploration/nodes" && req.method === "GET") {
        const taskId = Number(url.searchParams.get("task") ?? "0");
        const rows = await ctx.pool.query("SELECT * FROM exploration_nodes WHERE task_id=$1 ORDER BY id", [taskId]);
        return json(res, 200, { nodes: rows.rows });
      }
      if (path === "/api/exploration/graph" && req.method === "GET") {
        const taskId = Number(url.searchParams.get("task") ?? "0");
        const nodes = await ctx.pool.query("SELECT id, title AS label, state, priority FROM exploration_nodes WHERE task_id=$1 ORDER BY id", [taskId]);
        return json(res, 200, { nodes: nodes.rows, edges: [] });
      }
      if (path === "/api/exploration/frontier" && req.method === "GET") {
        const taskId = Number(url.searchParams.get("task") ?? "0");
        const rows = await ctx.pool.query("SELECT id, title, priority, state FROM exploration_nodes WHERE task_id=$1 AND state = 'open' ORDER BY priority DESC, id", [taskId]);
        return json(res, 200, { frontier: rows.rows });
      }
      if (path === "/api/exploration/findings/asset-tree" && req.method === "GET") {
        // WORMHOLE FindingAssetTree：nodes（key=a:<id> / __none__）+ finding_total + truncated。
        const rows = await ctx.pool.query(
          `SELECT a.id AS asset_id, a.type AS kind, a.value AS label,
                  count(f.id)::int AS self,
                  count(*) FILTER (WHERE f.severity='critical')::int AS critical,
                  count(*) FILTER (WHERE f.severity='high')::int AS high,
                  count(*) FILTER (WHERE f.severity='medium')::int AS medium,
                  count(*) FILTER (WHERE f.severity='low')::int AS low,
                  max(f.created_at) AS last_found_at
           FROM assets a JOIN findings f ON a.id = ANY(ARRAY(SELECT jsonb_array_elements_text(f.asset_ids))::bigint[])
           GROUP BY a.id, a.type, a.value ORDER BY self DESC LIMIT 500`,
        );
        const ft = (await ctx.pool.query("SELECT count(*)::int AS n FROM findings")).rows[0] as { n: number };
        const unassigned = (await ctx.pool.query("SELECT count(*)::int AS n FROM findings f WHERE f.asset_ids IS NULL OR f.asset_ids = '[]'::jsonb OR NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = ANY(ARRAY(SELECT jsonb_array_elements_text(f.asset_ids))::bigint[]))")).rows[0] as { n: number };
        const nodes: Record<string, unknown>[] = rows.rows.map((n: Record<string, unknown>) => ({
          key: "a:" + n.asset_id, kind: String(n.kind ?? "endpoint"), label: String(n.label ?? ""),
          asset_id: Number(n.asset_id), self: Number(n.self), total: Number(n.self),
          critical: Number(n.critical), high: Number(n.high), medium: Number(n.medium), low: Number(n.low),
          last_found_at: n.last_found_at,
        }));
        if (unassigned.n > 0) {
          nodes.push({ key: "__none__", kind: "none", asset_id: undefined, label: "Unassociated assets", self: unassigned.n, total: unassigned.n, critical: 0, high: 0, medium: 0, low: 0, last_found_at: null });
        }
        return json(res, 200, { nodes, finding_total: ft.n, truncated: rows.rows.length >= 500 });
      }
      const lineageMatch = path.match(/^\/api\/exploration\/findings\/(\d+)\/lineage$/);
      if (lineageMatch && req.method === "GET") {
        const graph = await new FindingLineage(ctx.pool).read(Number(lineageMatch[1]));
        return graph ? json(res, 200, graph) : json(res, 404, { error: "finding does not exist" });
      }
      const chatStatusMatch = path.match(/^\/api\/tasks\/(\d+)\/chat\/status$/);
      if (chatStatusMatch && req.method === "GET") {
        const id=Number(chatStatusMatch[1]),owner=(await ctx.pool.query("SELECT c.id FROM conversations c JOIN tasks t ON t.id=c.task_id WHERE t.id=$1 AND t.queue_mode='pentest_chat'",[id])).rows[0];
        const busy=owner?ctx.conversations.isRunning(Number(owner.id)):ctx.taskChat?.isBusy?.(id)??false;
        return json(res, 200, { running:busy,busy });
      }
      const chatStopMatch=path.match(/^\/api\/tasks\/(\d+)\/chat\/stop$/);
      if(chatStopMatch&&req.method==='POST'){await ctx.taskChat.stopTask(Number(chatStopMatch[1]));return json(res,200,{status:'stopped'});}
      const goalsMatch = path.match(/^\/api\/tasks\/(\d+)\/goals$/);
      if (goalsMatch && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT id, title, state FROM exploration_nodes WHERE task_id=$1 AND kind='goal' ORDER BY id", [Number(goalsMatch[1])]);
        return json(res, 200, { goals: rows.rows });
      }
      const scopeMatch = path.match(/^\/api\/tasks\/(\d+)\/scope$/);
      if (scopeMatch && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT * FROM assets WHERE task_ids @> ARRAY[$1::bigint] ORDER BY id", [Number(scopeMatch[1])]);
        return json(res, 200, { scope: rows.rows });
      }
      const constraintsMatch = path.match(/^\/api\/tasks\/(\d+)\/constraints$/);
      if (constraintsMatch) {
        if (req.method === "GET") { const rows = await ctx.pool.query("SELECT * FROM task_constraints WHERE task_id=$1 ORDER BY id", [Number(constraintsMatch[1])]); return json(res, 200, { constraints: rows.rows }); }
        if (req.method === "POST") { const b = await readJson(req); const r = await ctx.pool.query("INSERT INTO task_constraints (task_id, text) VALUES ($1,$2) RETURNING *", [Number(constraintsMatch[1]), String(b?.text ?? "")]); return json(res, 200, r.rows[0]); }
      }
      const intentAssetsMatch = path.match(/^\/api\/tasks\/(\d+)\/intent-assets$/);
      if (intentAssetsMatch && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT a.* FROM assets a WHERE a.task_ids @> ARRAY[$1::bigint] ORDER BY a.id", [Number(intentAssetsMatch[1])]);
        return json(res, 200, { assets: rows.rows });
      }
      // ── F03 Cold archive──
      if (path === "/api/task-archives" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? "0") || 0;
        const size = Number(url.searchParams.get("size") ?? "20") || 20;
        return json(res, 200, await ctx.taskArchives!.list((url.searchParams.get("q") ?? "").trim(), (url.searchParams.get("state") ?? "").trim(), page, size));
      }
      const archRestoreM = path.match(/^\/api\/task-archives\/(\d+)\/restore$/);
      if (archRestoreM && req.method === "POST") {
        try { return json(res, 202, await ctx.taskArchives!.queueRestore(Number(archRestoreM[1]))); }
        catch (e) { return json(res, (e as { status?: number }).status ?? 500, { error: String((e as Error).message ?? e) }); }
      }
      const archBatchM = /^\/api\/tasks\/archive\/batch$/.exec(path);
      if (archBatchM && req.method === "POST") {
        const body = (await readJson(req)) as { task_ids?: string[] } | null;
        const ids = (body?.task_ids ?? []).map((x) => Number(String(x).replace(/^task-/, ""))).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) return json(res, 400, { error: "task_ids cannot be empty" });
        if (ids.length > 100) return json(res, 400, { error: "Maximum of 100 tasks processed at one time" });
        const items = [];
        for (const id of ids) {
          try { const a = await ctx.taskArchives!.queue(id); items.push({ id: String(id), ok: true, queued: true, archive_id: a.id }); }
          catch (e) { items.push({ id: String(id), ok: false, queued: false, error: String((e as Error).message ?? e) }); }
        }
        return json(res, 202, { items });
      }
      const archMatch = path.match(/^\/api\/task-archives\/(\d+)$/);
      if (archMatch) {
        if (req.method === "GET") { const a = await ctx.taskArchives!.get(Number(archMatch[1])); return a ? json(res, 200, a) : json(res, 404, { error: "Archive does not exist" }); }
        if (req.method === "DELETE") { try { return json(res, 202, await ctx.taskArchives!.queueDelete(Number(archMatch[1]))); } catch (e) { return json(res, (e as { status?: number }).status ?? 500, { error: String((e as Error).message ?? e) }); } }
      }
      if (path === "/api/audit" && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT * FROM tool_calls ORDER BY id DESC LIMIT 100");
        return json(res, 200, { items: rows.rows, total: rows.rows.length });
      }
      if (path === "/api/chat/mentions" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const agents = await ctx.pool.query("SELECT key, name FROM agents WHERE enabled=TRUE ORDER BY key");
        const matched = agents.rows.filter((a: { key?: string; name?: string }) => (a.key ?? "").toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q));
        return json(res, 200, { mentions: matched.map((a: Record<string, string>) => ({ type: "agent", id: a.key, label: a.name })) });
      }
      if (path === "/api/report" && req.method === "GET") {
        const taskId=url.searchParams.has('task')?Number(url.searchParams.get('task')):Number((await ctx.pool.query("SELECT id FROM tasks WHERE kind='pentest' AND deleted_at IS NULL AND NOT archived ORDER BY id DESC LIMIT 1")).rows[0]?.id??0);
        const markdown=await taskMarkdown(ctx.pool,taskId);
        if(markdown===null)return json(res,404,{error:'no active task'});
        res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8'});res.end(markdown);return;
      }
      const execMatch = path.match(/^\/api\/intercept\/history\/(\d+)\/execution$/);
      if (execMatch && req.method === "GET") {
        const r = await ctx.pool.query("SELECT c.* FROM tool_approvals a JOIN tool_calls c ON c.id = a.tool_call_id WHERE a.id=$1", [Number(execMatch[1])]);
        return (r.rowCount ?? 0) > 0 ? json(res, 200, { execution: r.rows[0] }) : json(res, 404, { error: "Execution record does not exist" });
      }
      if (path === "/api/intercept/judge/usage" && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT count(*)::int AS n FROM business_events WHERE event_type = 'judge_eval'");
        return json(res, 200, { usage: rows.rows[0] });
      }
      const taskIntMatch = path.match(/^\/api\/intercept\/task\/(\d+)$/);
      if (taskIntMatch && req.method === "GET") {
        const rows = await ctx.pool.query("SELECT * FROM task_intercept_rules WHERE task_id=$1 ORDER BY id", [Number(taskIntMatch[1])]);
        return json(res, 200, { rules: rows.rows });
      }
      if(req.method==='POST'&&(path==='/api/visibility/skill/toggle'||path==='/api/visibility/toggle')){
        let body;try{body=await readObject(req,1024*1024,true);}catch(error){return json(res,400,{error:(error as Error).message});}
        const kind=path==='/api/visibility/skill/toggle'?'skill':body.kind;
        const key=body.agent_id;
        if(typeof key!=='string'||!key||typeof body.visible!=='boolean'||!['skill','mcp'].includes(kind))return json(res,400,{error:'invalid visibility request'});
        if(!(await ctx.pool.query('SELECT 1 FROM agents WHERE key=$1',[key])).rowCount)return json(res,404,{error:'agent not found'});
        let resource:string;
        if(kind==='skill'){
          if(typeof body.skill_name!=='string'||!(await ctx.skills.list()).some(s=>s.name===body.skill_name))return json(res,404,{error:'skill not found'});
          resource=body.skill_name;
        }else{
          if(!Number.isSafeInteger(body.resource_id)||body.resource_id<=0)return json(res,400,{error:'invalid MCP id'});
          if(!(await ctx.pool.query('SELECT 1 FROM mcp_servers WHERE id=$1',[body.resource_id])).rowCount)return json(res,404,{error:'MCP not found'});
          resource=String(body.resource_id);
        }
        if(body.visible)await ctx.pool.query('INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[key,kind,resource]);
        else await ctx.pool.query('DELETE FROM agent_visibility WHERE agent_key=$1 AND resource_kind=$2 AND resource_id=$3',[key,kind,resource]);
        return json(res,200,{ok:true});
      }
      const visMatch = path.match(/^\/api\/visibility\/([^/]+)\/([^/]+)$/);
      if (visMatch && req.method === "GET") {
        const kind = visMatch[1] === "skill" ? "skill" : visMatch[1] === "mcp" ? "mcp" : "tool";
        const id = decodeURIComponent(visMatch[2]!);
        const rows = await ctx.pool.query("SELECT agent_key FROM agent_visibility WHERE resource_kind=$1 AND resource_id=$2", [kind, id]);
        return json(res, 200, { agents: rows.rows.map((r: Record<string, string>) => r.agent_key) });
      }
      if (path === "/api/update/check" && req.method === "GET") {
        return json(res, 200, { update_available: false, version: "0.1.0" });
      }
      if (path === "/api/update/stream" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write("data: {\"status\":\"no_update\"}\n\n"); res.end(); return;
      }
      const profMatch = path.match(/^\/api\/llm\/profiles\/(\d+)$/);
      if (profMatch) {
        const id = Number(profMatch[1]);
        if (req.method === "PUT") {
          const r = await ctx.llm.updateProfile(id, (await readJson(req)) ?? {});
          return r.ok ? json(res, 200, r.profile) : json(res, r.status, { error: r.error });
        }
      }
      if (path === "/api/llm/pool" && req.method === "GET") {
        const chain = await ctx.llm.poolChain();
        const s = await ctx.settings.payload();
        return json(res, 200, { enabled: s.llm_pool_enabled === true, bind_fallback: s.llm_pool_bind_fallback === true, chain });
      }
      if (path === "/api/llm/pool/reset" && req.method === "POST") {
        let body;try{body=await readObject(req,1024*1024,true);}catch(e){return json(res,400,{error:(e as Error).message});}if(body.id!=null&&!Number.isSafeInteger(body.id))return json(res,400,{error:'bad json'});
        await ctx.llm.resetPool(Number(body.id??0));const s=await ctx.settings.payload();
        return json(res, 200, {enabled:s.llm_pool_enabled===true,bind_fallback:s.llm_pool_bind_fallback===true,chain:await ctx.llm.poolChain()});
      }
      if (req.method === "GET" && path === "/api/events") {
        return await streamEvents(req, res, ctx.pool,ctx.config.dataDir);
      }
      return json(res, 404, {
        error: "not_found",
        path,
        method: req.method,
        detail: "The interface does not exist, please check the request path and method",
      });
    }
    return json(res, 404, { error: "not_found", path });
  } catch (err) {
    const requestId = randomUUID();
    console.error("[http] request failed", {
      request_id: requestId,
      method: req.method,
      path,
      detail: diagnosticErrorDetail(err),
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    return json(res, 500, {
      error: "internal",
      detail: "The service is temporarily unable to process the request. Please check the log by the request number.",
      request_id: requestId,
    });
  }
}

function diagnosticErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.name + ": " + error.message : String(error);
  return detail
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_ -]?key|token|password|secret|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"']+/gi, "[REDACTED URL]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 800);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** F03 rerun Resurrection: final state/Pause task reset running and restart the engine (cf. Resurrection branch of admitTask resume resurrection branch）。 */
async function reviveTaskForRerun(ctx: { pool: import("pg").Pool; tasks: import("../domains/tasks/service.ts").TaskService; taskEngine: import("../domains/tasks/engine.ts").TaskEngine }, id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await ctx.pool.query(
      "UPDATE tasks SET status='running', paused=FALSE, queued=FALSE, completed_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('paused','done','failed','timeout','created') AND deleted_at IS NULL AND archived=FALSE RETURNING status",
      [id],
    );
    await reopenExploration(ctx.pool,id);
    void ctx.taskEngine.launch(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}
/** Preserve original task=exploration contract; the UI uses actual task_id. */
async function commandExplorationFilter(pool:Pool,url:URL):Promise<number|null>{
  if(url.searchParams.has('task_id')){
    const id=url.searchParams.get('task_id')??'';
    if(!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<1)return -1;
    return Number((await pool.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[Number(id)])).rows[0]?.exploration_id??-1);
  }
  const value=url.searchParams.get('task')??'';
  return /^[+-]?\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
}
async function appendTaskEvent(ctx: { pool: import("pg").Pool }, id: number, event: string, payload: Record<string, unknown>): Promise<void> {
  const { appendEvent } = await import("../events/ledger.ts");
  await appendEvent(ctx.pool, "/tmp/pihost-events-dlq.jsonl", { business_kind: "task", business_id: String(id), event_type: event, payload }).catch(() => {});
}
