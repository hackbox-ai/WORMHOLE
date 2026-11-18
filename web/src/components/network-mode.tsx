"use client";
import { HelpButton } from "@/components/user-guide";
import * as React from "react";
import {CableIcon,DownloadIcon,PlusIcon,RefreshCwIcon,PencilIcon} from "lucide-react";
import {toast} from "sonner";
import {api,http} from "@/lib/api";
import type {Task} from "@/lib/types";
import {SettingsRow,SettingsSection} from "@/components/settings-layout";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {Dialog,DialogContent,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {Switch} from "@/components/ui/switch";
export interface NetworkChannel{id:string;name:string;server_host:string;control_port:number;entry_port:number;version:number;scopes:string[];enabled:boolean;status:"online"|"offline"|"disabled";active_tasks:number;dependent_tasks?:number;probe_url?:string;suggested_probe_url?:string;historical?:boolean;current_version?:number;last_checked_at:string;parent_channel_id?:string|null;relay_listen:string;full_network:boolean;full_network_ready?:boolean;chain?:{id:string;name:string}[]}
export interface NetworkChoice{network_mode?:"standard"|"jump";network_channel_id?:number|null}
const labels={online:"Online",offline:"Offline",disabled:"Disabled"};
function useChannels(){
 const [channels,setChannels]=React.useState<NetworkChannel[]>([]),[error,setError]=React.useState("");
 const reload=React.useCallback(async()=>{try{const r=await http<{channels:NetworkChannel[]}>("/network/channels");setChannels(r.channels);setError("");}catch(e){setError((e as Error).message);}},[]);
 React.useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{if(!live)return;await reload();if(live)timer=setTimeout(tick,5000);};void tick();return()=>{live=false;clearTimeout(timer);};},[reload]);
 return {channels,error,reload};
}
export function NetworkModePicker({value,onChange}:{value:NetworkChoice;onChange:(v:NetworkChoice)=>void}){
 const {channels,error}=useChannels();const [configError,setConfigError]=React.useState("");const change=React.useRef(onChange);change.current=onChange;
 React.useEffect(()=>{if(value.network_mode)return;let live=true;void api.settings().then(s=>{if(live)change.current({network_mode:s.network_mode??"standard",network_channel_id:s.network_channel_id||null});}).catch(()=>{if(live)setConfigError("Failed to read the default network configuration, please reopen.");});return()=>{live=false;};},[value.network_mode]);
 const mode=value.network_mode??"standard";
 return <div className="space-y-3">
  <Label>Network access{!value.network_mode?" · "+(configError||"Reading default configuration"):""}</Label>
  <Select disabled={!value.network_mode} value={mode} onValueChange={v=>onChange({network_mode:v as "standard"|"jump",network_channel_id:v==="jump"?(value.network_channel_id??Number(channels.find(c=>c.enabled)?.id))||null:null})}>
   <SelectTrigger aria-label="Mission Network Mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="standard">Normal mode</SelectItem><SelectItem value="jump">Springboard proxy mode</SelectItem></SelectContent>
  </Select>
  {mode==="jump"&&<><Select value={value.network_channel_id?String(value.network_channel_id):""} onValueChange={v=>onChange({...value,network_channel_id:Number(v)})}>
   <SelectTrigger aria-label="Task springboard channel"><SelectValue placeholder="Select springboard channel"/></SelectTrigger><SelectContent>{channels.filter(c=>c.enabled).map(c=><SelectItem key={c.id} value={c.id}>{c.name} · {labels[c.status]}</SelectItem>)}</SelectContent>
  </Select><p className="text-xs text-muted-foreground">{error||"The target access of this task is through the selected channel, and the direct connection will not fall back when offline."}</p></>}
 </div>;
}
export function TaskNetworkBadge({task}:{task:Task}){
 if(task.network_mode!=="jump")return null;
 return <Badge variant="secondary" className="max-w-40 shrink-0 gap-1 text-[10px]" title={task.network_channel_name??"Springboard proxy mode"}><CableIcon className="size-3"/><span className="truncate">Springboard · {task.network_channel_name||"#"+task.network_channel_id}</span></Badge>;
}
export function TaskNetworkStatus({task}:{task:Task}){
 const [channel,setChannel]=React.useState<NetworkChannel|null>(null),[error,setError]=React.useState("");
 React.useEffect(()=>{if(task.network_mode!=="jump")return;let live=true;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const r=await http<{channel:NetworkChannel|null}>(`/tasks/${task.id}/network`);if(live){setChannel(r.channel);setError("");}}catch(e){if(live)setError((e as Error).message);}finally{if(live)timer=setTimeout(tick,5000);}};void tick();return()=>{live=false;clearTimeout(timer);};},[task.id,task.network_mode]);
 if(task.network_mode!=="jump")return null;
 const waiting=!["done","failed","timeout"].includes(task.status)&&channel?.status!=="online"&&!channel?.historical;
 return <div className="flex flex-wrap items-center gap-2 text-xs"><TaskNetworkBadge task={channel?.historical?{...task,network_channel_name:channel.name}:task}/><span className={waiting?"text-amber-500":"text-muted-foreground"}>{error?"Channel status is temporarily unavailable":channel?(channel.historical?"Historical configuration v"+channel.version:labels[channel.status]):"Detecting connection"}</span>{channel?.full_network&&channel.status==="online"&&!channel.full_network_ready&&<span className="text-amber-500">Layer 3 network is ready</span>}{channel?.chain&&channel.chain.length>1&&<span className="text-muted-foreground">{channel.chain.map(c=>c.name).join(" → ")}</span>}{waiting&&channel&&<span className="text-muted-foreground">Target access is waiting for the channel to be restored, and the task time limit continues to count.</span>}</div>;
}
interface ChannelProbe{
 kind:"channel";ready:boolean;proxy_ready:boolean;full_network:boolean;full_network_ready:boolean;
 chain:{id:string;name:string;status:"online"|"offline"|"disabled"}[];
}
export function NetworkSettingsSection(){
 const {channels,error,reload}=useChannels();
 const [choice,setChoice]=React.useState<NetworkChoice>({}),[saving,setSaving]=React.useState(false),[open,setOpen]=React.useState(false);
 const [editing,setEditing]=React.useState<NetworkChannel|null>(null);
 const [name,setName]=React.useState(""),[host,setHost]=React.useState(""),[scopes,setScopes]=React.useState(""),[parent,setParent]=React.useState("direct"),[relay,setRelay]=React.useState(""),[full,setFull]=React.useState(true),[probeURL,setProbeURL]=React.useState("");
 const [probe,setProbe]=React.useState<NetworkChannel|null>(null),[target,setTarget]=React.useState(""),[busy,setBusy]=React.useState(false);
 const [checking,setChecking]=React.useState(false),[checkResult,setCheckResult]=React.useState<ChannelProbe|null>(null),[checkError,setCheckError]=React.useState(""),[targetStatus,setTargetStatus]=React.useState<number|null>(null);
 const probeSequence=React.useRef(0),probeIdentity=React.useRef<string|null>(null);
 const [targetBusy,setTargetBusy]=React.useState(false);
 const locked=!!editing?.dependent_tasks;
 const selectedParent=channels.find(c=>c.id===parent);
 const connectionChanged=!!editing&&(host.trim()!==editing.server_host||parent!==(editing.parent_channel_id??"direct")||relay.trim()!==editing.relay_listen||full!==editing.full_network||
  JSON.stringify(scopes.split(/\r?\n/).map(s=>s.trim().toLowerCase()).filter(Boolean).sort())!==JSON.stringify([...editing.scopes].sort()));
 const affected=editing?channels.filter(c=>c.chain?.some(h=>h.id===editing.id)):[];
 React.useEffect(()=>{void api.settings().then(s=>setChoice({network_mode:s.network_mode??"standard",network_channel_id:s.network_channel_id||null})).catch(()=>{});},[]);
 function edit(c?:NetworkChannel){
  setEditing(c??null);setName(c?.name??"");setHost(c?.server_host??window.location.hostname);setScopes(c?.scopes.join("\n")??"");
  setParent(c?.parent_channel_id??"direct");setRelay(c?.relay_listen??"");setFull(c?.full_network??true);setProbeURL(c?.probe_url??"");setOpen(true);
 }
 async function save(){
  setSaving(true);try{await api.setSettings({network_mode:choice.network_mode??"standard",network_channel_id:choice.network_channel_id??0});toast.success("New task default network mode saved");}
  catch(e){toast.error((e as Error).message);}finally{setSaving(false);}
 }
 async function saveChannel(e:React.FormEvent){
  e.preventDefault();setBusy(true);
  try{
   const row=await http<NetworkChannel&{requires_redeploy?:boolean;affected_channels?:{id:string;name:string}[]}>("/network/channels"+(editing?"/"+editing.id:""),{
    method:editing?"PATCH":"POST",body:JSON.stringify({name,server_host:host,parent_channel_id:parent==="direct"?null:Number(parent),relay_listen:relay,full_network:full,
     scopes:scopes.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),probe_url:probeURL,...(editing?{expected_version:editing.version}:{})})});
   if(!editing)setChoice({network_mode:"jump",network_channel_id:Number(row.id)});
   setOpen(false);await reload();
   toast.success(row.requires_redeploy?"Saved, please update the connection package:"+row.affected_channels?.map(c=>c.name).join("、"):editing?"Channel saved":"The channel has been created, please download the connection program");
  }catch(e){toast.error((e as Error).message);}finally{setBusy(false);}
 }
 async function toggle(c:NetworkChannel,enabled:boolean){try{await http("/network/channels/"+c.id,{method:"PATCH",body:JSON.stringify({enabled})});await reload();}catch(e){toast.error((e as Error).message);}}
 async function download(c:NetworkChannel,platform:string){
  try{const blob=await api.downloadNetworkConnector(c.id,platform),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="wormhole-connector-"+c.id+"-"+platform+".zip";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  catch(e){toast.error((e as Error).message);}
 }
 async function checkConnection(c:NetworkChannel){
  const sequence=++probeSequence.current;setChecking(true);setCheckResult(null);setCheckError("");
  try{const result=await http<ChannelProbe>("/network/channels/"+c.id+"/probe",{method:"POST",body:"{}"});if(sequence===probeSequence.current)setCheckResult(result);await reload();}
  catch(e){if(sequence===probeSequence.current)setCheckError((e as Error).message);}
  finally{if(sequence===probeSequence.current)setChecking(false);}
 }
 function showProbe(c:NetworkChannel){
  probeIdentity.current=c.id;setProbe(c);setTarget(c.probe_url||c.suggested_probe_url||"");setTargetStatus(null);setTargetBusy(false);void checkConnection(c);
 }
 function closeProbe(){
  probeIdentity.current=null;probeSequence.current++;setProbe(null);setChecking(false);setTargetBusy(false);
 }
 async function checkTarget(){
  if(!probe)return;const id=probe.id,sequence=probeSequence.current;setTargetBusy(true);setTargetStatus(null);
  try{const r=await http<{status:number}>("/network/channels/"+id+"/probe",{method:"POST",body:JSON.stringify({target})});if(probeIdentity.current===id&&sequence===probeSequence.current)setTargetStatus(r.status);}
  catch(e){if(probeIdentity.current===id&&sequence===probeSequence.current)toast.error((e as Error).message);}
  finally{if(probeIdentity.current===id&&sequence===probeSequence.current)setTargetBusy(false);}
 }

 return <SettingsSection title="Network access mode"><HelpButton topic="network" />
  <SettingsRow title="New task default mode" >
   <div className="flex items-center gap-2"><Select value={choice.network_mode??"standard"} onValueChange={v=>setChoice({...choice,network_mode:v as "standard"|"jump"})}>
    <SelectTrigger aria-label="Default network mode" className="w-40"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="standard">Normal mode</SelectItem><SelectItem value="jump">Springboard proxy mode</SelectItem></SelectContent>
   </Select><Button size="sm" disabled={saving||(choice.network_mode==="jump"&&!choice.network_channel_id)} onClick={()=>void save()}>Save</Button></div>
  </SettingsRow>
  {choice.network_mode==="jump"&&<>
   <SettingsRow title="Default springboard channel" >
    <Select value={choice.network_channel_id?String(choice.network_channel_id):""} onValueChange={v=>setChoice({...choice,network_channel_id:Number(v)})}>
     <SelectTrigger aria-label="Default springboard channel" className="w-64"><SelectValue placeholder="Select channel"/></SelectTrigger>
     <SelectContent>{channels.filter(c=>c.enabled).map(c=><SelectItem key={c.id} value={c.id}>{c.name} · {labels[c.status]}</SelectItem>)}</SelectContent>
    </Select>
   </SettingsRow>
   <div className="flex items-center justify-between py-3"><span className="text-sm text-muted-foreground">{error||channels.length+" springboard channels"}</span>
    <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={()=>void reload()} aria-label="Refresh springboard channel"><RefreshCwIcon className="size-4"/></Button><Button size="sm" variant="outline" onClick={()=>edit()}><PlusIcon/>Add new channel</Button></div>
   </div>
   {channels.map(c=><div key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-t py-4" data-channel-id={c.id}>
    <div className="min-w-0 space-y-1">
     <div className="flex items-center gap-2"><CableIcon className="size-4 text-muted-foreground"/><span className="text-sm font-medium">{c.name}</span><Badge variant={c.status==="online"?"secondary":"outline"}>{labels[c.status]}</Badge>
      <span className="text-xs text-muted-foreground">v{c.version}</span>{c.full_network&&c.status==="online"&&!c.full_network_ready&&<span className="text-xs text-amber-500">Layer 3 network is ready</span>}
     </div>
     <p className="text-xs text-muted-foreground">{c.server_host}:{c.entry_port} · {c.dependent_tasks??c.active_tasks}  associated tasks{c.full_network?" · TCP / UDP / ICMP":""}</p>
     {!!c.chain&&c.chain.length>1&&<p className="text-xs text-muted-foreground">WORMHOLE → {c.chain.map(h=>h.name).join(" → ")}</p>}
     <p className="max-w-xl truncate text-xs text-muted-foreground" title={c.scopes.join("、")}>{c.scopes.join("、")}</p>
    </div>
    <div className="flex items-center gap-2">
     <Button size="sm" variant="ghost" onClick={()=>edit(c)} aria-label={"Edit Channel "+c.name}><PencilIcon className="size-4"/>Edit</Button>
     <Button size="sm" variant="ghost" onClick={()=>showProbe(c)}>Detect connection</Button>
     <Button size="sm" variant="outline" disabled={!c.enabled} onClick={()=>void download(c,"linux_amd64")}><DownloadIcon/>Linux</Button>
     <Button size="sm" variant="outline" disabled={!c.enabled} onClick={()=>void download(c,"windows_amd64")}><DownloadIcon/>Windows</Button>
     <Switch aria-label={"Enable channel "+c.name} checked={c.enabled} onCheckedChange={v=>void toggle(c,v)}/>
    </div>
   </div>)}
   {!channels.length&&!error&&null}
  </>}
  <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto">
   <DialogHeader><DialogTitle>{editing?"Edit Springboard Channel":"Add new springboard channel"}</DialogTitle><HelpButton topic="network" section="Configuration and Deployment" /></DialogHeader>
   <form onSubmit={e=>void saveChannel(e)} className="space-y-4">
    <div className="space-y-2"><Label htmlFor="channel-name">Name</Label><Input id="channel-name" value={name} onChange={e=>setName(e.target.value)} required maxLength={100}/></div>
    {locked&&<p className="text-xs text-muted-foreground">Yes {editing?.dependent_tasks}  There are unfinished tasks, and the connection configuration cannot be changed yet.</p>}
    <div className="space-y-2"><Label>Superior channel</Label><Select value={parent} onValueChange={setParent} disabled={locked}>
     <SelectTrigger aria-label="Upper level springboard channel"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="direct">Direct access to WORMHOLE</SelectItem>
      {channels.filter(c=>((c.enabled&&c.relay_listen)||c.id===editing?.parent_channel_id)&&(!editing||!c.chain?.some(h=>h.id===editing.id))).map(c=><SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
     </SelectContent>
    </Select></div>
    <div className="space-y-2"><Label htmlFor="channel-host">{parent==="direct"?"On-site accessible server address":"On-site accessible superior springboard address"}</Label>
     <Input id="channel-host" value={host} onChange={e=>setHost(e.target.value)} required placeholder="203.0.113.10" disabled={locked}/>
     {selectedParent&&<p className="text-xs text-muted-foreground">Access port:{selectedParent.relay_listen.split(":").at(-1)}</p>}
    </div>
    <div className="space-y-2"><Label htmlFor="channel-scopes">Accessible range</Label><Textarea id="channel-scopes" value={scopes} onChange={e=>setScopes(e.target.value)} required placeholder={"10.20.0.0/16\n*.corp.test"} disabled={locked}/><p className="text-xs text-muted-foreground">One domain name, IP, or network segment per line.</p></div>
    <div className="space-y-2"><Label htmlFor="channel-relay">Lower-level access monitoring (optional)</Label><Input id="channel-relay" value={relay} onChange={e=>setRelay(e.target.value)} placeholder="192.168.1.10:18888" disabled={locked}/></div>
    <div className="flex items-center justify-between gap-4"><div><Label htmlFor="channel-full">Complete network</Label><p className="mt-1 text-xs text-muted-foreground">TCP, UDP, ICMP · Connectors need to be run by an administrator</p></div><Switch id="channel-full" checked={full} onCheckedChange={setFull} disabled={locked}/></div>
    <div className="space-y-2"><Label htmlFor="channel-probe-url">Target test address (optional)</Label><Input id="channel-probe-url" value={probeURL} onChange={e=>setProbeURL(e.target.value)} placeholder="https://internalsystem/health" maxLength={2048}/></div>
    {connectionChanged&&<p className="text-xs text-amber-500">After saving, you need to re-download and restart the connector.{affected.length>1?", including "+affected.length+" upper and lower level channels":""}。</p>}
    <Button type="submit" disabled={busy}>{busy?"Saving":editing?"Save channel":"Create channel"}</Button>
   </form>
  </DialogContent></Dialog>
  <Dialog open={!!probe} onOpenChange={v=>{if(!v)closeProbe();}}><DialogContent>
   <DialogHeader><DialogTitle>Connection detection · {probe?.name}</DialogTitle><HelpButton topic="network" section="Connectivity check" /></DialogHeader>
   <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
     <span className="text-sm font-medium" role="status">{checking?"Detecting channel":checkError||(!checkResult?"Waiting for detection":checkResult.ready?"Channel available":checkResult.proxy_ready?"Complete network ready":"Channel not connected")}</span>
     <Button size="sm" variant="outline" disabled={checking||targetBusy} onClick={()=>probe&&void checkConnection(probe)}>Retest</Button>
    </div>
    {checkResult?.chain.map(c=><div key={c.id} className="flex items-center justify-between text-sm"><span>{c.name}</span><span className="text-xs text-muted-foreground">{labels[c.status]}</span></div>)}
    {checkResult?.full_network_ready&&<p className="text-xs text-muted-foreground">Complete network is ready</p>}
   </div>
   <div className="space-y-3 border-t pt-4">
    <Label htmlFor="channel-probe">Target access (optional)</Label>
    <Input id="channel-probe" value={target} onChange={e=>{setTarget(e.target.value);setTargetStatus(null);}} placeholder="https://internalsystem/health"/>
    <div className="flex items-center gap-3"><Button size="sm" disabled={targetBusy||!target.trim()} onClick={()=>void checkTarget()}>{targetBusy?"Under testing":"Test target"}</Button>
     {targetStatus!==null&&<span className="text-sm" role="status">Target response · HTTP {targetStatus}</span>}
    </div>
   </div>
  </DialogContent></Dialog>
 </SettingsSection>;
}
