/** Persistent Agent trigger queue.
 * Only committed task graph/activity sources generate events; triggered chat
 * activity is excluded, so a trigger cannot recursively fire on its own tools. */
import type {Pool} from 'pg';
import {appendEvent} from '../../events/ledger.ts';

const DEFAULT_DEBOUNCE_MS=3000;
export function plannerInterval(seconds:number):number{return Math.max(600,seconds)*1000;}
export class NotifyDebouncer {
 private pending=0;
 notify():void{this.pending++;}
 async settle(ms=DEFAULT_DEBOUNCE_MS):Promise<boolean>{if(!this.pending)return false;await new Promise(r=>setTimeout(r,ms));const fired=this.pending>0;this.pending=0;return fired;}
}
export {DEFAULT_DEBOUNCE_MS};

export interface TriggerRun {agentKey:string;title:string;message:string;taskId:number;taskIds?:number[];mergeable:boolean;taskDesc:string;taskGoal:string}
type Trigger=Record<string,any>;
type TaskEvent={node_id:string;task_id:string;description:string;goal:string;payload?:any;tool?:string;tool_input?:string;tool_output?:string;is_error?:boolean};
export function truncateRunes(text:string,max:number):string{const chars=Array.from(text);return chars.length<=max?text:chars.slice(0,max).join('')+"…(truncated, total "+chars.length+" words)";}
export function taskContextHeader(run:TriggerRun):string {
 if(!run.taskDesc&&!run.taskGoal)return '';
 return "[Task #"+run.taskId+' '+truncateRunes(run.taskDesc,200)+(run.taskGoal?"(Target:"+truncateRunes(run.taskGoal,500)+'）':'')+'】';
}
export function finalTriggerMessage(run:TriggerRun):string{const header=taskContextHeader(run);return header?header+'\n'+run.message:run.message;}
export function mergeTriggeredRuns(items:TriggerRun[],all=false):TriggerRun {
 if(items.length===1)return items[0]!;
 const first=items[0]!,order:number[]=[],groups=new Map<number,TriggerRun[]>();
 for(const run of items){if(!groups.has(run.taskId)){order.push(run.taskId);groups.set(run.taskId,[]);}groups.get(run.taskId)!.push(run);}
 let message=all?"[This session merges the queued "+items.length+" trigger events (total "+order.length+" tasks), please process them together]\n":"[This session merged tasks #"+first.taskId+" of "+items.length+" trigger events, please handle them together]\n";
 let seq=0;
 for(const id of order){const group=groups.get(id)!,header=taskContextHeader(group[0]!);if(header)message+=(all?'\n':'')+header+'\n';for(const item of group){seq++;message+="\n──Trigger "+seq+(all?'（task#'+id+'）':' ')+'──\n'+item.message+'\n';}}
 return {...first,taskIds:[...new Set(items.flatMap(r=>r.taskIds??[r.taskId]))],title:"Merge trigger · "+(all?"All":'task#'+first.taskId)+' · '+items.length+" Article",message,taskDesc:'',taskGoal:'',mergeable:true};
}
export function formatTriggerTime(now:Date):string {
 const pad=(n:number)=>String(n).padStart(2,'0');
 const formatter=new Intl.DateTimeFormat('en-US',{timeZoneName:'short'});
 let zone=formatter.formatToParts(now).find(p=>p.type==='timeZoneName')?.value??'UTC';
 const timezone=formatter.resolvedOptions().timeZone;
 if(zone==='GMT')zone='UTC';
 if(timezone==='Asia/Shanghai'&&zone==='GMT+8')zone='CST';
 return now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+' '+pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds())+' '+zone;
}
const eventSources=[
 {key:'last_finding_id',flag:'on_finding',message:'finding_message',query:"SELECT n.id AS node_id,t.id AS task_id,t.description,t.goal,n.payload FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE n.kind='finding' AND n.id>$1 AND t.deleted_at IS NULL ORDER BY n.id"},
 {key:'fired_goals',flag:'on_goal_met',message:'goal_message',query:"SELECT n.id AS node_id,t.id AS task_id,t.description,t.goal,n.payload FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE n.kind='goal' AND n.state='met' AND t.deleted_at IS NULL ORDER BY n.id"},
 {key:'last_timeout_id',flag:'on_task_timeout',message:'task_timeout_message',query:"SELECT id AS node_id,id AS task_id,description,goal FROM tasks WHERE status='timeout' AND deleted_at IS NULL AND id>$1 ORDER BY id"},
 {key:'last_toolcall_id',flag:'on_tool_call',message:'tool_call_message',query:"SELECT r.id AS node_id,t.id AS task_id,t.description,t.goal,r.tool,COALESCE(u.detail,'') AS tool_input,COALESCE(r.detail,'') AS tool_output,r.is_error FROM activity r JOIN tasks t ON t.exploration_id=r.exploration_id LEFT JOIN activity u ON u.exploration_id=r.exploration_id AND u.tool_use_id=r.tool_use_id AND u.kind='tool_use' WHERE r.kind='tool_result' AND r.id>$1 AND r.tool<>'' AND t.deleted_at IS NULL ORDER BY r.id"},
 {key:'last_taskcreate_id',flag:'on_task_create',message:'task_create_message',query:"SELECT id AS node_id,id AS task_id,description,goal FROM tasks WHERE deleted_at IS NULL AND id>$1 ORDER BY id"},
] as const;

export class TriggerScheduler {
 private timer:NodeJS.Timeout|null=null;
 private inFlight:Promise<void>|null=null;
 private started=false;
 private initialized=false;
 private abort=new AbortController();
 private readonly queue=new Map<string,TriggerRun[]>();
 private readonly activeTasks=new Map<Promise<void>,number[]>();
 hasTask(id:number):boolean{return [...this.queue.values()].some(q=>q.some(r=>(r.taskIds??[r.taskId]).includes(id)))||[...this.activeTasks.values()].some(ids=>ids.includes(id));}
 private readonly active=new Map<string,Set<Promise<void>>>();
 private readonly behavior=new Map<string,{runMode:string;mergeMode:string;maxParallel:number}>();
 constructor(private readonly pool:Pool,private readonly dlqPath:string,private readonly fire:(agentKey:string,message:string,run?:TriggerRun,signal?:AbortSignal)=>Promise<void>,private readonly intervalMs=5000,private readonly fixedFindingReports=false){}
 start():void {
  if(this.timer)return;this.started=true;if(this.abort.signal.aborted)this.abort=new AbortController();
  this.inFlight=this.initialize().catch(e=>console.error('[scheduler] initialize failed',e)).finally(()=>{this.inFlight=null;});
  this.timer=setInterval(()=>{if(this.inFlight)return;this.inFlight=this.step().catch(e=>console.error('[scheduler] step failed',e)).finally(()=>{this.inFlight=null;});},this.intervalMs);this.timer.unref();
 }
 async stop():Promise<void>{this.started=false;this.abort.abort();if(this.timer)clearInterval(this.timer);this.timer=null;await this.inFlight;await Promise.allSettled([...this.active.values()].flatMap(s=>[...s]));this.queue.clear();}
 async initialize():Promise<void>{
  if(this.initialized)return;
  for(const source of eventSources){
   const existing=(await this.pool.query('SELECT value FROM scheduler_watermarks WHERE key=$1',[source.key])).rows[0];if(existing)continue;
   const rows=(await this.pool.query(source.query,source.key==='fired_goals'?[]:[0])).rows as TaskEvent[];
   const value=source.key==='fired_goals'?JSON.stringify(rows.map(r=>r.node_id)):rows.at(-1)?.node_id??'0';
   await this.pool.query('INSERT INTO scheduler_watermarks(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[source.key,value]);
  }this.initialized=true;
 }
 /** Public deterministic step for isolated source comparison; start owns timer. */
 async step():Promise<void>{
  await this.initialize();
  const triggers=(await this.pool.query('SELECT * FROM agent_triggers WHERE enabled ORDER BY id')).rows as Trigger[];
  // Original step leaves watermarks unchanged when there are no enabled triggers.
  if(!triggers.length)return;
  for(const trigger of triggers){
   if(trigger.interval_sec<=0||trigger.last_fire&&Date.now()-new Date(trigger.last_fire).getTime()<trigger.interval_sec*1000)continue;
   const claimed=await this.pool.query('UPDATE agent_triggers SET last_fire=now() WHERE id=$1 AND (last_fire IS NULL OR last_fire<=now()-make_interval(secs=>interval_sec)) RETURNING id',[trigger.id]);if(!claimed.rowCount)continue;
   const now=new Date(),time=now.toTimeString().slice(0,5);
   await this.enqueue(trigger,{agentKey:trigger.agent_key,title:"Timing trigger · "+time,message:trigger.interval_message+"\n\n[This is a timed trigger] "+formatTriggerTime(now),taskId:0,mergeable:false,taskDesc:'',taskGoal:''});
   // Legacy interval read model retained for compatibility; not the event cursor.
   await this.pool.query('INSERT INTO scheduler_state(agent_key,last_fired_at,next_fire_at) VALUES($1,now(),now()+make_interval(secs=>$2::int)) ON CONFLICT(agent_key) DO UPDATE SET last_fired_at=now(),next_fire_at=EXCLUDED.next_fire_at',[trigger.agent_key,trigger.interval_sec]);
  }
  for(const source of eventSources){
   const saved=(await this.pool.query('SELECT value FROM scheduler_watermarks WHERE key=$1',[source.key])).rows[0]?.value??'0';
   const goalSet=new Set<string>(source.key==='fired_goals'?JSON.parse(saved):[]);
   const rows=(await this.pool.query(source.query,source.key==='fired_goals'?[]:[saved])).rows as TaskEvent[];
   let max=BigInt(source.key==='fired_goals'?0:saved),changed=false;
   for(const event of rows){
    if(source.key==='fired_goals'){if(goalSet.has(String(event.node_id)))continue;goalSet.add(String(event.node_id));changed=true;}
    else if(BigInt(event.node_id)>max){max=BigInt(event.node_id);changed=true;}
    for(const trigger of triggers){
     if(!trigger[source.flag])continue;
     if(this.fixedFindingReports&&trigger.agent_key==='reporter'&&(source.flag==='on_finding'||source.flag==='on_tool_call'&&event.tool==='report_finding'))continue;
     if(source.flag==='on_tool_call'){
      if(event.is_error&&event.tool==='report_finding')continue;
      let names:string[]=[];try{names=JSON.parse(trigger.tool_names||'[]');}catch{}
      if(!names.some(name=>name.toLowerCase()===event.tool?.toLowerCase()))continue;
     }
     const taskId=Number(event.task_id),payload=event.payload??{};let title='',extra='';
     switch(source.flag){
      case 'on_finding':title="finding trigger · task#"+taskId;extra="\n\n[This time is triggered by the task finding]\nFound: ["+(payload.vulnclass??'')+'/'+(payload.severity??'')+'] '+(payload.summary??'');break;
      case 'on_goal_met':title="Target trigger · task#"+taskId;extra="\n\n[This time is triggered by the task completion goal]\nAchieve goal: "+(payload.text||payload.summary||'');break;
      case 'on_task_timeout':title="Timeout trigger · task#"+taskId;extra="\n\n[This time triggered by task timeout]";break;
      case 'on_task_create':title="Task creation trigger · task#"+taskId;extra="\n\n[This time triggered by task creation]";break;
      case 'on_tool_call':title="Tool trigger · "+event.tool+' · task#'+taskId;extra="\n\n[This time triggered by tool call]\nTools: "+event.tool+"\nInput parameters: "+truncateRunes(event.tool_input??'',1500)+"\nReturn: "+(event.is_error?'[error] ':'')+truncateRunes(event.tool_output??'',1500);break;
     }
     await this.enqueue(trigger,{agentKey:trigger.agent_key,title,message:(trigger[source.message]??'')+extra,taskId,mergeable:true,taskDesc:event.description,taskGoal:event.goal});
    }
   }
   if(changed)await this.pool.query('UPDATE scheduler_watermarks SET value=$2 WHERE key=$1',[source.key,source.key==='fired_goals'?JSON.stringify([...goalSet]):String(max)]);
  }
 }
 private async enqueue(trigger:Trigger,run:TriggerRun):Promise<void>{
  const agent=(await this.pool.query('SELECT trigger_run_mode,trigger_merge_mode,trigger_max_parallel FROM agents WHERE key=$1',[run.agentKey])).rows[0];
  this.behavior.set(run.agentKey,{runMode:agent?.trigger_run_mode==='parallel'?'parallel':'serial',mergeMode:['by_task','none'].includes(agent?.trigger_merge_mode)?agent.trigger_merge_mode:'all',maxParallel:agent?.trigger_max_parallel??5});
  if(!this.queue.has(run.agentKey))this.queue.set(run.agentKey,[]);this.queue.get(run.agentKey)!.push(run);
  await appendEvent(this.pool,this.dlqPath,{business_kind:'scheduler',business_id:run.agentKey,event_type:'trigger_fired',payload:{trigger_id:Number(trigger.id),title:run.title,task_id:run.taskId}});
  this.pump(run.agentKey);
 }
 private pump(key:string):void{
  if(!this.started)return;
  const config=this.behavior.get(key)!,items=this.queue.get(key)??[],active=this.active.get(key)??new Set<Promise<void>>();this.active.set(key,active);
  const limit=config.runMode==='parallel'?(config.maxParallel<=0?Infinity:config.maxParallel):1;
  while(items.length&&active.size<limit){
   const head=items.shift()!;let run=head;
   if(config.runMode==='serial'&&config.mergeMode==='all')run=mergeTriggeredRuns([head,...items.splice(0)],true);
   else if(config.runMode==='serial'&&config.mergeMode==='by_task'&&head.mergeable&&head.taskId){const group=[head];for(let i=0;i<items.length;)if(items[i]!.mergeable&&items[i]!.taskId===head.taskId)group.push(...items.splice(i,1));else i++;run=mergeTriggeredRuns(group);}
   const operation=Promise.resolve().then(()=>this.fire(key,finalTriggerMessage(run),run,this.abort.signal)).catch(e=>console.error('[scheduler] triggered run failed',key,e)).finally(()=>{active.delete(operation);this.activeTasks.delete(operation);this.pump(key);});active.add(operation);this.activeTasks.set(operation,run.taskIds??[run.taskId]);
  }
 }
}
