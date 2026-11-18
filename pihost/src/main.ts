import {FindingReports} from './domains/findings/report-jobs.ts';
import {bindExtension,extensionStates} from './domains/extensions/availability.ts';
import {existsSync} from 'node:fs';
import {REVERSE_ROOT} from './domains/reverse/runtime.ts';
import {NetworkChannels} from './domains/network/channels.ts';
import {bindNetworkProvider} from './domains/network/context.ts';
import {workspaceGate} from './domains/workspace/maintenance.ts';
import {applyTaskExecutionControl} from './domains/tasks/runtime-control.ts';
import {runTriggeredConversation} from './domains/agents/trigger-runner.ts';
import {notificationService} from './domains/notify/service.ts';
import { createServer } from "node:http";
import { setDefaultResultOrder } from 'node:dns';
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { runMigrations } from "./db/migrate.ts";
import { backfillDeadLetters, startBackfillLoop } from "./events/ledger.ts";
import { AuthService, authKeyPath } from "./auth/service.ts";
import { SettingsService } from "./domains/settings/service.ts";
import { SettingsConsumers } from "./domains/settings/consumers.ts";
import { LlmService } from "./domains/llm/service.ts";
import { AgentsService } from "./domains/agents/service.ts";
import { ToolsService } from "./domains/tools/service.ts";
import { McpService } from "./domains/mcp/service.ts";
import { SkillsService } from "./domains/skills/service.ts";
import { seedBuiltinSkills } from "./domains/skills/seed-builtin.ts";
import { seedReverseProxyTools } from "./domains/reverse/tools.ts";
import { seedCodeIntelTools } from "./domains/codeintel/tools.ts";
import { WorkspaceService } from "./domains/workspace/service.ts";
import { TaskService, TaskEngine } from "./domains/tasks/index.ts";
import { TriggerScheduler } from "./domains/tasks/scheduler.ts";
import { TaskChatService } from "./domains/tasks/chat.ts";
import { createHostedSession } from "./pi/session-host.ts";
import { ConversationsService } from "./domains/conversations/service.ts";
import { registerPlatformTools, chatToolsFor } from "./domains/tools/platform.ts";
import { runJudge } from "./domains/tools/judge.ts";
import { InterceptService } from "./domains/intercept/service.ts";
import { ObservabilityService } from "./domains/observability/service.ts";
import { AssetsService } from "./domains/assets/service.ts";
import { FindingsService } from "./domains/findings/service.ts";
import {EvidenceStore} from './domains/findings/evidence.ts';
import {seedEvidenceTools} from './domains/findings/evidence-tools.ts';
import { FindingsWorkflow } from "./domains/findings/workflow.ts";
import {FindingRetests} from './domains/findings/retests.ts';
import {TrafficRuntime} from './domains/traffic/runtime.ts';
import {TrafficFlow} from './domains/traffic/flow.ts';
import {registerCheckTools,seedCheckTools} from './domains/traffic/check-tools.ts';
import {bindTargetRoute} from './domains/traffic/network.ts';
import {TaskBrowsers} from './domains/browser/task-browser.ts';
import {bindBrowserAuth} from './domains/browser/auth.ts';
import {registerTaskBrowserTool} from './domains/browser/tools.ts';
import {bindTrafficRuntime,registerTrafficTools} from './domains/traffic/tools.ts';
import { SyncService } from "./domains/sync/service.ts";
import {seedScopeSentry} from './domains/sync/scopesentry.ts';
import { setCallRecorder } from "./pi/session-host.ts";
import { logSink } from "./domains/observability/logsink.ts";
import { SideRuntime } from "./domains/sidequestions/service.ts";
import { TaskArchives, startArchiveWorker } from "./domains/tasks/archives.ts";
import { setSideCaptureSink } from "./pi/session-host.ts";
import { routeRequest, type AppContext } from "./api/server.ts";
import {projectActivity,startActivityProjection} from './domains/activity/projector.ts';
import {startStorageLifecycle} from './storage/lifecycle.ts';
import {IntelClient} from './domains/intel/client.ts';
import {seedIntelTools,registerIntelTools} from './domains/intel/tools.ts';
import {HuntingService,huntingOptions} from './domains/hunting/service.ts';
import {seedHuntTools,registerHuntTools} from './domains/hunting/tools.ts';
import {PocService} from './domains/pocs/service.ts';
import {seedPocTools,registerPocTools} from './domains/pocs/tools.ts';
import {FingerprintService} from './domains/fingerprints/service.ts';
import {seedFingerprintTools,registerFingerprintTools} from './domains/fingerprints/tools.ts';

logSink.install(); // F20：console Full quantity ring/SSE/DB（Reserve terminal）
// Domestic to some overseas sites IPv6 Normal timeout: priority IPv4，Avoid waiting for one more round each time
setDefaultResultOrder('ipv4first');
const config = loadConfig();
// Give the parsed absolute path of the tool script to the child process：worker When executing in task working directory，
// proto-re No more guessing configuration or dependencies cwd。
process.env.WORMHOLE_PROTO_SCRIPT = config.pi?.agentDir
  ? path.join(path.resolve(config.pi.agentDir), "skills", "wormhole-proto-reverse", "scripts", "proto_re.py")
  : "";

// Make local CLI dependencies available to Pi Bash tools in task workspaces.
const projectBin = path.resolve(import.meta.dirname, '../node_modules/.bin');
process.env.PATH = [path.join(REVERSE_ROOT,'bin'),projectBin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
mkdirSync(config.dataDir, { recursive: true });
const pool = createPool(config.database.dsn);
const applied = await runMigrations(pool);
await seedScopeSentry(pool);
if (config.pi.agentDir) await seedBuiltinSkills(path.join(config.pi.agentDir, "skills"));
// Bundled capability Skills must be reachable by the role that uses them; without
// an explicit binding they exist on disk but never reach a session.
// Only write once during the first deployment: bindings revoked by the administrator later will not be quietly installed back after restarting。
// Core Skill Roles are only granted on first initialization; reboots do not restore user revoked bindings。

const originalSkills = ["wormhole-web-reverse"];
const addedSkills = ["wormhole-vuln-intel"];
for (const skill of [...originalSkills, ...addedSkills]) {
  const marker = `skills.bound.${skill}`;
  if ((await pool.query("SELECT 1 FROM app_settings WHERE key=$1", [marker])).rowCount) continue;

    await pool.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES('worker','skill',$1) ON CONFLICT DO NOTHING", [skill]);
  await pool.query("INSERT INTO app_settings(key,value) VALUES($1, now()::text) ON CONFLICT (key) DO NOTHING", [marker]);
}
await seedReverseProxyTools(pool);
await seedCodeIntelTools(pool);
await logSink.attach(pool); // Restore only after the logs table exists.
if (applied.length > 0) console.log(`[migrate] applied: ${applied.join(", ")}`);

const dlqPath = path.join(config.dataDir, "events-dlq.jsonl");
// The historical dead letter will be rewritten upon startup; every time during the running period 60s Try again（DB Failure→Recovery→Automatic storage）
try {
  const n = await backfillDeadLetters(pool, dlqPath);
  if (n > 0) console.log(`[ledger] Start writing dead letters ${n} Article`);
} catch (err) {
  console.error("[ledger] Failed to start catch-up (will retry in loop):", err);
}
const stopBackfill = startBackfillLoop(pool, dlqPath, 60_000);
await projectActivity(pool);
const stopActivity=startActivityProjection(pool);
const base = {
  pool,
  config,
  startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(config.dataDir)),
  settings: new SettingsService(pool, dlqPath, config.efficiency),
  llm: new LlmService(pool, dlqPath, config.pi.modelsPath),
  agents: new AgentsService(pool, dlqPath),
  tools: new ToolsService(pool, dlqPath),
  mcp: new McpService(pool, dlqPath),
  skills: new SkillsService(pool, dlqPath, path.join(config.pi.agentDir, "skills")),
  workspace: new WorkspaceService(pool, dlqPath, path.join(config.dataDir, "workspace")),
};
const settingsConsumers = new SettingsConsumers(pool, base.settings, dlqPath);
await settingsConsumers.load();
const traffic=new TrafficRuntime(config.dataDir,settingsConsumers);
const pocs=new PocService(pool);await seedPocTools(pocs);registerPocTools(pocs);
const intel=new IntelClient(pool,{githubToken:process.env.GITHUB_TOKEN,timeoutMs:12_000});
await seedIntelTools(intel,pool);registerIntelTools(intel);
const hunting=new HuntingService(pool,huntingOptions(config.hunting));await seedHuntTools(hunting);registerHuntTools(hunting);
const fingerprints=new FingerprintService(pool);
await seedFingerprintTools(fingerprints);registerFingerprintTools(fingerprints);
if(await fingerprints.enabled())await fingerprints.snapshot().catch(e=>console.error('[fingerprints] initial compilation:',String(e)));
await traffic.start();
const networkChannels=new NetworkChannels(pool,traffic,config.dataDir,Number(process.env.WORMHOLE_PUBLIC_PORT??config.listen.port));await networkChannels.start();
bindNetworkProvider((taskId,humanBrowser)=>networkChannels.scope(taskId,humanBrowser));
bindTargetRoute(()=>traffic.route());
bindTrafficRuntime(()=>traffic);registerTrafficTools();
const taskEngineDeps = {
  fingerprints,pocs,hunting,intel,
  agents: base.agents,
  assets: new AssetsService(pool, dlqPath),
  findings: new FindingsService(pool, dlqPath,new EvidenceStore(pool,traffic.store,path.join(config.dataDir,'evidence'))),
  intercept: new InterceptService(pool, dlqPath),
  settingsConsumers,
  mcp: base.mcp,
  skills: base.skills,
};
await seedEvidenceTools(taskEngineDeps.findings.evidenceStore!);
const trafficFlow=new TrafficFlow(pool,traffic.store,id=>taskEngine.notify(id));
traffic.store.onCapture=(id,x)=>{trafficFlow.ingest(id,x);};
await seedCheckTools(pool);registerCheckTools(trafficFlow);
const taskEngine = new TaskEngine(pool, config, {...taskEngineDeps,trafficFlow});
await taskEngine.reverseRuntime.initialize();
const taskBrowsers = new TaskBrowsers(pool, traffic, taskEngineDeps.assets, async(id,message)=>{if(message){await taskEngine.graph.ensure(id);await taskEngine.graph.addHints(id,{text:message});}else taskEngine.notify(id);});
taskEngine.browsers = taskBrowsers;
await registerTaskBrowserTool(pool, taskBrowsers);
bindBrowserAuth((ctx,id,url)=>taskBrowsers.authHeaders(ctx,id,url));
await taskEngine.proxies.recover();
fingerprints.bindNotify((id,change)=>taskEngine.notifyFingerprints(id,change));fingerprints.start();
const tasks = new TaskService(pool, dlqPath, (id) => void taskEngine.bootstrap(id), async (id, action) => {
  const chatOwner=(await pool.query('SELECT c.id FROM conversations c JOIN tasks t ON t.id=c.task_id WHERE t.id=$1 AND t.queue_mode=\'pentest_chat\'',[id])).rows[0];
  if(chatOwner){
    if(action==='resume'){const sent=await appCtx.conversations.send(Number(chatOwner.id),"Continue the previously paused task, using existing evidence and context.");if(sent.status!==202)throw new Error(sent.error??"Failed to restore session");}
    else {
      await Promise.all([
        applyTaskExecutionControl(taskEngine,id,action),
        appCtx.conversations.stop(Number(chatOwner.id)),
      ]);
      await networkChannels.stopTask(id);
    }
    return;
  }
  // Execution and human conversation have separate cancellation lifetimes.
  await applyTaskExecutionControl(taskEngine,id,action);
  if(action!=='resume')await networkChannels.stopTask(id);
});
const assets = taskEngineDeps.assets;
// F02 Platform Toolset（auto=Arrangement/Management，pentest=Independent Penetration）——B06 Execution inside door
const platformDeps = {
  trafficFlow,
  reverseProxies:taskEngine.proxies,
  fingerprints,pocs,
  modeling:taskEngine.modeling,
  dlqPath,
  graph:taskEngine.graph,
  taskRuntimeState:(id:number)=>taskEngine.platformState(id),
  taskOperation:(id:number)=>taskEngine.beginTaskOperation(id),
  pool,
  tasks,
  findings: taskEngineDeps.findings,
  assets,
  skills: base.skills,
  mcp: base.mcp,
  intercept: taskEngineDeps.intercept,
  // G06：LLM Ruling full disclosure (real model，profile Binding Sutra F11 Compile）
  runJudge: (toolKey: string, params: Record<string, unknown>,context:import('./domains/tools/gate.ts').ToolContext) => runJudge({ pool, config, tool: toolKey, params,context }),
};
registerPlatformTools(platformDeps);
const modelingQueueTimer=setInterval(()=>void taskEngine.pumpQueue().catch(e=>console.error("[modeling] queue",e)),2000);
modelingQueueTimer.unref();
const conversations=new ConversationsService(pool,config,base.agents,dlqPath,(agentKey,ctx)=>chatToolsFor(agentKey,ctx,platformDeps),(id,signal)=>taskEngine.acquireConversationTask(id,signal));
const findingRetests=new FindingRetests(pool,config,base.agents,conversations);
await findingRetests.seed();
const findingReports=new FindingReports(pool,config,base.agents,conversations,taskEngineDeps.findings.evidenceStore!);
await findingReports.seed();
const appCtx: AppContext = {
  networkChannels,
  fingerprints,pocs,
  ...base,
  tasks,
  taskEngine,
  conversations,
  findingRetests,findingReports,
  taskBrowsers,
  traffic,
  intercept: taskEngineDeps.intercept,
  obs: new ObservabilityService(pool),
  assets,
  findings: taskEngineDeps.findings,
  findingsWorkflow: new FindingsWorkflow(pool, dlqPath,taskEngine),
  sync: new SyncService(pool, assets, dlqPath),
  taskChat: (() => {
    const tc = new TaskChatService(pool, config, base.agents);
    // G13：Main Agent——Engine delete barrier + mainagent Tools (task ownership ctx）
    tc.wire(taskEngine, (taskId, signal, businessId) =>
      chatToolsFor("mainagent", { businessKind: "task", businessId, agentKey: "mainagent", taskId, signal, canExecute: async () => !signal.aborted && !taskEngine.isDeleting(taskId) }, platformDeps));
    return tc;
  })(),
  settingsConsumers,
};

bindExtension('pocs',async(_refresh,taskId)=>({key:'pocs',state:!await pocs.configured()?'disabled':await pocs.available(taskId)?'available':'empty',detail:"Knowledge base is imported by user; template is not automatically executed",settings:'/system/pocs'}));
bindExtension('fingerprints',async(_refresh,taskId)=>({key:'fingerprints',state:!await fingerprints.configured()?'disabled':!fingerprints.engineAvailable()?'not_installed':await fingerprints.available(taskId)?'available':'empty',detail:!fingerprints.engineAvailable()?"Install the fingerprint engine first, then import the rule data":"Rule data is imported by the user",settings:'/system/fingerprints'}));
bindExtension('whitebox',async(refresh)=>{const p=await taskEngine.reverseRuntime.payload(refresh);const c=p.components.find(c=>c.key==='whitebox');return {key:'whitebox',state:!p.settings.index_enabled?'disabled':c?.state==='available'?'available':!p.settings.service_url?'not_configured':'unreachable',detail:"Connecting to independently deployed code analysis services",settings:'/system/reverse'};});
bindExtension('rea',async()=>{const servers=await base.mcp.enabledServers();const server=servers.find(s=>s.name==='rea');const cached=server?!!(await pool.query('SELECT 1 FROM mcp_tools_cache WHERE server_id=$1 LIMIT 1',[server.id])).rowCount:false;return {key:'rea',state:server&&cached?'available':'not_configured',detail:"Access REA through MCP; each analysis backend is installed separately",settings:'/system/mcp'};});
bindExtension('protocol',async()=>({key:'protocol',state:existsSync(path.join(REVERSE_ROOT,'proto-py/bin/python'))&&existsSync(path.join(REVERSE_ROOT,'proto-re/proto_re.py'))?'available':'not_installed',detail:"Local protocol analysis tool chain",settings:'/system/reverse'}));
bindExtension('scopesentry',async(refresh)=>{const s=refresh?await appCtx.sync.status():await (async()=>{const row=(await pool.query("SELECT url,env,enabled FROM mcp_servers WHERE name='ScopeSentry' LIMIT 1")).rows[0];return {configured:!!row?.url&&Object.values(row?.env??{}).some(v=>String(v).trim()),enabled:row?.enabled===true,reachable:row?.enabled===true};})();return {key:'scopesentry',state:!s.configured?'not_configured':!s.enabled?'disabled':s.reachable?'available':'unreachable',detail:"Connecting user-deployed ScopeSentry service",settings:'/function/sync'};});

await conversations.recoverPentestTurns();
await findingRetests.recover();
await findingReports.recover();
await (await import('./domains/llm/global-state.ts')).refreshGlobalState(pool);
appCtx.taskChat.attachConversations(conversations);
// G03：Restart recovery - Crash residual lease return、running Task continuation、queued Pump in
void taskEngine.recover().catch((e) => console.error("[engine] recover failed:", String(e).slice(0, 200)));

// persistent notification dispatcher; independent from Pi loops.
const notifier=notificationService(pool).dispatcher;notifier.start();
const evidenceTimer=setInterval(()=>void taskEngineDeps.findings.evidenceStore!.collect().catch(e=>console.error('[evidence] cleanup failed',e)),3600000);evidenceTimer.unref();
// F12 Trigger Scheduling (Persistent Water Level scheduler_state，Restart does not repeat/No missing triggers）
const scheduler = new TriggerScheduler(pool, dlqPath, async (agentKey, message, run, signal) => {
  const releases:(()=>void)[]=[];
  try{
    for(const id of [...new Set(run?.taskIds??(run?.taskId?[run.taskId]:[]))]){
      for(;;){signal?.throwIfAborted();try{releases.push(workspaceGate.use(path.join(config.dataDir,'workspace','tasks',String(id))));break;}catch(error){if((error as {status?:number}).status!==409)throw error;await new Promise(r=>setTimeout(r,50));}}
    }
    await runTriggeredConversation(appCtx.conversations,base.agents,agentKey,message,run,signal);
  }finally{for(const release of releases.reverse())release();}
}, 5_000,true);
base.workspace.maintenance.bind({
  taskBusy:(id)=>findingReports.hasTask(id)||taskEngine.workspaceBusy(id)||taskBrowsers.busy(id)||appCtx.taskChat.isBusy(id)||scheduler.hasTask(id),
  acquireTask:(id)=>findingReports.hasTask(id)||taskBrowsers.busy(id)||appCtx.taskChat.isBusy(id)||scheduler.hasTask(id)?null:taskEngine.beginWorkspaceCleanup(id),
  sessionBusy:(id)=>conversations.isRunning(id),
});
await base.workspace.maintenance.recover();
base.workspace.resources.bind(traffic.store);
await base.workspace.resources.recover();
scheduler.start();findingReports.start();
await base.tools.registerGateTools();
// F07: usage always persists; session-host reads the recording toggle per call.
setCallRecorder(async(e:import("./pi/session-host.ts").LlmCallEntry,recordingEnabled:boolean) => {
  await appCtx.obs.recordCall(e,recordingEnabled,e.businessKind??"chat");
});
// F02 Bypass question runtime: boot recovery（running→interrupted）+ 250ms Snapshot batch storage + Capture sink
const sideRuntime = new SideRuntime(pool, async (snapshot: import("./domains/sidequestions/store.ts").SideSnapshot) => (await import("./domains/sidequestions/channel.ts")).createSideChannel(pool, config, snapshot));
await sideRuntime.boot();
setSideCaptureSink((snap) => sideRuntime.publish(snap));
appCtx.sideQuestions = sideRuntime;
// F03 Cold archive worker：2 Second polling + Starting recovery (in progress → Failure status）
const taskArchives = new TaskArchives(pool, config.dataDir, {
  isTaskRunning: (id) => taskEngine.isRunning(id),
  abortTask: (id) => taskEngine.abort(id),
  drainSide: async (id) => { await taskEngine.beginDelete(id);await appCtx.taskChat.stopTask(id);await findingReports.cancelTask(id); },
  endDrain: (id) => taskEngine.endDelete(id),
});
await taskArchives.recover();
appCtx.taskArchives = taskArchives;
const stopArchives = startArchiveWorker(taskArchives);
const stopStorage=startStorageLifecycle(config);
void stopArchives;
// Batch 1b：Task Archive/Delete drain When running with intent to stop canceling access bypass
if (typeof (taskEngine as { attachSideRuntime?: unknown }).attachSideRuntime === "function") {
  (taskEngine as { attachSideRuntime(v: unknown): void }).attachSideRuntime(sideRuntime);
}
console.log(`[startup] pihost listening ${config.listen.host}:${config.listen.port}`);
const server = createServer((req, res) => {
  void routeRequest(req, res, appCtx);
});
server.on('connect',(req,socket,head)=>void networkChannels.handleConnect(req,socket as import('node:net').Socket,head));
server.listen(config.listen.port, config.listen.host, () => {
  console.log(
    `[pihost] listening on ${config.listen.host}:${config.listen.port} (db=${maskDsn(config.database.dsn)})`,
  );
});

function maskDsn(dsn: string): string {
  return dsn.replace(/:[^:@/]*@/, ":***@");
}

let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  clearInterval(evidenceTimer);
  clearInterval(modelingQueueTimer);
  console.log(`[pihost] ${signal} received, shutting down`);
  stopBackfill();
  stopActivity();
  const schedulerDrain=scheduler.stop();
  server.close();
  server.closeAllConnections();
  void Promise.all([fingerprints.close(),stopStorage(),stopArchives(),notifier.stop(),findingRetests.shutdown(),findingReports.shutdown(),schedulerDrain,taskEngine.shutdown(), appCtx.conversations.shutdown(), appCtx.taskChat.shutdown()])
    .then(() => taskBrowsers.shutdown()).then(() => networkChannels.close()).then(() => traffic.close()).then(async () => {bindTargetRoute(null);bindTrafficRuntime(null);await trafficFlow.drain();await logSink.stop();return pool.end();}).then(() => process.exit(0))
    .catch((e) => { console.error("[shutdown] drain failed", e); process.exit(1); });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
