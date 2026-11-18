"use client";
import * as React from "react";
import {SmartphoneIcon,BinaryIcon,RefreshCwIcon,FileCodeIcon,WorkflowIcon,CodeXmlIcon} from "lucide-react";
import {toast} from "sonner";
import {http} from "@/lib/api";
import {SettingsRow,SettingsSection} from "@/components/settings-layout";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {Badge} from "@/components/ui/badge";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
type Settings={index_enabled:boolean;audit_enabled:boolean;service_url:string;service_token_set:boolean;native_concurrency:number};
type Capability={settings:Settings;components:{key:string;name:string;state:string;detail:string}[];resources:{active:number;queued:number;limit:number}};
const labels:Record<string,string>={available:"Available",installed:"Installed",unconnected:"Pending connection",missing:"Missing component",unconfigured:"Not configured",unreachable:"Unreachable",saved:"Saved",pending:"To be indexed",indexed:"Indexed",failed:"Failure",skipped:"Not audited",running:"Analyzing",done:"Completed",timeout:"Timeout",stopped:"Stopped",cancel_pending:"Canceling",claimed:"Preparing",stopping:"Stopping"};
export function ReverseAnalysisSettings(){
 const [data,setData]=React.useState<Capability|null>(null),[draft,setDraft]=React.useState<Settings|null>(null),[token,setToken]=React.useState(""),[busy,setBusy]=React.useState(false),[error,setError]=React.useState("");
 const load=React.useCallback(async(force=false)=>{try{const value=await http<Capability>("/reverse/capabilities"+(force?"?refresh=1":""));setData(value);setDraft(value.settings);setError("");}catch(e){setError((e as Error).message);}},[]);
 React.useEffect(()=>{void load();},[load]);
 async function save(){if(!draft)return;setBusy(true);try{const value=await http<Capability>("/reverse/capabilities",{method:"PUT",body:JSON.stringify({...draft,service_token_set:undefined,...(token?{service_token:token}:{})})});setData(value);setDraft(value.settings);setToken("");toast.success("Analysis configuration saved");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 return <SettingsSection title="Analysis Configuration">
  <div className="flex items-center justify-between pb-3"><span className="text-xs text-muted-foreground">{error||"Called by Worker according to task needs."}</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void load(true)}><RefreshCwIcon className="size-4"/>Detection</Button></div>
  {data?.components.map(item=>{const Icon=({rea:CodeXmlIcon,native:BinaryIcon,android:SmartphoneIcon,protocol:WorkflowIcon,whitebox:FileCodeIcon} as Record<string,typeof BinaryIcon>)[item.key]??BinaryIcon;return <div key={item.key} className="flex flex-wrap items-center justify-between gap-2 border-t py-3"><div className="flex items-center gap-2 text-sm"><Icon className="size-4 text-muted-foreground"/>{item.name}<span className="text-xs text-muted-foreground">{item.detail}</span></div><Badge variant={item.state==="available"?"secondary":"outline"}>{labels[item.state]??item.state}</Badge></div>;})}
  {draft&&<>
   <SettingsRow title="Reverse concurrency" ><Select value={String(draft.native_concurrency)} onValueChange={value=>setDraft({...draft,native_concurrency:Number(value)})}><SelectTrigger aria-label="Reverse analysis of concurrency" className="w-24"><SelectValue/></SelectTrigger><SelectContent>{[1,2,3].map(n=><SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent></Select></SettingsRow>
   <SettingsRow title="Code Analysis Service" ><Input aria-label="Code analysis service address" value={draft.service_url} onChange={e=>setDraft({...draft,service_url:e.target.value})} placeholder="http://service address:port" className="w-72"/></SettingsRow>
   <SettingsRow title="Service Token"><Input aria-label="Code Analysis Service Token" type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={draft.service_token_set?"Configured, leave blank to retain":"Optional"} className="w-72"/></SettingsRow>
   <SettingsRow title="Automatic indexing" ><Switch aria-label="Automatically create code index" checked={draft.index_enabled} onCheckedChange={value=>setDraft({...draft,index_enabled:value,...(!value?{audit_enabled:false}:{})})}/></SettingsRow>
   <SettingsRow title="Automatic static audit" ><Switch aria-label="Automatic static audit" disabled={!draft.index_enabled} checked={draft.audit_enabled} onCheckedChange={value=>setDraft({...draft,audit_enabled:value})}/></SettingsRow>
   <div className="flex items-center justify-between pt-3"><span className="text-xs text-muted-foreground">{data?.resources.active??0}  analysis sessions · {data?.resources.queued??0}  queued</span><Button size="sm" disabled={busy} onClick={()=>void save()}>Save analysis configuration</Button></div>
  </>}
 </SettingsSection>;
}
type Summary={sources:{id:string;name:string;kind:string;size:number;state:string}[];analyses:{id:string;name:string;state:string;findings:number}[];clues:number};
export function TaskCodeAnalysis({taskId}:{taskId:string|number}){
 const [data,setData]=React.useState<Summary|null>(null);
 React.useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const r=await http<Summary>("/tasks/"+taskId+"/code-analysis");if(live)setData(r);}catch{}finally{if(live)timer=setTimeout(tick,5000);}};void tick();return()=>{live=false;clearTimeout(timer);};},[taskId]);
 if(!data||!data.sources.length&&!data.analyses.length)return null;
 return <section aria-label="Task code analysis" className="rounded-xl border bg-card/40 px-4 py-3"><div className="flex items-center gap-2 text-sm font-medium"><FileCodeIcon className="size-4"/>Artifact and Code Analysis<span className="text-xs font-normal text-muted-foreground">{data.clues}  clues to be verified</span></div><div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">{data.sources.slice(0,6).map(item=><div key={item.id} className="flex min-w-0 items-center gap-2 text-xs"><span className="max-w-56 truncate" title={item.name}>{item.name}</span><Badge variant="outline">{labels[item.state]??item.state}</Badge></div>)}{data.analyses.slice(0,6).map(item=><div key={item.id} className="flex items-center gap-2 text-xs"><span className="max-w-56 truncate">{item.name}</span><Badge variant="secondary">{labels[item.state]??item.state}</Badge></div>)}</div></section>;
}
