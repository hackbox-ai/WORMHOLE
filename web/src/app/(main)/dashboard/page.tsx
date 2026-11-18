"use client";
import * as React from "react";
import Link from "next/link";
import {Activity,ArrowUpRight,Bug,Check,ChevronRight,Clock,Layers,Network,Plus,ShieldCheck,Target,Zap} from "lucide-react";
import {WorkspaceHeader} from "@/components/workspace-header";
import {Button} from "@/components/ui/button";
import {StatusBadge} from "@/components/status-badge";
import {api} from "@/lib/api";
import {TokenPanel,formatTokens} from "@/components/dashboard/token-panel";
import type {Task,Finding,FindingStats,Stats,Settings,Activity as EventItem,DashboardUsage,MeterFilters,InterceptPending,LLMProfile,Agent,MCPServer,SkillItem,Tool,TrafficExchange} from "@/lib/types";
import "./dashboard.css";

const initial={
 tasksReady:false,assetsReady:false,tasks:[] as Task[],findings:[] as Finding[],findingStats:null as FindingStats|null,stats:null as Stats|null,settings:null as Settings|null,
 events:[] as EventItem[],assets:{} as Record<string,number>,pending:[] as InterceptPending[],profiles:[] as LLMProfile[],
 agents:[] as Agent[],mcps:[] as MCPServer[],skills:[] as SkillItem[],tools:[] as Tool[],traffic:[] as TrafficExchange[],trafficTotal:0,
};
const rel=(value?:string|number)=>{
 if(!value)return "No activity yet";
 const t=typeof value==="number"?value*1000:Date.parse(value);if(!Number.isFinite(t))return "—";
 const seconds=Math.max(0,Math.floor((Date.now()-t)/1000));
 return seconds<60?"Just now":seconds<3600?Math.floor(seconds/60)+"minutes ago":seconds<86400?Math.floor(seconds/3600)+"hours ago":Math.floor(seconds/86400)+"days ago";
};
const taskLabel=(t:Task)=>t.name||t.description||"Task #"+t.id;
const activityNames:Record<string,string>={tool_use:"Call tool",tool_result:"Execution results",text:"Agent reply",thinking:"Analyzing",result:"Complete a round",error:"Execution exception",user:"User handover"};
const assetNames:Record<string,string>={root_domain:"Root domain name",subdomain:"Subdomain name",ip:"IP address",service:"Service",endpoint:"Interface",app:"Application"};
function PanelHead({icon:Icon,title,sub,href}:{icon:React.ElementType;title:string;sub?:string;href?:string}){
 return <div className="dash-panel-head"><div><h2><Icon/>{title}</h2>{sub&&<p>{sub}</p>}</div>{href&&<Link className="dash-more" href={href}>View all<ArrowUpRight/></Link>}</div>;
}
function Kpi({title,value,children,icon:Icon,href,tone}:{title:string;value:React.ReactNode;children:React.ReactNode;icon:React.ElementType;href:string;tone:string}){
 return <Link href={href} className="dash-kpi" data-tone={tone}><div className="dash-kpi-label"><span>{title}</span><Icon/></div><strong>{value}</strong><div className="dash-kpi-detail">{children}</div><ArrowUpRight className="dash-kpi-arrow"/></Link>;
}
export default function DashboardPage(){
 const [data,setData]=React.useState(initial),[partial,setPartial]=React.useState(false),[updated,setUpdated]=React.useState<Date>();
 const [days,setDays]=React.useState(30),[filters,setFilters]=React.useState<MeterFilters>({profile:"all",source:"all",task:""});
 const [usage,setUsage]=React.useState<DashboardUsage|null>(null),[usageLoading,setUsageLoading]=React.useState(true),[usageError,setUsageError]=React.useState(""),[retry,setRetry]=React.useState(0);
 React.useEffect(()=>{
  let alive=true;
  const pending=new Set<string>(),failed=new Set<string>();
  const jobs:[string,()=>Promise<Partial<typeof initial>>][]=[
   ["tasks",async()=>({tasks:(await api.tasks()).tasks.filter(t=>t.kind!=="modeling"),tasksReady:true})],
   ["findings",async()=>({findings:(await api.findingsPage({page:1,pageSize:6,sort:"severity"})).items})],
   ["findingStats",async()=>({findingStats:await api.findingStats()})],["stats",async()=>({stats:await api.stats()})],
   ["settings",async()=>({settings:await api.settings()})],["events",async()=>({events:(await api.activity(undefined,{limit:30})).items})],
   ["assets",async()=>({assets:await api.assetCounts(),assetsReady:true})],["pending",async()=>({pending:await api.interceptPending()})],
   ["profiles",async()=>({profiles:await api.llmProfiles()})],["agents",async()=>({agents:await api.agents()})],
   ["mcps",async()=>({mcps:await api.mcpServers()})],["skills",async()=>({skills:await api.skills()})],["tools",async()=>({tools:await api.tools()})],
   ["traffic",async()=>{const t=await api.traffic(0,3);return {traffic:t.exchanges??[],trafficTotal:t.count??t.total??0};}],
  ];
  const tick=()=>{for(const [key,read]of jobs){
   if(pending.has(key))continue;pending.add(key);
   void read().then(patch=>{if(alive){setData(previous=>({...previous,...patch}));failed.delete(key);setPartial(failed.size>0);setUpdated(new Date());}})
    .catch(()=>{if(alive){failed.add(key);setPartial(true);}}).finally(()=>pending.delete(key));
  }};
  tick();const timer=setInterval(tick,10000);
  return()=>{alive=false;clearInterval(timer);};
 },[]);
 React.useEffect(()=>{
  const abort=new AbortController();let busy=false;
  setUsage(null);setUsageLoading(true);setUsageError("");
  const load=async()=>{
   if(busy)return;busy=true;
   try{const response=await api.usageStats(days,filters,abort.signal);if(!abort.signal.aborted){setUsage(response);setUsageError("");}}
   catch(e){if(!abort.signal.aborted)setUsageError((e as Error).message);}
   finally{busy=false;if(!abort.signal.aborted)setUsageLoading(false);}
  };
  void load();const timer=setInterval(()=>void load(),10000);
  return()=>{abort.abort();clearInterval(timer);};
 },[days,filters,retry]);
 const retryUsage=React.useCallback(()=>setRetry(n=>n+1),[]);
 const running=data.tasks.filter(t=>t.status==="running"&&!t.paused&&!t.queued);
 const queued=data.tasks.filter(t=>t.queued),paused=data.tasks.filter(t=>t.paused||String(t.status)==="paused");
 const completed=data.tasks.filter(t=>t.status==="done").length;
 const assetTotal=Object.values(data.assets).reduce((s,n)=>s+n,0);
 const recentTasks=[...data.tasks].sort((a,b)=>Number(running.includes(b))-Number(running.includes(a))||(b.last_activity_unix??b.created_unix??0)-(a.last_activity_unix??a.created_unix??0)).slice(0,4);
 const events=data.events.filter(e=>e.kind!=="usage"&&e.kind!=="thinking").sort((a,b)=>b.seq-a.seq).slice(0,6);
 const assets=Object.entries(data.assets).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).slice(0,5);
 const defaultProfile=data.profiles.find(p=>p.is_default);
 const high=(data.findingStats?.critical??0)+(data.findingStats?.high??0);
 const periodLabel=days?("Near "+days+" days"):"All ledgers";
 return <div className="dashboard-v2">
  <WorkspaceHeader title="Dashboard" compact actions={<><span className={"dash-sync "+(partial?"is-stale":"")}><i/>{partial?"Some data needs to be updated":updated?"Updated on "+updated.toLocaleTimeString("en-US",{hour12:false}):"Updating"}</span><Button variant="outline" size="sm" asChild><Link href="/chat">Start Chat</Link></Button><Button size="sm" asChild><Link href="/function/tasks"><Plus className="size-3.5"/>New Task</Link></Button></>}/>
  <div className="dash-intro"><div><span className="dash-eyebrow">Security Overview</span><h2>{!data.tasksReady?"Reading task status":running.length?"Advancing "+running.length+" test tasks":"There are currently no tasks running"}</h2></div><div className="dash-intro-meta"><Clock/><span>{queued.length?queued.length+" tasks are queued":paused.length?paused.length+" tasks paused":"There are currently no queued tasks"}</span></div></div>
  <div className="dash-kpis" aria-label="Work Overview Indicators">
   <Kpi title="Running tasks" value={data.tasksReady?running.length:"—"} icon={Target} tone="blue" href="/function/tasks"><span>Cumulative {data.tasks.length}  tasks</span><span>Completed {completed}</span></Kpi>
   <Kpi title="Findings" value={data.findingStats?.total??"—"} icon={Bug} tone="rose" href="/function/findings"><span className={high?"dash-risk-text":""}>Critical / High {high}</span><span>Pending {data.findingStats?.pending??0}</span></Kpi>
   <Kpi title="Registered assets" value={data.assetsReady?assetTotal.toLocaleString("en-US"):"—"} icon={Network} tone="teal" href="/function/assets"><span>{Object.values(data.assets).filter(n=>n>0).length}  asset types</span><span>Domain names, services and interfaces</span></Kpi>
   <Kpi title="Token usage" value={usage?formatTokens(usage.summary.total_tokens):"—"} icon={Zap} tone="violet" href="/function/llm-records"><span>{periodLabel}</span><span>{usage?usage.summary.calls.toLocaleString("en-US")+" calls":"Read the call ledger"}</span></Kpi>
  </div>
  {data.pending.length>0&&<Link href="/system/intercept/approvals" className="dash-attention"><ShieldCheck/><div><strong>{data.pending.length}  Operations awaiting approval</strong><span>After processing, related checks can continue.</span></div><ChevronRight/></Link>}
  <div className="dash-primary-grid">
   <section className="dash-panel" aria-label="Task Progress"><PanelHead icon={Target} title="Task Progress" sub={running.length?"Running taskss are displayed first":"Recently updated test tasks"} href="/function/tasks"/>
    <div className="dash-task-list">{recentTasks.length?recentTasks.map(t=>{
     const isPaused=t.paused||String(t.status)==="paused",state=isPaused?"paused":t.queued?"queued":t.status;
     const pct=t.goals_total?Math.min(100,Math.round((t.goals_met??0)/t.goals_total*100)):null;
     return <Link className="dash-task-row" href={"/function/tasks/detail?id="+t.id} key={t.id}>
      <span className={"dash-task-symbol "+(running.includes(t)?"is-running":"")}><Target/></span>
      <div className="dash-task-copy"><div><strong>{taskLabel(t)}</strong><StatusBadge domain="task" value={state} dot/></div>
       <p>{isPaused?"Paused, waiting to resume":t.queued?"Already added to the queue, waiting for execution":t.status==="done"?"Task completed":t.status==="failed"?"Task execution failed, you can view the saved results":t.status==="timeout"?"The task time limit has expired and the result has been completed":t.progress?.message||t.target_input||t.goal||"Waiting for execution"}</p><small>#{t.id} · {rel(t.last_activity_unix??t.created_unix)}</small></div>
      <div className="dash-task-progress">{pct!==null?<><strong>{t.goals_met??0}<span> / {t.goals_total}</span></strong><div><i style={{width:pct+"%"}}/></div><small>Goal Progress</small></>:<small>{(t.in_flight??0)>0?t.in_flight+" checks in progress":"No target progress yet"}</small>}</div><ChevronRight className="dash-row-arrow"/>
     </Link>;
    }):<div className="dash-empty"><Target/><strong>{data.tasksReady?"There are no test tasks yet":"Reading task"}</strong><span>After initiating the task, check the execution progress here.</span><Link href="/function/tasks">Create task<ArrowUpRight/></Link></div>}</div>
   </section>
   <section className="dash-panel" aria-label="Key findings"><PanelHead icon={Bug} title="Key findings" sub="Sort by severity" href="/function/findings"/>
    <div className="dash-finding-list">{data.findings.length?data.findings.slice(0,4).map(f=><Link href={"/function/findings/detail?id="+f.id} className="dash-finding-row" key={f.id}>
     <StatusBadge domain="severity" value={f.severity}/><div><strong>{f.name||f.vulnclass||"Vulnerability details"}</strong><p>{f.summary||f.task_description||"View discovery details and verification evidence"}</p><small>{f.task_id?"Task #"+f.task_id+" · ":""}{rel(f.ts)}</small></div><ChevronRight/></Link>):<div className="dash-empty"><ShieldCheck/><strong>No vulnerabilities found yet</strong><span>Archived findings will be displayed here.</span></div>}</div>
   </section>
  </div>
  <TokenPanel usage={usage} days={days} filters={filters} loading={usageLoading} error={usageError} onDays={setDays} onFilters={setFilters} retry={retryUsage}/>
  <div className="dash-secondary-grid">
   <section className="dash-panel" aria-label="Recent activities"><PanelHead icon={Activity} title="Recent activities" sub="Recent execution and handover records" href="/function/tasks"/>
    <div className="dash-events">{events.length?events.map((e,i)=><div className="dash-event" key={e.seq??i}><span className={"dash-event-dot "+(e.is_error?"is-error":"")}/><div><div><strong>{e.tool||activityNames[e.kind]||e.kind}</strong><time>{rel(e.ts)}</time></div><p>{e.summary||activityNames[e.kind]||"Execution record"}</p><small>{e.worker==="planner"?"Planning Agent":e.worker==="mainagent"?"Main Agent":e.worker}</small></div></div>):<div className="dash-empty"><Activity/><span>After the task is executed, the latest activities will be displayed here.</span></div>}</div>
   </section>
   <section className="dash-panel" aria-label="Assets and operating environment"><PanelHead icon={Layers} title="Assets and operating environment" sub="Registered assets and current configuration"/>
    <div className="dash-environment">
     <div className="dash-assets">{assets.length?assets.map(([key,count])=><Link href="/function/assets" key={key}><div><span>{assetNames[key]??key}</span><strong>{count.toLocaleString("en-US")}</strong></div><div className="dash-asset-bar"><i style={{width:(count/Math.max(assetTotal,1)*100)+"%"}}/></div></Link>):<p className="dash-muted">No asset data yet</p>}</div>
     <div className="dash-runtime">
      <Link href="/system/llm"><span>Model Service</span><strong>{data.stats?(data.stats.llm_configured?<><Check/>Configured</>:"Not configured"):"Reading"}</strong></Link>
      <Link href="/system/settings"><span>Traffic Capture</span><strong>{data.settings?(data.settings.traffic_capture?"Enabled":"Closed"):"Reading"}</strong></Link>
      <Link href="/system/llm"><span>Default model</span><strong title={defaultProfile?.model}>{defaultProfile?.name||"Not set"}</strong></Link>
      <Link href="/function/traffic"><span>Request collected</span><strong>{data.trafficTotal.toLocaleString("en-US")}<ArrowUpRight/></strong></Link>
     </div>
    </div>
    <div className="dash-capabilities">{[
     {name:"Agent",count:data.agents.length,path:"agents"},{name:"MCP",count:data.mcps.length,path:"mcp"},
     {name:"Skill",count:data.skills.length,path:"skills"},{name:"Tool",count:data.tools.filter(t=>t.enabled).length,path:"tools"},
    ].map(c=><Link key={c.name} href={"/system/"+c.path}>{c.name}<strong>{c.count}</strong><ArrowUpRight/></Link>)}</div>
   </section>
  </div>
 </div>;
}
