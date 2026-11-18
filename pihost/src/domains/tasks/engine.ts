import {extensionAvailable} from '../extensions/availability.ts';
import {BROWSER_GUIDANCE} from '../browser/tools.ts';
import path from 'node:path';
import {ReverseRuntime} from '../reverse/runtime.ts';
import {TrafficFlow,TRAFFIC_GUIDANCE} from '../traffic/flow.ts';
import {CHECK_TOOLS,registerCheckTools} from '../traffic/check-tools.ts';
import {taskProgress} from './progress.ts';
import {runPlannerRound,compactPlannerContext,plannerRecoveryContext,plannerRecoveryPrompt,plannerRevisions,plannerMessages,plannerModelRevisionSQL,type PlannerOutcome,type PlannerPlan} from './planner-recovery.ts';
import {withPlannerRecovery} from '../llm/profile-wire.ts';
import {registerFindingReadTools} from '../findings/tools.ts';
import {checkpointTaskReport,withTaskReport,reportLeadSeconds} from './report.ts';
import {TaskSlots} from './slots.ts';
import {continuousGuidance,finishDiscoveryIfReady} from './continuous.ts';
import {reopenExploration,completeAchievedTask} from './completion.ts';
import {taskWorkDir,artifactSpec} from '../workspace/layout.ts';
import {augmentSession,bindAugmentation} from '../mcp/session.ts';
import type {McpService} from '../mcp/service.ts';
import type {SkillsService} from '../skills/service.ts';
/** Task host: Pi owns a single session; this host owns scheduling and cancellation.
 * Behavior: task supervision, planning, execution, pause and recovery.
 * Planner's temporary JSON protocol is tracked separately under G01/G02/G07.
 */
import type { Pool } from "pg";
import type { PihostConfig } from "../../config.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostedSession, getPiRuntime, type HostedSession } from "../../pi/session-host.ts";
import { claimNextIntent, retryIntent,releaseModelingIntent,recoverModelingIntents } from "./host.ts";
import {runTool,type ToolContext,type GateOptions} from "../tools/gate.ts";
import { registerBusinessTools } from "../tools/business.ts";
import { runJudge } from "../tools/judge.ts";
import {promptDefaults} from '../agents/service.ts';
import {goTrim} from '../assets/asset-match.ts';
import type { AgentsService } from "../agents/service.ts";
import type { AssetsService } from "../assets/service.ts";
import type { FindingsService } from "../findings/service.ts";
import type { InterceptService } from "../intercept/service.ts";
import { plannerInterval } from "./scheduler.ts";
import {ExplorationService} from '../exploration/service.ts';
import {registerGraphTools,GRAPH_TOOLS} from '../exploration/tools.ts';
import {assembleTools} from '../tools/assembly.ts';
import {registerAssetTools,ASSET_TOOLS} from '../assets/tools.ts';
import {POC_TOOLS,registerPocTools} from '../pocs/tools.ts';
import {POC_GUIDANCE} from '../pocs/service.ts';
import {pocNeedsReview,pocMayComplete,pocReviewed,pocDelivery} from '../pocs/lifecycle.ts';
import {FINGERPRINT_TOOLS} from '../fingerprints/tools.ts';
import {FINGERPRINT_GUIDANCE,type FingerprintChange} from '../fingerprints/service.ts';
import {bootstrapFingerprints} from '../fingerprints/orchestration.ts';
import {fingerprintMayComplete,fingerprintNeedsReview,recordFingerprintDelivery,acknowledgeFingerprintReview,relatedFingerprintURL} from '../fingerprints/lifecycle.ts';
import {registerWorkControls,WORK_CONTROLS} from './work-tools.ts';
import {registerTraceTools,TRACE_TOOLS} from '../activity/tools.ts';
import {TaskModelResolver} from '../llm/profile-runtime.ts';
import {EfficiencySupervisor,efficiencyDecision,type ProgressSample} from './efficiency.ts';
import {goalEfficiencyGuidance,plannerEfficiencyGuidance,plannerReverseGuidance} from './execution-guidance.ts';
import {WorkerHandoffs,HANDOFF_TOOLS} from './handoff.ts';
import {ReverseProxies} from '../reverse/proxy.ts';
import {registerReverseTools,REVERSE_PROXY_TOOLS,reverseWorkerGuidance} from '../reverse/tools.ts';
import {CodeIntelService} from '../codeintel/service.ts';
import {registerCodeIntelTools,CODE_INTEL_TOOLS} from '../codeintel/tools.ts';
import {HUNT_TOOLS} from '../hunting/tools.ts';
import {INTEL_TOOLS} from '../intel/tools.ts';
import {ModelingService} from '../modeling/service.ts';
import {MODELER_TOOLS,MODELING_REQUEST_TOOLS,MODELING_GUIDANCE,registerModelingTools} from '../modeling/tools.ts';
import {probeModelingEntrance,MODELING_EXECUTION_GUIDANCE,type ModelingEntrance} from '../modeling/execution.ts';

export interface EngineDeps {
  trafficFlow?:TrafficFlow;
  pocs?:import('../pocs/service.ts').PocService;
  hunting?:import('../hunting/service.ts').HuntingService;
  intel?:import('../intel/client.ts').IntelClient;
  fingerprints?:import('../fingerprints/service.ts').FingerprintService;
  /** Injectable target transport probe; production uses the ordinary tool gate. */
  modelingProbe?:(target:string,signal:AbortSignal)=>Promise<ModelingEntrance>;
  agents: AgentsService;
  mcp?: McpService | null;
  skills?: SkillsService;
  assets: AssetsService;
  findings: FindingsService;
  intercept: InterceptService;
  settingsConsumers: { get(): { workers: number; taskConcurrencyEnabled: boolean; taskConcurrencyLimit: number; trafficCapture: boolean }; getRebuildCount(): number } | null;
}
interface RunContext {
  taskId: number;
  abort: AbortController;
  execution: AbortController;
  sessions: Set<HostedSession>;
  generation: number;
  paused: boolean;
  pending: boolean;
  hintTriggers: string[][];
  done: Promise<void>;
  releaseSlot?:()=>void;
  lastDiscoveryReview?:number;
}
interface TaskSnapshot {
  network_mode?:'standard'|'jump';
  execution_mode?:string;
  worker_limit?:number;
  queue_mode?:string;
  description?:string;
  id:number;
  kind?:string;
  goal: string;
  agent_key: string;
  deadline_at: Date | null;
  plan_heartbeat_seconds: number;
  active_llm_profile_id?: number | null;
  llm_profile_id?: number | null;
}
export class TaskEngine {
  private readonly runs = new Map<number, RunContext>();
  private readonly modelingLeases=new Map<number,number>();
  private readonly backgroundInitializers=new Map<number,Promise<void>>();
  private readonly deleting = new Set<number>();
  private readonly workspaceCleaning=new Set<number>();
  private readonly operations=new Map<number,Set<Promise<void>>>();
  private queuePump: Promise<void> | null = null;
  private closing = false;
  /** The code index cycle is self-contained: only explore pictures and write facts, and never participate in waiting for the completion of the task.。 */
  private readonly intelLoops = new Set<Promise<void>>();
  private readonly intelDone = new Map<number, Promise<void>>();
  /** One cancellation source per task: pause/Stop/Deletion only affects itself and will not affect other tasks.。 */
  private readonly intelTasks = new Map<number, AbortController>();
  private readonly intelRevisions=new Map<number,number>();
  private readonly settling=new Map<number,Promise<void>>();
  private readonly finalRuns=new Map<number,AbortController>();
  private readonly slotAbort=new AbortController();
  private readonly settlementControllers=new Map<number,AbortController>();
  readonly slots:TaskSlots;

  private admissionTail:Promise<void>=Promise.resolve();
  private readonly work=new Map<number,{taskId:number;abort:AbortController;session?:HostedSession;steering:string[];skipTools:number;fingerprintRevision?:number;pocRevision?:number;modelingRevision?:string}>();
  readonly graph: ExplorationService;
  readonly modeling: ModelingService;
  readonly efficiency:EfficiencySupervisor;
  readonly handoffs:WorkerHandoffs;
  readonly proxies:ReverseProxies;
  readonly codeIntel:CodeIntelService;
  readonly reverseRuntime:ReverseRuntime;
  browsers?: import("../browser/task-browser.ts").TaskBrowsers;

  constructor(private readonly pool: Pool, private readonly config: PihostConfig, private readonly deps: EngineDeps) {
    this.slots=new TaskSlots(()=>this.taskLimit(),()=>{setImmediate(()=>{void this.pumpQueue().catch(e=>console.error('[slots] queue',e));});});
    if(deps.trafficFlow)registerCheckTools(deps.trafficFlow);
    this.efficiency=new EfficiencySupervisor(pool,config.efficiency);
    this.handoffs=new WorkerHandoffs(pool,config.dataDir,deps.fingerprints,deps.pocs);this.handoffs.register();
    if(deps.pocs){registerPocTools(deps.pocs);deps.pocs.bindNotify(id=>this.notifyPocs(id));}
    this.modeling=new ModelingService(pool);
    this.modeling.bind(id=>{void this.launch(id).catch(e=>console.error('[modeling] launch',e));},id=>{void this.wakeModelConsumer(id);});
    registerModelingTools(this.modeling);
    this.proxies=new ReverseProxies(pool,config.dataDir);
    registerBusinessTools({ trafficFlow:deps.trafficFlow, reverseProxies:this.proxies, assets: deps.assets, findings: deps.findings,modeling:this.modeling,fingerprints:deps.fingerprints });
    registerAssetTools(pool);
    registerWorkControls(pool,this);
    registerTraceTools(pool);
    registerFindingReadTools(pool);
    deps.findings.setOnRecord((id)=>this.notify(id));
    this.graph=new ExplorationService(pool,id=>this.notify(id),(id,texts)=>this.notifyHints(id,texts));
    registerReverseTools(this.proxies);
    this.codeIntel=new CodeIntelService(pool,config.dataDir,config.codeIntel);
    this.reverseRuntime=new ReverseRuntime(pool,this.codeIntel,config.codeIntel,path.join(config.dataDir,'reverse-events.jsonl'));
    // Canceling recycling does not depend on whether the task is still alive: End/External auditing must still be stopped after restarting
    this.codeIntel.startCancelSweeper();
    registerCodeIntelTools(this.codeIntel);
    registerGraphTools(pool,this.graph,id=>this.notify(id),async(id)=>{
      if(this.isDeleting(id))throw new Error("Task is being deleted");
      await pool.query("UPDATE tasks SET status='running',paused=FALSE,completed_at=NULL WHERE id=$1 AND deleted_at IS NULL",[id]);
      await pool.query("UPDATE explorations SET status='open',updated_at=now() WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)",[id]);
      this.resume(id);
    },id=>{setImmediate(()=>this.abort(id));});
  }
  isRunning(id: number): boolean { return this.runs.has(id); }
  private initializeBackgroundModeling(id:number){
    if(this.backgroundInitializers.has(id))return;
    const release=this.beginTaskOperation(id);if(!release)return;
    const work=this.modeling.initializeTask(id).catch(async error=>{
      await this.emit(id,'background_modeling_error',{error:String(error).slice(0,500)});
      await this.pool.query(`INSERT INTO activity(exploration_id,worker,kind,summary) SELECT exploration_id,'system','text','Business modeling is temporarily unavailable, test continues' FROM tasks WHERE id=$1 AND deleted_at IS NULL`,[id]);
    }).finally(()=>{release();this.backgroundInitializers.delete(id);setImmediate(()=>void this.pumpQueue().catch(console.error));});
    this.backgroundInitializers.set(id,work);
  }
  private async wakeModelConsumer(id:number):Promise<void>{
    try{
      const task=(await this.pool.query("SELECT status,paused,queued FROM tasks WHERE id=$1 AND deleted_at IS NULL",[id])).rows[0];
      if(!task||task.paused||task.queued||!['created','running'].includes(task.status))return;
      if(this.runs.has(id)){
        this.notify(id);
        const catalog=await this.modeling.catalog(id),revision=JSON.stringify(catalog);
        for(const work of this.work.values())if(work.taskId===id&&!work.abort.signal.aborted&&work.modelingRevision!==revision){
          const update="[Business model background update, additional clues; test continues]\n"+revision;
          if(work.session)await work.session.session.steer(update);else work.steering.push(update);work.modelingRevision=revision;
        }
      }else await this.launch(id);
    }catch(e){console.error('[modeling] consumer wake',e);}
  }
  isDeleting(id: number): boolean { return this.deleting.has(id)||this.workspaceCleaning.has(id); }
  workspaceBusy(id:number):boolean {return this.codeIntel.busy(id)||this.closing||this.isDeleting(id)||this.runs.has(id)||this.settling.has(id)||this.finalRuns.has(id)||this.operations.has(id)||this.slots.ids.includes(id)||this.modelingLeases.has(id);}
  beginWorkspaceCleanup(id:number):(()=>void)|null {
    if(this.workspaceBusy(id))return null;this.workspaceCleaning.add(id);
    return ()=>this.workspaceCleaning.delete(id);
  }

  /** Batch 1b：Bypass runtime injection (remove drain、Intent to stop cancellation）。 */
  attachSideRuntime(rt: { drainTask(taskId: number): Promise<void>; cancelWorker(taskId: number, explorationId: number, intentId: number): void }): void {
    this.sideRuntime = rt;
  }
  private sideRuntime: { drainTask(taskId: number): Promise<void>; cancelWorker(taskId: number, explorationId: number, intentId: number): void } | null = null;

  /** Intent to stop/Cancel its bypass operation when deleting (cf. cancelWorkerSide）。 */
  cancelWorkerSide(taskId: number, explorationId: number, intentId: number): void {
    this.sideRuntime?.cancelWorker(taskId, explorationId, intentId);
  }
  /** Admission is synchronous with deletion; release only after file writes end. */
  beginTaskOperation(id:number):(()=>void)|null {
    if(this.closing||this.isDeleting(id))return null;
    let resolve!:()=>void;const done=new Promise<void>(r=>resolve=r),set=this.operations.get(id)??new Set<Promise<void>>();set.add(done);this.operations.set(id,set);
    let released=false;return ()=>{if(released)return;released=true;set.delete(done);if(!set.size)this.operations.delete(id);resolve();};
  }
  private invalidate(run: RunContext): void {
    run.generation++;
    run.execution.abort();
    for (const h of run.sessions) void h.session.abort().catch(() => {});
  }
  /** User explicitly stopped/Delete: The background analysis of this task is stopped together with the submitted external audit, and wait for it to stop.。 */
  /** Stop the background of this task and wait for it to return the files. Return false means that the time has expired and the caller has not exited. The caller cannot treat it as exiting.。 */
  private async stopBackground(id: number): Promise<boolean> {
    this.intelRevisions.set(id,(this.intelRevisions.get(id)??0)+1);
    this.intelTasks.get(id)?.abort();
    const loop = this.intelDone.get(id);
    let settled = !loop;
    if (loop) {
      settled = await Promise.race([
        loop.then(() => true, () => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15_000)),
      ]);
    }
    // If the file operation is still pending, wait a while (scan/Unpack/Packing）
    for (let i = 0; i < 40 && this.codeIntel.busy(id); i++) await new Promise<void>(resolve => setTimeout(resolve, 250));
    await this.codeIntel.stopTask(id).catch(() => {});
    return settled && !this.codeIntel.busy(id);
  }

  /** User explicitly stopped (in run control stop）；Complete the walk normally abort，Won’t get here。 */
  stop(id: number): void {
    void this.stopBackground(id);
    this.abort(id);
  }

  abort(id: number): void {
    void this.browsers?.stopTask(id);
    void this.proxies.stopTask(id).catch(error=>console.error('[reverse-proxy] stop',error));
    this.settlementControllers.get(id)?.abort();
    this.finalRuns.get(id)?.abort();
    const run = this.runs.get(id);
    if (!run) return;
    run.abort.abort();
    this.invalidate(run);
  }
  pause(id: number): void {
    void this.codeIntel.stopTask(id).catch(()=>{});
    // Import the ongoing tasks of this task when paused/Packaging is interrupted, and the loop will start again after recovery.
    this.intelTasks.get(id)?.abort();
    this.browsers?.pauseTask(id);
    void this.proxies.stopTask(id).catch(error=>console.error('[reverse-proxy] pause',error));
    const run = this.runs.get(id);
    if (!run) return;
    run.paused = true;
    this.invalidate(run);
    this.releaseIdleSlot(run);
  }
  resume(id: number): void {
    // Loop the background during pause aborted It fell down and needs to be pulled up again.
    this.startCodeIntel(id);
    const run = this.runs.get(id);
    if (!run) { void this.launch(id); return; }
    if(!run.paused){this.notify(id);return;}
    void this.efficiency.resetIfSuspended(id).then(async()=>{
      if(this.runs.get(id)!==run||run.abort.signal.aborted)return;
      const current=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL AND status IN('created','running') AND NOT paused",[id])).rows[0];
      if(!current||await this.batchBlocked(current)){this.releaseIdleSlot(run);return;}
      if(this.runs.get(id)!==run||run.abort.signal.aborted||this.settling.has(id))return;
      if(!run.releaseSlot){const release=this.tryAcquireRunSlot(current);if(!release){void this.pool.query("UPDATE tasks SET queued=true,queued_at=COALESCE(queued_at,now()) WHERE id=$1",[id]);return;}run.releaseSlot=release;}
      run.execution = new AbortController();run.paused = false;this.notify(id);
    }).catch(error=>console.error('[efficiency] resume failed',error));
  }
  notify(id: number): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.pending = true;
  }
  async notifyFingerprints(taskId:number,change?:FingerprintChange):Promise<void>{
    await this.deps.pocs?.refresh(taskId);
    this.notify(taskId);if(!change||!this.deps.fingerprints)return;
    for(const [intentId,work] of this.work){if(work.taskId!==taskId||work.abort.signal.aborted||(work.fingerprintRevision??-1)>=change.revision)continue;
      const summary=await this.deps.fingerprints.summary(taskId,intentId);
      const relevant=change.intentId===intentId||summary.focus?.asset_ids?.includes(change.assetId??0)||summary.focus?.urls?.some(url=>relatedFingerprintURL(url,change.url))||summary.observations.some(o=>relatedFingerprintURL(o.url,change.url));
      if(!relevant)continue;
      const text="[Host fingerprint update, filter by current intent; this is an identification clue, not a vulnerability conclusion]\n"+JSON.stringify(summary);
      if(work.session)await work.session.session.steer(text);else work.steering.push(text);
      work.fingerprintRevision=summary.revision;await recordFingerprintDelivery(this.pool,taskId,'worker_update',summary.revision,summary.observations.flatMap(o=>o.observation_ids),intentId);
    }
  }
  async notifyPocs(taskId:number):Promise<void>{
    this.notify(taskId);if(!this.deps.pocs)return;
    for(const [intentId,work] of this.work){if(work.taskId!==taskId||work.abort.signal.aborted)continue;
      const summary=await this.deps.pocs.summary(taskId,intentId);
      if(!summary.enabled||(work.pocRevision??-1)>=summary.revision)continue;
      if(summary.candidates.length){const text="[Host PoC knowledge update: only current intent judgment, not vulnerability conclusion or execution authorization]\n"+JSON.stringify(summary);if(work.session)await work.session.session.steer(text);else work.steering.push(text);await pocDelivery(this.pool,taskId,'worker_update',summary.revision,summary.candidates.map(c=>Number(c.id)),intentId);}
      work.pocRevision=summary.revision;
    }
  }
  notifyHints(id:number,texts:string[]):void{const run=this.runs.get(id);if(!run||!texts.length)return;run.hintTriggers.push([...texts]);this.notify(id);}
  async platformState(id:number):Promise<{started:boolean;paused:boolean;ready:boolean}>{const run=this.runs.get(id),task=(await this.pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];return {started:!!run,paused:!!run?.paused,ready:!!task&&await this.ready(task)};}
  async killWork(taskId:number,intentId:number):Promise<void>{
    const work=this.work.get(intentId);if(!work||work.taskId!==taskId)throw new Error(`Intention ${intentId} There is currently no running work (may have ended or not been claimed)`);
    work.abort.abort();
    await this.pool.query("UPDATE exploration_nodes SET state='stopped',completed_at=now(),updated_at=now() WHERE id=$1 AND task_id=$2 AND state='running'",[intentId,taskId]);
    await work.session?.session.abort();this.notify(taskId);
  }
  async steerWork(taskId:number,intentId:number,message:string):Promise<void>{
    if(!message.trim())throw new Error("Correction message cannot be empty");const work=this.work.get(intentId);
    if(!work||work.taskId!==taskId||work.abort.signal.aborted)throw new Error(`Intention ${intentId} There is currently no running work (may have ended or not been claimed)`);
    work.skipTools++;try{const text=`[Planner Correction]
${message}`;if(work.session)await work.session.session.steer(text);else work.steering.push(text);}catch(error){work.skipTools--;throw error;}
  }
  /** Called after complete deletion is successful: clear the index file of this task, the archive path will not go here。 */
  async purgeTaskData(id: number): Promise<void> {
    await this.codeIntel.purgeTask(id).catch(error => console.error('[codeintel] purge:', String(error)));
    await this.deps.hunting?.purgeTask(id).catch(error => console.error('[hunting] purge:', String(error)));
  }

  async stopExecution(id: number): Promise<void> {
    this.abort(id);
    // The white box backend (index loop, submitted audit) must also be canceled along with the stop entry and wait for it to exit cleanly
    const background = this.stopBackground(id).catch(() => false);
    await Promise.all([
      this.drain(id),
      this.browsers?.stopTask(id),
      this.proxies.stopTask(id),
      background,
    ]);
  }
  async drain(id: number): Promise<void> { await this.runs.get(id)?.done; await this.settling.get(id); }
  async shutdown(): Promise<void> {
    this.closing = true;this.slotAbort.abort();this.codeIntel.stopCancelSweeper();
    const intelIds=[...this.intelTasks.keys()];
    for (const ctl of this.intelTasks.values()) ctl.abort();
    await Promise.allSettled(intelIds.map(id=>this.codeIntel.stopTask(id)));
    for(const ctl of this.settlementControllers.values())ctl.abort();
    const runs = [...this.runs.values()];
    for (const run of runs) this.abort(run.taskId);
    for(const ctl of this.finalRuns.values())ctl.abort();
    await Promise.all(runs.map((run) => run.done));
    await Promise.allSettled([...this.settling.values()]);
    await Promise.all([...this.operations.values()].flatMap(set=>[...set]));
    await this.proxies.stopAll().catch(() => {});
    await Promise.allSettled([...this.intelLoops]);
  }
  async beginDelete(id: number): Promise<void> {
    if(this.workspaceCleaning.has(id))throw new Error("The workspace is being cleaned, please try again later");
    this.deleting.add(id);
    // This step is only responsible for ”stopping” and does not destroy any files: the archive path will also go here
    if (!await this.stopBackground(id)) {
      this.deleting.delete(id);
      throw new Error("Files are still being released in the background, please try deleting or archiving again later.");
    }
    this.abort(id);
    await this.drain(id);
    await this.proxies.stopTask(id);
    await this.browsers?.stopTask(id);
    await Promise.all([...(this.operations.get(id)??[])]);
    // Control drainTaskSideQuestions：Waiting for bypass to complete writing+Snapshot flush；Unsaved checkpoints must not be lost silently
    if (this.sideRuntime) await this.sideRuntime.drainTask(id);
  }
  endDelete(id: number): void { this.deleting.delete(id); }

  private async serializeAdmission<T>(action:()=>Promise<T>):Promise<T>{
    const previous=this.admissionTail;let release!:()=>void;this.admissionTail=new Promise<void>(r=>release=r);
    await previous;try{return await action();}finally{release();}
  }
  private taskLimit():number{const s=this.deps.settingsConsumers?.get();return s?.taskConcurrencyEnabled?Math.max(1,Math.min(3,s.taskConcurrencyLimit)):3;}
  private async batchBlocked(task:{id:number;batch_id?:string;kind?:string}):Promise<boolean>{
    if(task.batch_id&&(await this.pool.query('SELECT paused FROM task_batches WHERE id=$1',[task.batch_id])).rows[0]?.paused)return true;
    if(task.kind!=='modeling')return false;
    return !!(await this.pool.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM task_business_models m JOIN tasks p ON p.id=m.task_id WHERE m.modeling_task_id=$1 AND p.batch_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM task_business_models m JOIN tasks p ON p.id=m.task_id LEFT JOIN task_batches b ON b.id=p.batch_id WHERE m.modeling_task_id=$1 AND p.status IN('created','running','paused') AND NOT p.paused AND p.deleted_at IS NULL AND NOT COALESCE(b.paused,false))`,[task.id])).rowCount;
  }
  private activeRuns():number{return this.slots.size;}
  /** Modeling is task-owned auxiliary work, without a global task-count cap.
   * Keep re-entrant leases for cleanup protection; only primary runs use slots. */
  private tryAcquireRunSlot(task:{id:number|string;kind?:string}):(()=>void)|null{
    const id=Number(task.id);
    if(task.kind!=='modeling')return this.slots.tryAcquire(id);
    this.modelingLeases.set(id,(this.modelingLeases.get(id)??0)+1);
    let released=false;
    return ()=>{if(released)return;released=true;const n=(this.modelingLeases.get(id)??1)-1;
      if(n)this.modelingLeases.set(id,n);else this.modelingLeases.delete(id);
      setImmediate(()=>void this.pumpQueue().catch(console.error));};
  }
  async acquireTaskSession(id:number,signal:AbortSignal):Promise<()=>void>{
    if(this.closing||this.isDeleting(id))throw new Error("Task is being closed or deleted");
    const combined=AbortSignal.any([signal,this.slotAbort.signal]);
    const task=(await this.pool.query('SELECT id,kind FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
    combined.throwIfAborted();if(this.closing||this.isDeleting(id))throw new Error("Task is being closed or deleted");
    if(task?.kind==='modeling')return this.tryAcquireRunSlot(task)!;
    return this.slots.acquire(id,combined);
  }
  private releaseIdleSlot(run:RunContext){if((run.paused||run.abort.signal.aborted)&&!run.sessions.size&&run.releaseSlot){run.releaseSlot();run.releaseSlot=undefined;}}
  async acquireConversationTask(id:number,signal:AbortSignal):Promise<()=>void>{
    await this.pool.query("UPDATE tasks SET queued=true,queued_at=now(),first_run_at=NULL WHERE id=$1 AND queue_mode='pentest_chat'",[id]);
    let release:(()=>void)|undefined;
    try{release=await this.slots.acquire(id,AbortSignal.any([signal,this.slotAbort.signal]));const changed=await this.pool.query("UPDATE tasks SET queued=false,queued_at=NULL,first_run_at=now() WHERE id=$1 AND status='running' AND NOT paused AND deleted_at IS NULL",[id]);if(!changed.rowCount)throw new Error("Task paused or ended");return release;}
    catch(e){release?.();await this.pool.query("UPDATE tasks SET queued=false,queued_at=NULL WHERE id=$1 AND queue_mode='pentest_chat'",[id]);throw e;}
  }
  private async ready(task:TaskSnapshot):Promise<boolean>{
    const runtime=await getPiRuntime(this.config);
    try{for(const role of task.kind==='modeling'?['modeler']:['goals',task.agent_key||'planner','worker'])await new TaskModelResolver(this.pool,this.config,runtime,Number(task.id),role).current();return true;}catch{return false;}
  }
  /** Original follow-up admission: persistent FIFO, terminal revival and CAS.
   * Caller holds beginTaskOperation until the response/compensation finishes. */
  async admitFollowUp(id:number):Promise<boolean>{return this.serializeAdmission(async()=>{
    if(this.closing||this.isDeleting(id))throw new Error('task is being deleted');
    const task=(await this.pool.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];if(!task)throw new Error('task is being deleted');
    if(task.queue_mode==='pentest_chat')throw new Error("Please continue this task in the original pentest session");
    const old=this.runs.get(id),engineWasPaused=old?.paused,settings=this.deps.settingsConsumers?.get(),enabled=true;
    const ready=!enabled||await this.ready(task);
    const active=old&&!old.abort.signal.aborted&&!old.paused&&task.status==='running'&&!task.paused&&!task.queued&&ready;
    const backlog=task.kind!=='modeling'&&enabled&&!!(await this.pool.query("SELECT 1 FROM tasks WHERE id<>$1 AND kind<>'modeling' AND queued=TRUE AND paused=FALSE AND deleted_at IS NULL AND archived=FALSE ORDER BY queued_at,id LIMIT 1",[id])).rowCount;
    const atCapacity=task.kind!=='modeling'&&this.activeRuns()-(old?.releaseSlot?1:0)>=this.taskLimit();
    const queued=!active&&enabled&&(!ready||backlog||atCapacity);
    if(old&&!active){if(!['running','created','paused'].includes(task.status))this.abort(id);else this.pause(id);if(old.abort.signal.aborted)await old.done;}
    const committed=await this.pool.query(`UPDATE tasks SET status='running',completed_at=NULL,paused=FALSE,queued=$3,
      queued_at=CASE WHEN NOT $3 THEN NULL WHEN queued THEN COALESCE(queued_at,now()) ELSE now() END,
      queue_mode=CASE WHEN NOT $3 THEN '' WHEN queued AND queue_mode='bootstrap' THEN 'bootstrap' ELSE 'resume' END,
      first_run_at=CASE WHEN $2='timeout' THEN NULL ELSE first_run_at END,
      deadline_at=CASE WHEN $2='timeout' THEN NULL ELSE deadline_at END,updated_at=now()
      WHERE id=$1 AND status=$2 AND deleted_at IS NULL RETURNING id`,[id,task.status,queued]);
    if(!committed.rowCount){if(old&&!engineWasPaused&&!task.paused&&!old.abort.signal.aborted)this.resume(id);throw new Error(`task ${id} lifecycle changed before admission (expected status "${task.status}")`);}
    await reopenExploration(this.pool,id);
    if(queued){if(!task.queued){const summary=!ready?"Queued: There is currently no runnable LLM configuration. It will start automatically after the configuration is restored.":backlog?"Queued: There are earlier tasks waiting to run and will be started automatically in FIFO order":`Queued: Concurrency limit reached ${this.taskLimit()}, automatically starts after waiting for a vacant position`;
      await this.pool.query("INSERT INTO activity(exploration_id,worker,kind,summary) VALUES($1,'system','text',$2)",[task.exploration_id,summary]).catch(e=>console.error('[admission] queue audit failed',e));}return true;}
    if(this.runs.has(id)){this.resume(id);this.notify(id);}else await this.startRun(id);
    return false;
  });}
  async bootstrap(id:number):Promise<void>{await this.pool.query("UPDATE tasks SET queue_mode='bootstrap' WHERE id=$1 AND first_run_at IS NULL AND deleted_at IS NULL",[id]);await this.launch(id);}
  async launch(id: number): Promise<void> {await this.serializeAdmission(()=>this.startRun(id));}
  private async startRun(id: number,fromQueue=false): Promise<void> {
    // Reserve synchronously before any await; concurrent launch callers share one slot.
    if (this.closing || this.runs.has(id) || this.settling.has(id) || this.isDeleting(id)) return;
    if((await this.pool.query("SELECT 1 FROM tasks WHERE id=$1 AND queue_mode='pentest_chat'",[id])).rowCount)return;
    const candidate=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND status IN ('created','running') AND paused=FALSE AND deleted_at IS NULL AND archived=FALSE",[id])).rows[0];
    if(!candidate)return;
    if(candidate.deadline_at&&new Date(candidate.deadline_at).getTime()<=Date.now()){
      void this.settleTask(id).catch(error=>console.error('[engine] deadline settlement',error));return;
    }
    if(!await this.ready(candidate)){await this.pool.query("UPDATE tasks SET queued=true,queued_at=COALESCE(queued_at,now()) WHERE id=$1 AND status IN ('created','running') AND NOT paused AND deleted_at IS NULL",[id]);return;}
    const batchPaused=await this.batchBlocked(candidate);
    const older=candidate.kind!=='modeling'&&!fromQueue&&(await this.pool.query("SELECT 1 FROM tasks WHERE id<>$1 AND kind<>'modeling' AND queued AND NOT paused AND status IN('created','running') AND queue_mode<>'pentest_chat' AND deleted_at IS NULL AND NOT archived AND (queued_at,id)<(COALESCE($2::timestamptz,now()),$1) LIMIT 1",[id,candidate.queued_at])).rowCount;
    if(batchPaused||older){await this.pool.query("UPDATE tasks SET queued=true,queued_at=COALESCE(queued_at,now()) WHERE id=$1 AND status IN ('created','running') AND NOT paused AND deleted_at IS NULL",[id]);if(!fromQueue)setImmediate(()=>void this.pumpQueue().catch(console.error));return;}
    if(candidate.deadline_at&&new Date(candidate.deadline_at).getTime()<=Date.now()){
      void this.settleTask(id).catch(error=>console.error('[engine] deadline settlement',error));return;
    }
    const settings = this.deps.settingsConsumers?.get();
    const releaseSlot=this.tryAcquireRunSlot(candidate);
    if (!releaseSlot) {
      await this.pool.query("UPDATE tasks SET queued=TRUE, queued_at=COALESCE(queued_at,now()) WHERE id=$1 AND status IN ('created','running','paused') AND deleted_at IS NULL", [id]);
      return;
    }
    const run: RunContext = { taskId: id, abort: new AbortController(), execution: new AbortController(), sessions: new Set(), generation: 0, paused: false, pending: false, hintTriggers:[], done: Promise.resolve(),releaseSlot };
    this.runs.set(id, run);
    this.startDeadlineCoordinator(id);
    run.done = this.supervise(run, Math.max(1, candidate.worker_limit??settings?.workers ?? 3)).finally(() => {
      run.releaseSlot?.();run.releaseSlot=undefined;
      if (this.runs.get(id) === run) this.runs.delete(id);
      void this.pumpQueue().catch((e) => console.error("[engine] queue:", e));
    });
  }
  async pumpQueue(): Promise<void> {
    if (this.closing) return;
    if (this.queuePump) return this.queuePump;
    const work = async () => {
      const orphaned=await this.pool.query(`UPDATE tasks child SET status='failed',queued=false,paused=false,queued_at=NULL,completed_at=now(),stopped_reason='Source test tasks have ended, background modeling has stopped; drafts have been submitted and retained' WHERE child.kind='modeling' AND child.status IN('created','running','paused') AND EXISTS(SELECT 1 FROM business_model_runs r WHERE r.task_id=child.id AND r.trigger_kind IN('initial','discovery')) AND EXISTS(SELECT 1 FROM task_business_models m WHERE m.modeling_task_id=child.id) AND NOT EXISTS(SELECT 1 FROM task_business_models m JOIN tasks p ON p.id=m.task_id WHERE m.modeling_task_id=child.id AND p.status IN('created','running','paused') AND p.deleted_at IS NULL) RETURNING child.id`);
      for(const child of orphaned.rows)this.abort(Number(child.id));
      for(const row of (await this.pool.query("SELECT id FROM tasks WHERE execution_mode='continuous' AND status IN('created','running','paused') AND deadline_at<=now() AND deleted_at IS NULL AND NOT archived")).rows)void this.settleTask(Number(row.id)).catch(e=>console.error('[batch] cutoff',e));
      const expired=await this.pool.query("SELECT id,kind FROM tasks WHERE status IN ('created','running') AND paused=FALSE AND deadline_at<=now() AND (kind='modeling' OR EXISTS(SELECT 1 FROM task_business_models m WHERE m.task_id=tasks.id AND m.version_id IS NULL))");
      for(const row of expired.rows){const id=Number(row.id);if(row.kind==='modeling'){await this.modeling.fail(id,'timeout',"Business modeling execution exceeds the upper limit of time; the draft has been submitted for retention and the main test continues");this.abort(id);await this.emit(id,'modeling_timeout',{draft_preserved:true});continue;}await withTaskReport(this.pool,id,"Task deadline reached",c=>c.query("UPDATE tasks SET status='timeout',stopped_reason=CASE WHEN kind='modeling' THEN 'Business modeling execution exceeds the time limit; the draft has been reserved, please check the network, coverage gaps or submit errors and try again' ELSE stopped_reason END,completed_at=now(),updated_at=now() WHERE id=$1 AND status IN('created','running') AND NOT paused AND deadline_at<=now()",[id]));this.abort(id);if(row.kind==='modeling')await this.emit(id,'modeling_timeout',{draft_preserved:true});}
      const settings = this.deps.settingsConsumers?.get();
      const limit = this.taskLimit();
      const rows = await this.pool.query("SELECT t.id,t.kind FROM tasks t LEFT JOIN task_batches b ON b.id=t.batch_id WHERE t.queued=TRUE AND t.paused=FALSE AND t.status IN ('created','running') AND t.queue_mode<>'pentest_chat' AND t.deleted_at IS NULL AND t.archived=FALSE AND NOT COALESCE(b.paused,false) ORDER BY t.queued_at NULLS FIRST,t.id");
      for (const row of rows.rows) {
        if(row.kind!=='modeling'&&this.activeRuns()>=limit)continue;
        const task=(await this.pool.query('SELECT * FROM tasks WHERE id=$1',[row.id])).rows[0];
        if(!task)continue;
        if(task.kind!=='modeling'&&this.activeRuns()>=limit)continue;
        if(!await this.ready(task)||await this.batchBlocked(task))continue;
        if(this.settling.has(Number(row.id)))continue;
        const run=this.runs.get(Number(row.id));if(run?.abort.signal.aborted)continue;
        if(run){const release=run.releaseSlot??this.tryAcquireRunSlot(task);if(!release)continue;run.releaseSlot=release;await this.pool.query("UPDATE tasks SET queued=FALSE,queued_at=NULL WHERE id=$1",[row.id]);this.resume(Number(row.id));}
        else await this.startRun(Number(row.id),true);
      }
    };
    this.queuePump = this.serializeAdmission(work).finally(() => { this.queuePump = null; });
    return this.queuePump;
  }
  async recover(): Promise<void> {
    // Called once on boot; a fresh process owns no surviving worker lease.
    if (this.runs.size) throw new Error("recover requires a quiescent engine");
    await recoverModelingIntents(this.pool);
    await this.pool.query(`UPDATE exploration_nodes n SET state='open', claimed_by=NULL, claimed_at=NULL
      FROM tasks t WHERE n.task_id=t.id AND n.kind='intent' AND n.state='running'
      AND t.status IN ('running','paused') AND t.deleted_at IS NULL AND t.archived=FALSE AND t.queue_mode<>'pentest_chat'`);
    const rows = await this.pool.query("SELECT id FROM tasks WHERE status='running' AND paused=FALSE AND queued=FALSE AND deleted_at IS NULL AND archived=FALSE AND queue_mode<>'pentest_chat' ORDER BY id");
    for (const row of rows.rows) await this.launch(Number(row.id));
    await this.pumpQueue();
    // Control restoreTaskRuntimes/startDeadlineCoordinator：Inactive (including suspended/Queued) unfinalized tasks
    // There is also a finishing touch after restarting - independent of planner/worker Per-task absolute clock for loop。
    await this.startDeadlineCoordinators();
    // For tasks that ended before restarting, the white box may still be running: the remaining time is restored within the window, and the expiration is clearly marked
    const GRACE_MS = 10 * 60_000;
    const pending = await this.pool.query(
      `SELECT DISTINCT n.task_id, COALESCE(t.completed_at, t.updated_at) AS finished_at
         FROM exploration_nodes n JOIN tasks t ON t.id=n.task_id
        WHERE n.kind='fact' AND n.payload->>'kind'='code_ready' AND n.payload->>'audit_state'='running'
          AND t.deleted_at IS NULL AND t.status IN ('done','failed','timeout')`).catch(() => null);
    for (const row of pending?.rows ?? []) {
      const taskId = Number(row.task_id);
      const finishedAt = Date.parse(String(row.finished_at ?? '')) || 0;
      const deadline = finishedAt ? finishedAt + GRACE_MS : 0;
      if (!deadline || Date.now() >= deadline) {
        await this.codeIntel.markUnfinished(taskId).catch(() => {});
        continue;
      }
      this.startCodeIntel(taskId, deadline);
    }
  }

  /** Per task deadline Coordinator (idempotent; absolute wall clock, pauses also count; run the end sequence when the point is reached）。 */
  private coordStarted = new Set<number>();
  private reportPrepared=new Map<number,number>();
  private async startDeadlineCoordinators(): Promise<void> {
    const rows = await this.pool.query(
      "SELECT id FROM tasks WHERE status IN ('running','paused') AND deleted_at IS NULL AND archived=FALSE AND queued=FALSE AND queue_mode<>'pentest_chat'",
    );
    for (const row of rows.rows as { id: number }[]) {
      this.startDeadlineCoordinator(Number(row.id));
    }
  }
  startDeadlineCoordinator(taskId: number): void {
    if (this.coordStarted.has(taskId) || this.isDeleting(taskId)) return;
    this.coordStarted.add(taskId);
    void (async () => {
      try {
        for (;;) {
          if (this.closing) return;
          const t = (await this.pool.query("SELECT status, deadline_at, timeout_seconds FROM tasks WHERE id=$1", [taskId]).catch(() => null))?.rows[0] as { status: string; deadline_at: Date | string | null; timeout_seconds: number } | undefined;
          if (t === undefined && !this.closing) { await new Promise((r) => setTimeout(r, 5_000)); continue; }
          if (!t || ["done", "failed", "timeout"].includes(t.status)) return;
          const dl = t.deadline_at ? new Date(t.deadline_at).getTime() : 0;
          const sleepUnref = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
          if (dl <= 0) { await sleepUnref(t.timeout_seconds>0?500:30000); continue; }
          const remaining = dl - Date.now();
          if(remaining>0&&remaining<=reportLeadSeconds(t.timeout_seconds)*1000&&this.reportPrepared.get(taskId)!==dl){await checkpointTaskReport(this.pool,taskId);this.reportPrepared.set(taskId,dl);}
          if (remaining > 0) { const untilReport=remaining-reportLeadSeconds(t.timeout_seconds)*1000;await sleepUnref(Math.min(remaining,untilReport>0?untilReport:60000,60000));continue; }
          if(this.closing)return;
          await this.settleTask(taskId);return;
        }
      } finally {
        this.coordStarted.delete(taskId);
      }
    })().catch(error=>console.error('[deadline] coordinator failed',error));
  }
  /** Source engine_timeout.go: single coordinator, 90s drain, terminal planner, guarded state. */
  private settleTask(taskId:number):Promise<void>{
    const existing=this.settling.get(taskId);if(existing)return existing;
    const settlement=new AbortController();this.settlementControllers.set(taskId,settlement);
    let releaseSlot:(()=>void)|undefined;
    const work=Promise.resolve().then(async()=>{
      if(this.closing||this.isDeleting(taskId))return;
      const initial=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL AND status IN ('created','running','paused')",[taskId])).rows[0] as TaskSnapshot|undefined;
      if(!initial)return;
      if(initial.kind==='modeling'){
        await this.modeling.fail(taskId,'timeout',"Business modeling execution exceeds the upper limit of time; the draft has been submitted for retention and the main test continues");
        this.abort(taskId);await this.emit(taskId,'modeling_timeout',{draft_preserved:true});return;
      }
      releaseSlot=await this.slots.acquire(taskId,AbortSignal.any([settlement.signal,this.slotAbort.signal]));
      if(settlement.signal.aborted)return;
      await this.emit(taskId,'task_settling',{});
      const run=this.runs.get(taskId);let timer:ReturnType<typeof setTimeout>|undefined;
      if(run){
        if(initial.execution_mode==='continuous'){run.abort.abort();this.invalidate(run);}
        const graceful=await Promise.race([run.done.then(()=>true),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),initial.execution_mode==='continuous'?10000:90000);})]);
        if(timer)clearTimeout(timer);
        if(!graceful){this.invalidate(run);await Promise.race([run.done,new Promise(r=>setTimeout(r,3000))]);}
      }
      if(this.closing||this.isDeleting(taskId)||settlement.signal.aborted)return;
      await fingerprintMayComplete(this.pool,taskId,true);await pocMayComplete(this.pool,taskId,true);
      let met=false;
      try{met=await this.finalPlannerRound(taskId);}catch(error){await this.emit(taskId,'final_planner_error',{error:String(error)}).catch(console.error);}
      if(this.closing||this.isDeleting(taskId)||settlement.signal.aborted)return;
      const release=this.beginTaskOperation(taskId);if(!release)return;
      try{
        const status=initial.execution_mode==='continuous'?'timeout':met?'done':'timeout',won=await withTaskReport(this.pool,taskId,"Task deadline reached",c=>c.query("WITH terminal AS (UPDATE tasks SET status=$2,paused=false,queued=false,queued_at=NULL,stopped_reason=CASE WHEN $2='timeout' THEN 'The task has reached the deadline, the discovery and unfinished directions have been retained' ELSE stopped_reason END,completed_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND status IN ('created','running','paused') RETURNING id), stopped AS (UPDATE exploration_nodes SET state='stopped',completed_at=now(),updated_at=now() WHERE task_id IN (SELECT id FROM terminal) AND kind='intent' AND state IN ('open','running','paused','blocked') RETURNING id) SELECT id FROM terminal",[taskId,status]));
        if(won.rowCount)await this.emit(taskId,met?'task_done':'task_timeout',{});
      }finally{release();}
    }).finally(()=>{releaseSlot?.();this.settlementControllers.delete(taskId);if(this.settling.get(taskId)===work)this.settling.delete(taskId);
      // Clear again after writing the final state: When the run loop exits, the agent cleanup will be due to the task or running while skipping
      void this.proxies.stopTaskIfTerminal(taskId).catch(() => {});
      void this.pumpQueue().catch(console.error);});
    this.settling.set(taskId,work);return work;
  }
  private async finalPlannerRound(taskId:number):Promise<boolean>{
    const release=this.beginTaskOperation(taskId);if(!release)return false;
    const ctl=new AbortController();this.finalRuns.set(taskId,ctl);let host:HostedSession|undefined;
    const finalTimer=setTimeout(()=>ctl.abort(),30000);
    try{
      let task:TaskSnapshot|undefined,spec:Awaited<ReturnType<AgentsService['resolveSessionSpec']>>|undefined,profile:{provider?:string;modelId?:string}|undefined;
      // Finalization cannot wait forever for an unavailable model profile.
      const readyDeadline=Date.now()+30000;
      while(!ctl.signal.aborted&&!this.closing&&!this.isDeleting(taskId)&&Date.now()<readyDeadline){
        task=(await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL AND status IN ('created','running','paused')",[taskId])).rows[0];
        if(!task)return false;
        try{spec=await this.deps.agents.resolveSessionSpec('planner',{Goal:task.goal,DataDir:this.config.dataDir});profile=await this.profile(task,spec);break;}catch{
          await new Promise<void>(r=>{const timer=setTimeout(done,2000);function done(){clearTimeout(timer);ctl.signal.removeEventListener('abort',done);r();}ctl.signal.addEventListener('abort',done,{once:true});});
        }
      }
      if(!task||!spec||!profile||ctl.signal.aborted||this.closing)return false;
      const canExecute=async()=>!ctl.signal.aborted&&!this.closing&&!this.isDeleting(taskId)&&!!(await this.pool.query("SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL AND status IN ('created','running','paused')",[taskId])).rowCount;
      const ctx={businessKind:'planner',businessId:'task-'+taskId+'-final',agentKey:'planner',taskId,signal:ctl.signal,canExecute};
      const tools=await assembleTools(this.pool,['graph_overview','list_facts','node_detail','list_goals','prove_goal','resolve_goal','expand_digest',...TRACE_TOOLS.planner,'list_findings','report_finding'],ctx,await this.gateOptions());
      const row=(await this.pool.query("SELECT task_timeout_wrapup_prompt,task_timeout_wrapup_max_turns FROM agents WHERE key='planner'")).rows[0];
      const finalPrompt=goTrim(String(row?.task_timeout_wrapup_prompt??''))?row.task_timeout_wrapup_prompt:promptDefaults.wrapup.planner!.task_timeout;
      await this.graph.ensure(taskId);
      await this.pool.query("UPDATE explorations SET round_no=round_no+1 WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)",[taskId]);
      await this.emit(taskId,'final_planner_start',{});
      host=await createHostedSession(this.pool,this.config,{kind:'planner',businessId:ctx.businessId,cwd:taskWorkDir(this.config,taskId),systemPrompt:spec.systemPrompt+artifactSpec(taskWorkDir(this.config,taskId))+"\nClosing date: Only existing evidence and reports will be sorted out, no new directions, target requests or orders will be executed.",...profile,customTools:tools,customToolsOnly:true,freshContext:true,runBudget:{maxTurns:Math.max(1,Number(row?.task_timeout_wrapup_max_turns)||3),runSeconds:30},activity:{taskId,worker:'planner'}});
      const cancel=()=>void host?.session.abort();ctl.signal.addEventListener('abort',cancel,{once:true});
      try{if(!await canExecute())return false;await host.session.prompt("Mission exploration graph overview:\n"+JSON.stringify({...await this.graph.overview(taskId),fingerprints:await this.deps.fingerprints?.summary(taskId),poc_knowledge:await this.deps.pocs?.summary(taskId)})+"\n[Mission ending (special instructions for this round, covering the above regular planning process)]:"+finalPrompt);await host.flushEvents();if(host.modelFailure)throw new Error(host.modelFailure);}
      finally{ctl.signal.removeEventListener('abort',cancel);}
      const achieved=await this.pool.query("SELECT 1 FROM explorations e JOIN tasks t ON t.exploration_id=e.id WHERE t.id=$1 AND e.status='achieved'",[taskId]);
      await this.emit(taskId,'final_planner_done',{met:!!achieved.rowCount});return !!achieved.rowCount;
    }catch(error){await this.emit(taskId,'final_planner_error',{error:String(error)});return false;}
    finally{clearTimeout(finalTimer);await host?.dispose();if(this.finalRuns.get(taskId)===ctl)this.finalRuns.delete(taskId);release();}
  }
  private async admitted(run: RunContext, generation: number): Promise<boolean> {
    if (this.settling.has(run.taskId) || !run.releaseSlot || run.abort.signal.aborted || run.paused || run.generation !== generation || this.isDeleting(run.taskId)) return false;
    const r = await this.pool.query("SELECT 1 FROM tasks WHERE id=$1 AND status='running' AND paused=FALSE AND queued=FALSE AND deleted_at IS NULL AND archived=FALSE AND (deadline_at IS NULL OR deadline_at>now()) AND (execution_mode='continuous' OR NOT EXISTS(SELECT 1 FROM explorations WHERE id=tasks.exploration_id AND status='achieved'))", [run.taskId]);
    return (r.rowCount ?? 0) > 0 && !run.abort.signal.aborted && !run.paused && run.generation === generation;
  }
  private async wait(run: RunContext, ms: number): Promise<void> {
    if (run.abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); run.abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      run.abort.signal.addEventListener("abort", done, { once: true });
      if (run.abort.signal.aborted) done();
    });
  }
  private async supervise(run: RunContext, workers: number): Promise<void> {
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      const r = await this.pool.query(`UPDATE tasks SET status='running',queued=FALSE,updated_at=now()
        WHERE id=$1 AND status IN ('created','running') AND paused=FALSE AND deleted_at IS NULL AND archived=FALSE RETURNING *`, [run.taskId]);
      const task = r.rows[0] as TaskSnapshot | undefined;
      if (!task || run.abort.signal.aborted) return;
      if(task.execution_mode==='continuous'&&!task.deadline_at){const clock=(await this.pool.query("UPDATE tasks SET first_run_at=COALESCE(first_run_at,now()),deadline_at=now()+make_interval(secs=>timeout_seconds) WHERE id=$1 RETURNING deadline_at",[run.taskId])).rows[0];task.deadline_at=clock.deadline_at;}
      await this.graph.ensure(run.taskId);
      const timeout=()=>this.settleTask(run.taskId);
      if (task.deadline_at) {
        const left = new Date(task.deadline_at).getTime() - Date.now();
        if(left<=0){void timeout().catch(console.error);return;}
        deadlineTimer = setTimeout(() => void timeout().catch(console.error), left);
      }
      if(task.kind==='pentest'){await taskProgress(this.pool,run.taskId,'starting',"The task has been started and the test environment is being prepared");this.initializeBackgroundModeling(run.taskId);}
      if(task.kind==='modeling'){
        const stamped=(await this.pool.query("UPDATE tasks SET first_run_at=COALESCE(first_run_at,now()),deadline_at=COALESCE(deadline_at,now()+make_interval(secs=>timeout_seconds)),queue_mode='' WHERE id=$1 AND status='running' AND NOT paused RETURNING deadline_at",[run.taskId])).rows[0];
        if(!stamped)return;
        task.deadline_at=stamped.deadline_at;
        if(!deadlineTimer)deadlineTimer=setTimeout(()=>void timeout().catch(console.error),Math.max(0,new Date(stamped.deadline_at).getTime()-Date.now()));
        await this.runModeling(run,task);
        return;
      }
      const stamped=(await this.pool.query("UPDATE tasks SET first_run_at=COALESCE(first_run_at,now()),deadline_at=CASE WHEN first_run_at IS NOT NULL OR deadline_at IS NOT NULL THEN deadline_at WHEN timeout_seconds>0 THEN now()+make_interval(secs=>timeout_seconds) ELSE NULL END,queue_mode='' WHERE id=$1 AND status='running' AND NOT paused AND deleted_at IS NULL RETURNING deadline_at",[run.taskId])).rows[0];
      if(!stamped)return;
      if(!task.deadline_at&&stamped.deadline_at){task.deadline_at=stamped.deadline_at;deadlineTimer=setTimeout(()=>void timeout().catch(console.error),Math.max(0,new Date(stamped.deadline_at).getTime()-Date.now()));}
      const existing = await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN ('open','running') LIMIT 1", [run.taskId]);
      const goals=await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='goal' LIMIT 1",[run.taskId]);
      if(!goals.rowCount&&(task.queue_mode==='bootstrap'||!existing.rowCount)&&String(task.goal).trim())await this.decomposeGoals(run,task,run.generation);
      if(!await this.admitted(run,run.generation))return;
      if (!existing.rowCount) run.pending = true;
      if(this.deps.pocs&&await this.deps.pocs.available(run.taskId))await this.deps.pocs.pin(run.taskId);
      if(this.deps.fingerprints&&await this.deps.fingerprints.available(run.taskId)){
        await taskProgress(this.pool,run.taskId,'fingerprinting',"Identifying target fingerprint and matching PoC clues");
        try{await bootstrapFingerprints(this.pool,this.deps.fingerprints,run.taskId,run.execution.signal,async(url,signal)=>runTool(this.pool,'http_request',{url,method:'GET'},{businessKind:'worker',businessId:`task-${run.taskId}-fingerprint-bootstrap`,agentKey:'worker',workerName:'fingerprint-bootstrap',taskId:run.taskId,signal,canExecute:()=>this.admitted(run,run.generation)},{...await this.gateOptions(),enforceInterceptScope:true}));}
        catch(e){console.warn('[fingerprints] task initialization:',String(e));await this.emit(run.taskId,'fingerprint_bootstrap_error',{error:String(e).slice(0,400)});}
      }
      if(!await this.admitted(run,run.generation))return;
      await this.deps.pocs?.refresh(run.taskId);
      await taskProgress(this.pool,run.taskId,'testing',"Scheduling and executing test checks");
      // Index/The audit may live longer than the task, so it does not enter this group of waits and the ending will not be delayed by it.
      this.startCodeIntel(run.taskId);
      const loops = [this.efficiencyLoop(run),this.plannerLoop(run, task), ...Array.from({ length: workers }, (_, i) => this.workerLoop(run, i + 1))];
      // First loop failure cancels siblings; always drain them before releasing the slot.
      try { await Promise.all(loops); }
      catch (err) { this.abort(run.taskId); await Promise.allSettled(loops); throw err; }
    } catch (err) {
      await withTaskReport(this.pool,run.taskId,"Execution exception, save existing results",c=>c.query("UPDATE tasks SET status='failed',stopped_reason=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status='running'", [run.taskId, String(err).slice(0,200)])).catch(() => {});
      await this.emit(run.taskId, "task_error", { error: String(err) }).catch(() => {});
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      run.abort.abort();
      this.invalidate(run);
      await Promise.allSettled([...run.sessions].map((h) => h.dispose()));
      run.sessions.clear();
      await this.browsers?.stopTask(run.taskId);
      // A reverse proxy must never outlive the task it was built for.
      await this.proxies.stopTaskIfTerminal(run.taskId).catch((error) => console.error("[reverse-proxy] Failed to clean up after task end", String(error)));
    }
  }
  private async efficiencyLoop(run:RunContext):Promise<void>{
    let nextCheck=0;
    while(!run.abort.signal.aborted&&!this.settling.has(run.taskId)){
      if(Date.now()>=nextCheck&&!run.paused){
        await this.efficiency.refresh();
        nextCheck=Date.now()+30000;
        if(!await this.admitted(run,run.generation)){await this.wait(run,1000);continue;}
        const sample=await this.efficiency.sample(run.taskId),state=await this.efficiency.observe(run.taskId,sample);
        await this.efficiency.review(run.taskId,sample);
        const continuous=(await this.pool.query('SELECT execution_mode FROM tasks WHERE id=$1',[run.taskId])).rows[0]?.execution_mode==='continuous';
        let reason=efficiencyDecision(state,sample,continuous?{...this.efficiency.options,maxActiveSeconds:0}:this.efficiency.options,Date.now());
        // A scheduled planner remains alive during evidence droughts. Explicit
        // model/time/token budgets and task deadlines still take precedence.
        if(reason==='no_new_evidence'&&(await this.pool.query("SELECT 1 FROM task_planner_recovery r WHERE r.task_id=$1 AND EXISTS(SELECT 1 FROM exploration_nodes n WHERE n.task_id=$1 AND n.kind='goal' AND n.state<>'met' AND NOT n.payload ? 'resolution')",[run.taskId])).rowCount)reason=null;
        if(reason&&await this.efficiency.pause(run.taskId,reason,sample))this.pause(run.taskId);
      }
      await this.wait(run,1000);
    }
  }
  private async plannerLoop(run: RunContext, task: TaskSnapshot): Promise<void> {
    const interval = task.execution_mode==='continuous'?Math.min(60000,plannerInterval(Number(task.plan_heartbeat_seconds)||600)):plannerInterval(Number(task.plan_heartbeat_seconds) || 600);
    let nextHeartbeat = Date.now() + interval;
    while (!run.abort.signal.aborted&&!this.settling.has(run.taskId)) {
      const state = await this.pool.query("SELECT status,paused FROM tasks WHERE id=$1 AND deleted_at IS NULL", [run.taskId]);
      const row = state.rows[0];
      if (!row || !['running','paused'].includes(row.status)) { this.abort(run.taskId); return; }
      const review=(await this.pool.query(`SELECT next_attempt_at,model_revision,${plannerModelRevisionSQL} AS current_model_revision FROM task_planner_recovery WHERE task_id=$1`,[run.taskId])).rows[0];
      const reviewDue=!!review&&(Date.now()>=new Date(review.next_attempt_at).getTime()||review.model_revision!==review.current_model_revision);
      if (!run.paused && !row.paused && (run.pending || reviewDue || Date.now() >= nextHeartbeat)) {
        // A single planner consumes all edges; workers never run a planner session.
        await this.wait(run, 3000);
        if(this.settling.has(run.taskId))return;
        run.pending = false;
        const generation = run.generation;
        if (await this.admitted(run, generation)) {
          const achieved=await this.pool.query("SELECT 1 FROM explorations e JOIN tasks t ON t.exploration_id=e.id WHERE t.id=$1 AND e.status='achieved'",[run.taskId]);
          await this.deps.pocs?.refresh(run.taskId);
          const fingerprintReview=await fingerprintNeedsReview(this.pool,run.taskId)||await pocNeedsReview(this.pool,run.taskId);
          if(!fingerprintReview&&await this.efficiency.finishCovered(run.taskId)){this.abort(run.taskId);return;}
          const goals = await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='goal' AND state='open' LIMIT 1", [run.taskId]);
          const active = await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN ('open','running') LIMIT 1", [run.taskId]);
          const anyIntent = await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='intent' LIMIT 1", [run.taskId]);
          // Original goalless branch: no active intents -> done; open goals never finish on idle.
          const completionRequested=!!(await this.pool.query('SELECT 1 FROM task_fingerprint_state WHERE task_id=$1 AND completion_requested UNION ALL SELECT 1 FROM task_poc_state WHERE task_id=$1 AND completion_requested',[run.taskId])).rowCount;
          const closing=task.execution_mode!=='continuous'&&!!(completionRequested||achieved.rowCount||(!goals.rowCount&&anyIntent.rowCount&&!active.rowCount));
          const fingerprintReady=!closing||(await fingerprintMayComplete(this.pool,run.taskId)&&await pocMayComplete(this.pool,run.taskId));
          if(closing&&!fingerprintReady){run.pending=true;if(!fingerprintReview){await this.wait(run,100);continue;}}
          if (closing && fingerprintReady && !fingerprintReview) {
            if(completionRequested){if(await completeAchievedTask(this.pool,run.taskId)){this.abort(run.taskId);return;}run.pending=true;continue;}
            const won = await withTaskReport(this.pool,run.taskId,"The current exploration direction has been completed",c=>c.query("UPDATE tasks SET status='done',completed_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND paused=FALSE RETURNING id", [run.taskId]));
            if (won.rowCount) await this.emit(run.taskId, "task_done", {});
            if(won.rowCount)await this.pool.query("UPDATE exploration_nodes SET state='stopped',completed_at=now(),claimed_by=NULL,claimed_at=NULL,updated_at=now() WHERE task_id=$1 AND kind='intent' AND state IN('open','running','paused','blocked')",[run.taskId]);
            this.abort(run.taskId);
            return;
          }
          if(task.execution_mode==='continuous'&&!fingerprintReview&&await finishDiscoveryIfReady(this.pool,run.taskId)){this.abort(run.taskId);return;}
          if (goals.rowCount || !anyIntent.rowCount || fingerprintReview || task.execution_mode==='continuous'){
            const sample=await this.efficiency.sample(run.taskId);
            const prior=(await this.pool.query('SELECT plan_signature FROM task_efficiency_state WHERE task_id=$1',[run.taskId])).rows[0];
            if(!reviewDue&&this.efficiency.options.enabled&&prior?.plan_signature===sample.revision&&!(task.execution_mode==='continuous'&&Date.now()-(run.lastDiscoveryReview??0)>=60000)){
              // No graph/hint changes: a heartbeat is a cheap supervision tick.
              await this.efficiency.recordRound(run.taskId,sample);
            }else{run.lastDiscoveryReview=Date.now();await this.plan(run, task, generation,sample);}
          }
        }
        nextHeartbeat = Date.now() + interval;
      }
      await this.wait(run, 1000);
    }
  }
  /** Code Indexing Pipeline: Import → Issue audit → Receive clues. The model does not participate and does not block anyone。 */
  private startCodeIntel(taskId: number, graceDeadline = 0): void {
    if(this.closing||this.isDeleting(taskId))return;
    const revision=this.intelRevisions.get(taskId)??0;
    const existing = this.intelTasks.get(taskId);
    if (existing && !existing.signal.aborted) return;   // Already running
    const running = this.intelDone.get(taskId);
    if (running) {
      // The old loop is still exiting: wait for it to end before starting a new one to avoid two loops starting the same task at the same time.
      const restart=()=>{if((this.intelRevisions.get(taskId)??0)===revision)this.startCodeIntel(taskId,graceDeadline);};void running.then(restart,restart);
      return;
    }
    const ctl = new AbortController();
    this.intelTasks.set(taskId, ctl);
    const loop: Promise<void> = this.codeIntelLoop(taskId, ctl.signal, graceDeadline)
      .catch(error => console.error('[codeintel] loop:', String(error)))
      .finally(() => {
        if (this.intelTasks.get(taskId) === ctl) this.intelTasks.delete(taskId);
        if (this.intelDone.get(taskId) === loop) this.intelDone.delete(taskId);
        this.intelLoops.delete(loop);
      });
    this.intelDone.set(taskId, loop);
    this.intelLoops.add(loop);
  }

  private async codeIntelLoop(taskId: number, signal: AbortSignal, graceDeadline = 0): Promise<void> {
    const interval = Math.max(5000, this.codeIntel.options.pollSeconds * 1000);
    // After the task ends, there is still a window left to collect the results of the analysis; if they are not received, they will remain visible, which will not affect the task conclusion.
    const grace = 10 * 60 * 1000;
    // When restarting and restoring, the remaining window is calculated according to the completion time of persistence and does not restart from the current time.
    let graceUntil = graceDeadline;
    const sleep = (ms: number) => new Promise<void>(resolve => {
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
    });
    while (!signal.aborted && !this.isDeleting(taskId)) {
      const row = (await this.pool.query('SELECT status,paused FROM tasks WHERE id=$1 AND deleted_at IS NULL', [taskId]).catch(() => null))?.rows[0];
      if (!row) return;
      const terminal = ['done', 'failed', 'timeout'].includes(String(row.status));
      if (row.status==='failed'||row.status==='timeout') {await this.codeIntel.stopTask(taskId).catch(()=>{});return;}
      if (terminal) {
        graceUntil = graceUntil || Date.now() + grace;
        if (Date.now() > graceUntil) {
          await this.codeIntel.markUnfinished(taskId).catch(() => {});
          return;
        }
      }
      if (!row.paused) {
        // After the final state, only existing work is recycled: no new analyzes are scanned, imported, or dispatched
        await this.codeIntel.tick(taskId, signal, terminal ? 'collect' : 'full')
          .catch(error => console.error('[codeintel] tick:', String(error)));
      }
      await sleep(interval);
    }
  }

  private async workerLoop(run: RunContext, number: number): Promise<void> {
    let idleMs=250;
    while (!run.abort.signal.aborted&&!this.settling.has(run.taskId)) {
      const generation = run.generation;
      if (!(await this.admitted(run, generation))) { await this.wait(run, 1000); continue; }
      const claim = await claimNextIntent(this.pool, run.taskId, `worker-task${run.taskId}-${number}`);
      if (!claim.claimed || !claim.intentId) {
        await this.wait(run, idleMs);idleMs=Math.min(2000,idleMs*2);continue;
      }
      idleMs=250;
      if(this.settling.has(run.taskId)){await this.pool.query("UPDATE exploration_nodes SET state='open',claimed_by=NULL,claimed_at=NULL WHERE id=$1 AND state='running'",[claim.intentId]);return;}
      await this.runIntent(run, claim.intentId, generation,`work#${number}`,`worker-task${run.taskId}-${number}`);
      this.notify(run.taskId);
    }
  }
  private async plan(run: RunContext, task: TaskSnapshot, generation: number,plannedSample:ProgressSample): Promise<void> {
    await runPlannerRound(this.pool,run.taskId,recovery=>this.planAttempt(run,task,generation,plannedSample,recovery),()=>this.admitted(run,generation));
  }
  private async planAttempt(run: RunContext, task: TaskSnapshot, generation: number,plannedSample:ProgressSample,plan:PlannerPlan): Promise<PlannerOutcome> {
    const recovery=plan.strategy!=='normal';
    let outcome:PlannerOutcome;
    let h: HostedSession | null = null;
    try {
      const spec = await this.deps.agents.resolveSessionSpec(task.agent_key || "planner",{Goal:String(task.goal??""),DataDir:this.config.dataDir});
      const profile = await this.profile(task, spec);
      const ctx={businessKind:'planner',businessId:`task-${run.taskId}`,agentKey:'planner',taskId:run.taskId,signal:run.execution.signal,canExecute:()=>this.admitted(run,generation)};
      const tools=await this.augmentedTools([...GRAPH_TOOLS.planner,...ASSET_TOOLS.planner,...FINGERPRINT_TOOLS,...POC_TOOLS,...WORK_CONTROLS,...TRACE_TOOLS.planner,...MODELING_REQUEST_TOOLS,'list_findings','report_finding','reverse_proxies',...(this.deps.trafficFlow?['traffic_candidates']:[])],ctx,await this.gateOptions());
      h = await createHostedSession(this.pool, this.config, { kind: "planner", businessId: `task-${run.taskId}`, cwd:taskWorkDir(this.config,run.taskId),systemPrompt: spec.systemPrompt+(await extensionAvailable('fingerprints',run.taskId)?FINGERPRINT_GUIDANCE:'')+(await extensionAvailable('pocs',run.taskId)?POC_GUIDANCE:'')+MODELING_GUIDANCE+artifactSpec(taskWorkDir(this.config,run.taskId))+TRAFFIC_GUIDANCE+plannerEfficiencyGuidance+plannerReverseGuidance+continuousGuidance(task), ...profile, customTools:tools, freshContext:true,activity:{taskId:run.taskId,worker:"planner"} });
      run.sessions.add(h);
      if (!(await this.admitted(run, generation))) return;
      const beforePlanning=(await plannerRevisions(this.pool,run.taskId)).progress;
      const hints=run.hintTriggers.splice(0),triggerText=hints.map(texts=>`People added ${texts.length} strategic tips:${texts.join("；")}`).join("\n");
      const overview=await this.graph.overview(run.taskId);
      const fingerprints=await this.deps.fingerprints?.summary(run.taskId);
      const pocKnowledge=await this.deps.pocs?.deliver(run.taskId,'planner');
      Object.assign(overview,{browser_environments:this.browsers?.list(run.taskId)??[],business_models:await this.modeling.catalog(run.taskId),fingerprints,poc_knowledge:pocKnowledge});
      if(fingerprints)await recordFingerprintDelivery(this.pool,run.taskId,'planner',fingerprints.revision,fingerprints.observations.flatMap(o=>o.observation_ids));
      const flow=await this.deps.trafficFlow?.list(run.taskId);
      const constraints=await this.pool.query('SELECT kind,text FROM task_constraints WHERE task_id=$1 ORDER BY id',[run.taskId]);
      await this.pool.query('UPDATE explorations SET round_no=round_no+1 WHERE id=(SELECT exploration_id FROM tasks WHERE id=$1)',[run.taskId]);
      await taskProgress(this.pool,run.taskId,recovery?'planning_recovery':'planning',plannerMessages[plan.strategy]);
      const summary=plannerRecoveryContext(overview,plan);
      await withPlannerRecovery(recovery,()=>h!.session.prompt(`${plannerRecoveryPrompt(plan)}
Mission exploration graph overview:
${JSON.stringify(summary)}
Operational constraints:${JSON.stringify(constraints.rows)}
Observed Traffic and Sharing Check:${JSON.stringify(recovery?compactPlannerContext(flow??[],plan.failures):flow??[])}
Trigger this round:${triggerText}
Use add_intent to submit new directions; use prove_goal to mark goals that have been proven by facts/findings. There is no new direction that can directly end this round, and the end of this round cannot be regarded as the achievement of the goal.`));
      await h.flushEvents();
      if (!(await this.admitted(run, generation))) return;
      if(h.modelFailure)throw new Error(h.modelFailure);
      const messages = h.session.messages as { role: string; content?: {type: string; text?: string}[]; stopReason?: string; errorMessage?: string }[];
      const last = messages.filter((m) => m.role === 'assistant').at(-1);
      if (last?.stopReason === 'error') throw new Error(last.errorMessage || 'planner model error');
      if(fingerprints)await acknowledgeFingerprintReview(this.pool,run.taskId,fingerprints.revision);
      if(pocKnowledge?.enabled)await pocReviewed(this.pool,run.taskId,pocKnowledge.revision);
      if((await this.pool.query('SELECT 1 FROM task_fingerprint_state WHERE task_id=$1 AND completion_requested UNION ALL SELECT 1 FROM task_poc_state WHERE task_id=$1 AND completion_requested',[run.taskId])).rowCount)run.pending=true;
      const intents=await this.graph.nodes(run.taskId,'intent');
      const activeIntents=intents.filter(n=>['open','running'].includes(n.state));
      await taskProgress(this.pool,run.taskId,activeIntents.length?'testing':'monitoring',activeIntents.length?"This round of planning has been completed and the dispatched inspections are being carried out":"This round of inspection has ended, waiting for new clues or next round of planning");
      await this.emit(run.taskId, 'planner_done', { intents: intents.length });
      // A worker can publish new evidence while the model is thinking. Only
      // acknowledge the revision supplied to this planning round, never newer work.
      await this.efficiency.recordRound(run.taskId,await this.efficiency.sample(run.taskId),plannedSample.revision);
      if(task.execution_mode!=='continuous'&&!(await this.pool.query("SELECT 1 FROM exploration_nodes WHERE task_id=$1 AND kind='goal' AND state<>'met' AND NOT payload ? 'resolution' LIMIT 1",[run.taskId])).rowCount)run.pending=true;
      if(task.execution_mode==='continuous'&&await finishDiscoveryIfReady(this.pool,run.taskId))this.abort(run.taskId);
      outcome=(await plannerRevisions(this.pool,run.taskId)).progress!==beforePlanning?'progress':activeIntents.length?'waiting':'idle';
    } catch (err) {
      outcome=h?.modelStopReason==='length'?'length':'error';
      if(task.execution_mode==='continuous')await this.pool.query('UPDATE tasks SET discovery_finish_request=NULL WHERE id=$1',[run.taskId]);
      if (await this.admitted(run, generation)) {await this.emit(run.taskId, 'planner_error', {error: String(err)});await this.efficiency.recordFailure(run.taskId);}
    } finally {
      if (h) { await h.dispose(); run.sessions.delete(h);this.releaseIdleSlot(run); }
    }
    return outcome;
  }
  private async decomposeGoals(run:RunContext,task:TaskSnapshot,generation:number):Promise<void>{
    let h:HostedSession|null=null;
    try{
      await taskProgress(this.pool,run.taskId,'planning',"Decomposing test targets, waiting for planning model response");
      const spec=await this.deps.agents.resolveSessionSpec('goals',{EngagementDescription:String(task.description??task.goal??''),DataDir:this.config.dataDir});
      const ctx={businessKind:'planner',businessId:`task-${run.taskId}-goals`,agentKey:'goals',taskId:run.taskId,signal:run.execution.signal,canExecute:()=>this.admitted(run,generation)};
      h=await createHostedSession(this.pool,this.config,{kind:'planner',businessId:ctx.businessId,cwd:taskWorkDir(this.config,run.taskId),systemPrompt:spec.systemPrompt+artifactSpec(taskWorkDir(this.config,run.taskId))+goalEfficiencyGuidance+continuousGuidance(task),...await this.profile(task,spec),customTools:await this.augmentedTools(GRAPH_TOOLS.goals,ctx,await this.gateOptions()),freshContext:true,activity:{taskId:run.taskId,worker:"planner"}});
      run.sessions.add(h);if(!(await this.admitted(run,generation)))return;
      await h.session.prompt(`Mission objective:
${task.goal}
Use set_constraints to extract explicit operational constraints, and then use set_goals to submit final verifiable goals.`);await h.flushEvents();if(h.modelFailure)throw new Error(h.modelFailure);
    }catch(e){if(await this.admitted(run,generation))await this.emit(run.taskId,'goals_error',{error:String(e)});}
    finally{if(h){await h.dispose();run.sessions.delete(h);this.releaseIdleSlot(run);}}
    if(!(await this.admitted(run,generation)))return;
    const existing=await this.graph.nodes(run.taskId,'goal');
    if(!existing.length){await this.graph.addGoal(run.taskId,{text:task.goal},'system');await this.emit(run.taskId,'goals_fallback',{reason:"LLM did not submit the target, the original mission target was treated as a single target"});}
  }
  private async gateOptions(){
    return {rules:await this.deps.intercept.gateRules(),getRules:()=>this.deps.intercept.gateRules(),requestApproval:(id:number,reason?:string,ms?:number,action?:'deny'|'allow',signal?:AbortSignal)=>this.deps.intercept.requestApproval(id,reason,ms,action,signal),
      judge:(tool:string,params:Record<string,unknown>,context:ToolContext)=>runJudge({pool:this.pool,config:this.config,tool,params,context})};
  }
  private async profile(task: TaskSnapshot, spec: {agentKey?:string;provider?: string; modelId?: string}): Promise<{provider?: string; modelId?: string}> {
    const selected=await new TaskModelResolver(this.pool,this.config,await getPiRuntime(this.config),Number(task.id),spec.agentKey??'planner').current();
    return {provider:selected.model.provider,modelId:selected.model.id};
  }
  private async augmentedTools(keys:string[],ctx:ToolContext,gate:GateOptions):Promise<ToolDefinition[]>{
    const tools=await assembleTools(this.pool,keys,ctx,gate);
    if(!this.deps.mcp)return tools;
    const augmentation=await augmentSession(this.pool,this.deps.mcp,this.deps.skills,ctx,gate);
    return bindAugmentation([...tools,...augmentation.tools],augmentation);
  }
  private async workerTools(run: RunContext, intentId: number, generation: number, signal: AbortSignal,workerName:string): Promise<ToolDefinition[]> {
    const taskId = run.taskId;
    // G04：ctx Carry taskId/intentId，Business handler From ctx Parse attribution (see tools/business.ts）
    const canExecute=async(toolKey?:string)=>{
      if(signal.aborted)return false;
      const admitted=await this.admitted(run,generation);
      // At the deadline, the bounded wrap-up may persist existing observations.
      // It must not admit another network request, shell command or worker.
      if(!admitted){
        if(!['record_fact','report_finding','save_worker_checkpoint'].includes(toolKey??'')||!run.releaseSlot||run.abort.signal.aborted||run.paused||run.generation!==generation||this.isDeleting(taskId))return false;
        if(!(await this.pool.query("SELECT 1 FROM tasks WHERE id=$1 AND status='running' AND paused=FALSE AND queued=FALSE AND deleted_at IS NULL AND archived=FALSE AND deadline_at<=now()",[taskId])).rowCount)return false;
      }
      return !!(await this.pool.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND task_id=$2 AND state='running'",[intentId,taskId])).rowCount;
    };
    const ctx = { businessKind: "worker", businessId: `task-${taskId}-intent-${intentId}`, agentKey: "worker", runId: `task-${taskId}`, taskId, intentId, workerName, signal, canExecute,beforeExecute:async()=>{const work=this.work.get(intentId);if(work?.skipTools){work.skipTools--;throw new Error("The planner has injected correction instructions and this action has not been executed; please re-plan the next step according to the new instructions.");}} };
    // G06：Unified gate options - interception rules (including timeout）+ Approval + judge Keep the whole story in mind（tools/judge.ts Real model adjudication）
    const gateOpts = {
      rules: await this.deps.intercept.gateRules(),getRules:()=>this.deps.intercept.gateRules(),
      requestApproval: (tcid: number, reason?: string, timeoutMs?: number, timeoutAction?: "deny" | "allow", signal?: AbortSignal) =>
        this.deps.intercept.requestApproval(tcid, reason, timeoutMs, timeoutAction, signal),
      judge: (toolKey: string, params: Record<string, unknown>,context:ToolContext) =>
        runJudge({ pool: this.pool, config: this.config, tool: toolKey, params,context }),
    };

      return this.augmentedTools([...GRAPH_TOOLS.worker,...ASSET_TOOLS.worker,...FINGERPRINT_TOOLS,...POC_TOOLS,...TRACE_TOOLS.worker,...HANDOFF_TOOLS,...MODELING_REQUEST_TOOLS,...CODE_INTEL_TOOLS,...HUNT_TOOLS,...INTEL_TOOLS,'analysis_capabilities','list_findings','http_request','insert_assets','report_finding',...REVERSE_PROXY_TOOLS,...(this.browsers?['task_browser']:[]),...(this.deps.trafficFlow?CHECK_TOOLS:[])],ctx,gateOpts);

  }


  private async runIntent(run: RunContext, intentId: number, generation: number,workerName:string,leaseOwner:string): Promise<void> {
    let h: HostedSession | null = null;
    let ok = false;
    let routedFailure:import('../llm/task-stream.ts').RouterFailure|undefined;
    const work={taskId:run.taskId,abort:new AbortController(),session:undefined as HostedSession|undefined,steering:[] as string[],skipTools:0,fingerprintRevision:-1,pocRevision:-1,modelingRevision:''};this.work.set(intentId,work);
    const signal = AbortSignal.any([run.execution.signal,work.abort.signal]);
    const cancel=()=>{void h?.session.abort().catch(console.error);};signal.addEventListener('abort',cancel,{once:true});
    try {
      if (!(await this.admitted(run, generation))) return;
      const spec = await this.deps.agents.resolveSessionSpec('worker',{WorkerName:workerName,DataDir:this.config.dataDir});
      const task = (await this.pool.query('SELECT * FROM tasks WHERE id=$1',[run.taskId])).rows[0];
      const intent = (await this.pool.query('SELECT title,payload FROM exploration_nodes WHERE id=$1',[intentId])).rows[0];
      await taskProgress(this.pool,run.taskId,'testing',`${workerName.replace(/^work#/, 'Worker #')}：${String(intent?.title??intent?.payload?.summary??"Perform check").slice(0,140)}`);
      const constraints=(await this.pool.query('SELECT kind,text FROM task_constraints WHERE task_id=$1 ORDER BY id',[run.taskId])).rows;
      h = await createHostedSession(this.pool, this.config, {kind:'worker', businessId:`task-${run.taskId}-intent-${intentId}`,cwd:taskWorkDir(this.config,run.taskId,intentId),systemPrompt:spec.systemPrompt+BROWSER_GUIDANCE+(await extensionAvailable('fingerprints',run.taskId)?FINGERPRINT_GUIDANCE:'')+(await extensionAvailable('pocs',run.taskId)?POC_GUIDANCE:'')+MODELING_GUIDANCE+continuousGuidance(task)+artifactSpec(taskWorkDir(this.config,run.taskId,intentId),true)+TRAFFIC_GUIDANCE+reverseWorkerGuidance+"\nUse the provided tools to complete the task, use record_fact to write back the exploration graph for real observations; use report_finding to register vulnerabilities.\nBusiness model directory:"+JSON.stringify(await this.modeling.catalog(run.taskId))+"\nOperational constraints:"+JSON.stringify(constraints),...await this.profile(task,spec),customTools:await this.workerTools(run,intentId,generation,signal,workerName),activity:{taskId:run.taskId,nodeId:intentId,worker:workerName}});
      run.sessions.add(h);
      work.session=h;
      if (signal.aborted||!(await this.admitted(run, generation))) return;
      for(const message of work.steering)await h.session.steer(message);work.steering=[];
      const packet={...await this.handoffs.packet(run.taskId,intentId),browser_environments:this.browsers?.list(run.taskId)??[]};
      if(packet.fingerprints){work.fingerprintRevision=packet.fingerprints.revision;await recordFingerprintDelivery(this.pool,run.taskId,'worker',packet.fingerprints.revision,packet.fingerprints.observations.flatMap(o=>o.observation_ids),intentId);}
      if(packet.poc_knowledge?.enabled){work.pocRevision=packet.poc_knowledge.revision;await pocDelivery(this.pool,run.taskId,'worker',packet.poc_knowledge.revision,packet.poc_knowledge.candidates.map(c=>Number(c.id)),intentId);}
      if (signal.aborted || !await this.admitted(run, generation)) return;
      await h.session.prompt(`Execution Intent #${intentId}. Current structured handover package:
${JSON.stringify(packet)}`);
      await h.flushEvents();
      if(h.modelFailure)throw new Error(h.modelFailure);
      const last = h.session.messages.filter((m) => m.role === 'assistant').at(-1) as {stopReason?:string; errorMessage?:string}|undefined;
      if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(last?.errorMessage || 'worker did not complete');
      ok = true;
    } catch (err) {
      routedFailure=h?.llmFailure;
      if(!routedFailure&&String(err).includes('LLM profile chain exhausted'))routedFailure={routerHandled:true,chainExhausted:true};
      if (await this.admitted(run,generation)) await this.pool.query("UPDATE exploration_nodes SET last_error=$2 WHERE id=$1 AND state='running'",[intentId,String(err).slice(0,300)]);
    } finally {
      if (h) {
        const last=h.session.messages.filter(message=>message.role==='assistant').at(-1) as {content?:{type:string;text?:string}[]}|undefined;
        await this.handoffs.observe(run.taskId,intentId,{outcome:ok?'completed':signal.aborted?'interrupted':'error',summary:(last?.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n')}).catch(()=>console.warn('[handoff] runtime observation deferred; graph and native checkpoint retained'));
        try { await h.dispose(); }
        catch (error) { console.error("[worker] session cleanup failed", error); }
        finally { run.sessions.delete(h); this.releaseIdleSlot(run); }
      }
      this.browsers?.releaseWorker(run.taskId,'task-'+run.taskId+'-intent-'+intentId);
      signal.removeEventListener('abort',cancel);if(this.work.get(intentId)===work)this.work.delete(intentId);
      if(await releaseModelingIntent(this.pool,run.taskId,intentId,leaseOwner))return;
      if(work.abort.signal.aborted){await this.pool.query("UPDATE exploration_nodes SET state='stopped',completed_at=now(),updated_at=now() WHERE id=$1 AND state='running'",[intentId]);await this.emit(run.taskId,'intent_stopped',{intentId});return;}
      if (!(await this.admitted(run,generation))) {
        // CAS does not resurrect nodes already stopped by task control.
        await this.pool.query(`UPDATE exploration_nodes n SET
          state=CASE WHEN t.status IN ('done','failed','timeout') OR t.deleted_at IS NOT NULL THEN 'stopped' ELSE 'open' END,
          claimed_by=NULL,claimed_at=NULL,updated_at=now()
          FROM tasks t WHERE t.id=n.task_id AND n.id=$1 AND n.state='running'`,[intentId]);
      } else if (ok) {
        const done = await this.pool.query(`UPDATE exploration_nodes n SET state='done',updated_at=now() FROM tasks t
          WHERE n.id=$1 AND n.task_id=t.id AND n.state='running' AND t.status='running' AND t.paused=FALSE RETURNING n.id`,[intentId]);
        if (done.rowCount) await this.emit(run.taskId,'intent_done',{intentId});
      } else {
        if(routedFailure?.routerHandled){await this.pool.query("UPDATE exploration_nodes SET state='blocked',blocked_reason=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND state='running'",[intentId,routedFailure.chainExhausted?'llm_quota_exhausted':null]);await this.emit(run.taskId,'intent_blocked',{intentId,reason:routedFailure.chainExhausted?'llm_quota_exhausted':'model_router_error'});return;}
        const result = await retryIntent(this.pool,intentId,3);
        if(result!=='unchanged')await this.emit(run.taskId,result==='requeued'?'intent_retry':'intent_exhausted',{intentId});
      }
    }
  }
  private async runModeling(run:RunContext,task:TaskSnapshot):Promise<void>{
    while(!run.abort.signal.aborted){
      if(run.paused){await this.wait(run,100);continue;}
      const generation=run.generation;
      let h:HostedSession|undefined;
      try{
        if(!await this.admitted(run,generation))return;
        const record=await this.modeling.get(run.taskId);
        const competing=(await this.pool.query(`SELECT 1 FROM business_model_runs r JOIN tasks t ON t.id=r.task_id
          WHERE r.system_id=$1 AND r.task_id<>$2 AND r.execution_key=$3 AND t.status IN ('created','running','paused') AND t.deleted_at IS NULL LIMIT 1`,[record.system_id,run.taskId,record.execution_key])).rowCount;
        if(competing)throw new Error("This system already has another modeling task, please use the existing task or initiate a new incremental modeling");
        const agent=await this.deps.agents.get('modeler');
        if(!agent||agent.enabled===false)throw new Error("Business Modeling Agent is disabled");
        const spec=await this.deps.agents.resolveSessionSpec('modeler');
        const ctx:ToolContext={businessKind:'worker',businessId:`task-${run.taskId}-modeling`,agentKey:'modeler',taskId:run.taskId,signal:run.execution.signal,canExecute:()=>this.admitted(run,generation)};
        const gates={...await this.gateOptions(),enforceInterceptScope:true};
        const tools=await this.augmentedTools([...MODELER_TOOLS,'api_model_read','http_request'],ctx,gates);
        if(!tools.some(t=>t.name==='http_request'))throw new Error("The HTTP request tool for business modeling is disabled and cannot check the target entry");
        const entrance=await (this.deps.modelingProbe?this.deps.modelingProbe(record.target,run.execution.signal):probeModelingEntrance(record.target,async()=>{
          const result=await runTool(this.pool,'http_request',{url:record.target,method:'GET'},ctx,gates);
          // GateResult uses "blocked" for both policy denial and handler errors.
          // Only an audited execution failure is eligible for a transport retry.
          const audit=result.status==='blocked'&&result.toolCallId?(await this.pool.query('SELECT execution_ms FROM tool_calls WHERE id=$1',[result.toolCallId])).rows[0]:undefined;
          return {...result,executionFailed:audit?.execution_ms!==undefined&&audit.execution_ms!==null};
        },run.execution.signal));
        if(!await this.admitted(run,generation))continue;
        await this.emit(run.taskId,'modeling_entrance_checked',{status:entrance.status});
        const constraints=(await this.pool.query('SELECT kind,text FROM task_constraints WHERE task_id=$1 ORDER BY id',[run.taskId])).rows;
        const sourceContext=record.source_task_id&&task.network_mode==='jump'?"\nThe source task data is restricted by the springboard workspace isolation. Do not try to read other task directories. This time only the host entry response, available tools, and evidence within this modeling working directory will be used.":record.source_task_id?`
Source data directory (read-only reference):${taskWorkDir(this.config,Number(record.source_task_id),Number(record.source_intent_id)||0)}. The existing JS, packet capture and analysis products can be read and written to the current modeling working directory. Only this specified goal is modeled; the original mission statement is used to limit the scope.`:'';
        await this.pool.query('UPDATE business_model_runs SET finish_requested=FALSE WHERE task_id=$1',[run.taskId]);
        h=await createHostedSession(this.pool,this.config,{kind:'worker',businessId:ctx.businessId,cwd:taskWorkDir(this.config,run.taskId),systemPrompt:spec.systemPrompt+MODELING_EXECUTION_GUIDANCE+artifactSpec(taskWorkDir(this.config,run.taskId))+sourceContext+"\nOperational constraints:"+JSON.stringify(constraints),...await this.profile(task,spec),customTools:tools,freshContext:true,activity:{taskId:run.taskId,worker:'modeler'}});
        run.sessions.add(h);
        const executionSignal=run.execution.signal;
        const cancel=()=>{void h?.session.abort();};executionSignal.addEventListener('abort',cancel,{once:true});
        try{
          if(!await this.admitted(run,generation))continue;
          await h.session.prompt(`Perform business modeling tasks. Goal:${record.target}
Host has checked entry, HTTP ${entrance.status};Reuse the following responses without having to check connectivity repeatedly:
${entrance.body}
System id:${record.system_id}, environment:${record.environment}, identity tag:${record.auth_context||"Not specified"}. These labels do not contain login credentials.
Description:${task.goal}\n${task.description??''}
There is already a draft interface directory:${JSON.stringify(record.endpoints.slice(0,300))}
Existing entity:${JSON.stringify(record.entities).slice(0,12000)}
Historical baseline version:${record.base_version_id??"None"}. Press api_model_read(system_id, path) to read the historical interface that needs to be verified.
Verify the existing results first, and then api_model_submit in batches. The response must contain responses; deltas are merged by path and HTTP method. Differentiate between real validation, static inference, and mock observation based on evidence from actual responses, pages, JS, or working directories; content that fails to validate must be flagged.
Call api_model_done when completed to clarify coverage and gaps. When credentials are missing, explain the gap and don't make up the results.`);
          await h.flushEvents();
        }finally{executionSignal.removeEventListener('abort',cancel);}
        if(!await this.admitted(run,generation))continue;
        const staged=await this.modeling.get(run.taskId);
        if(h.budgetExit&&!staged.finish_requested){
          const timed=h.budgetExit.reason==='timeout';
          await this.modeling.fail(run.taskId,timed?'timeout':'failed',timed?"Business modeling has reached the upper limit of execution or closing time; the draft has been submitted for retention and the main test continues":"Business modeling has reached the upper limit of rounds; the draft has been submitted for retention and the main test continues");
          await this.emit(run.taskId,timed?'modeling_timeout':'modeling_failed',{reason:h.budgetExit.reason,draft_preserved:true});return;
        }
        if(h.modelFailure)throw new Error(h.modelFailure);
        await this.modeling.publish(run.taskId);
        await this.emit(run.taskId,'task_done',{kind:'modeling'});
        return;
      }catch(e){
        if(await this.admitted(run,generation)){
          await this.modeling.fail(run.taskId,'failed',String(e).slice(0,500));
          await this.emit(run.taskId,'modeling_failed',{error:String(e),draft_preserved:true});
          return;
        }
      }finally{if(h){await h.dispose();run.sessions.delete(h);this.releaseIdleSlot(run);}}
    }
  }
  private async emit(taskId: number, event: string, payload: Record<string,unknown>): Promise<void> {
    const {appendEvent} = await import('../../events/ledger.ts');
    await appendEvent(this.pool,this.config.dataDir+'/events-dlq.jsonl',{business_kind:'task',business_id:String(taskId),event_type:event,payload});
  }
}
