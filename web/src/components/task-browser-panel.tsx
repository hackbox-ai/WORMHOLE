"use client";
import * as React from "react";
import {ArrowLeft,ArrowRight,RotateCw,Plus,X,Globe,Hand,Play,LogIn} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {http} from "@/lib/api";

type Tab={id:string;url:string;human:boolean;worker:string;loginRequested?:boolean};
type Session={id:string;name:string;worker:string;url:string;human:boolean;shared:boolean;authLocked:boolean;loginRequested?:boolean;tabs:Tab[]};
type Workspace={sessions:Session[];targets:string[];can_open:boolean;paused:boolean;lifecycle:string;idle_minutes:number};
export function useTaskBrowserSessions(taskId:string,active:boolean){
 const [data,setData]=React.useState<Workspace>({sessions:[],targets:[],can_open:false,paused:false,lifecycle:"",idle_minutes:15});
 const [error,setError]=React.useState("");
 const refresh=React.useCallback(async(signal?:AbortSignal)=>{
  if(!taskId)return;
  const value=await http<Workspace>("/tasks/"+encodeURIComponent(taskId)+"/browser",{signal});
  setData(value);setError("");
 },[taskId]);
 React.useEffect(()=>{
  setData({sessions:[],targets:[],can_open:false,paused:false,lifecycle:"",idle_minutes:15});
  if(!taskId||!active)return;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{await refresh(abort.signal);}catch(e){if(!abort.signal.aborted)setError((e as Error).message);}
   finally{if(!abort.signal.aborted)timer=setTimeout(()=>void poll(),2000);}};
  void poll();return()=>{abort.abort();clearTimeout(timer);};
 },[taskId,active,refresh]);
 const setSessions=React.useCallback((value:React.SetStateAction<Session[]>)=>setData(d=>({...d,sessions:typeof value==="function"?value(d.sessions):value})),[]);
 return {...data,setSessions,error,refresh};
}

export function TaskBrowserPanel({taskId,active,feed}:{taskId:string;active:boolean;feed:ReturnType<typeof useTaskBrowserSessions>}){
 const [envId,setEnvId]=React.useState(""),[tabId,setTabId]=React.useState("");
 const [inputText,setInputText]=React.useState("");
 const [address,setAddress]=React.useState(""),[name,setName]=React.useState(""),[note,setNote]=React.useState("");
 const [image,setImage]=React.useState<{tab:string;image:string}>(),[error,setError]=React.useState(""),[working,setWorking]=React.useState(false);
 const queue=React.useRef<Promise<unknown>>(Promise.resolve()),pending=React.useRef(0),view=React.useRef<HTMLDivElement>(null);
 const base="/tasks/"+encodeURIComponent(taskId)+"/browser";
 const env=feed.sessions.find(s=>s.id===envId)??feed.sessions.find(s=>s.loginRequested)??feed.sessions[0];
 const tab=env?.tabs.find(t=>t.id===tabId)??env?.tabs.find(t=>t.loginRequested)??env?.tabs[0];
 const eid=env?.id??"",tid=tab?.id??"";
 React.useEffect(()=>{setAddress(tab?.url&&tab.url!=="about:blank"?tab.url:feed.targets[0]??"");},[tid,tab?.url,feed.targets[0]]);
 React.useEffect(()=>setName(env?.name??""),[eid,env?.name]);
 const send=React.useCallback((action:string,params:Record<string,unknown>={})=>{
  if(!eid)return Promise.resolve();
  if(action==="screenshot"&&pending.current)return Promise.resolve();
  pending.current++;
  const request=queue.current.then(async()=>{
   try{
    const result=await http<{image?:string;tab_id?:string}>(base+"/"+eid,{method:"POST",body:JSON.stringify({action,tab_id:tid,...params})});
    if(result.image)setImage({tab:tid,image:result.image});
    if(result.tab_id&&action==="new_tab")setTabId(result.tab_id);
    if(action!=="screenshot"){
     setError("");
     if(!["point","type","key","enter","scroll"].includes(action))await feed.refresh();
     if(pending.current===1&&["point","type","key","enter","scroll","navigate","back","forward","reload"].includes(action)){
      const frame=await http<{image?:string}>(base+"/"+eid,{method:"POST",body:JSON.stringify({action:"screenshot",tab_id:tid})});
      if(frame.image)setImage({tab:tid,image:frame.image});
     }
    }
   }catch(e){if(action!=="screenshot")setError((e as Error).message);}
   finally{pending.current--;}
  });
  queue.current=request.catch(()=>{});return request;
 },[base,eid,tid,feed.refresh]);
 React.useEffect(()=>{
  if(!tid)return;
  void send("screenshot");const timer=setInterval(()=>void send("screenshot"),1500);return()=>clearInterval(timer);
 },[tid,send]);
 const create=async()=>{
  const url=address.trim()||feed.targets[0];
  if(!url){setError("Please enter the site address within the task range");return;}
  setWorking(true);
  try{
   const result=await http<{environment_id:string;tab_id:string}>(base,{method:"POST",body:JSON.stringify({url,name:""})});
   await feed.refresh();setEnvId(result.environment_id);setTabId(result.tab_id);setError("");
  }catch(e){setError((e as Error).message);}finally{setWorking(false);}
 };
 const human=!!tab?.human;
 const keyDown=(event:React.KeyboardEvent)=>{
  if(!human||event.nativeEvent.isComposing||event.key==="Process")return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="v")return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"){event.preventDefault();void send("key",{key:"ControlOrMeta+A"});return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.key.length===1){event.preventDefault();void send("type",{text:event.key});}
  else if(["Tab","Enter","Backspace","Delete","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(event.key)){
   event.preventDefault();void send("key",{key:event.shiftKey&&event.key==="Tab"?"Shift+Tab":event.key});
  }
 };
 return <section className="overflow-hidden rounded-xl border bg-background" aria-label="Task Browser Workspace">
  <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 p-3">
   <Globe className="size-4 text-muted-foreground"/>
   <select aria-label="Browser environment" className="h-8 max-w-52 rounded-md border bg-background px-2 text-sm" value={eid} onChange={e=>{setEnvId(e.target.value);setTabId("");}}>
    {feed.sessions.length?feed.sessions.map(s=><option key={s.id} value={s.id}>{s.name}</option>):<option value="">Default environment</option>}
   </select>
   <Button size="sm" variant="outline" disabled={working||!feed.can_open} onClick={create}><Plus className="size-3.5"/>Create a new environment</Button>
   {env&&<><Input aria-label="Environment name" className="h-8 w-36" value={name} maxLength={50} onChange={e=>setName(e.target.value)} onBlur={()=>{if(name.trim()&&name!==env.name)void send("rename",{name});}}/>
    <Button size="icon-sm" variant="ghost" aria-label="Shut down environment" title="Shut down the environment and clear its login status" onClick={()=>void send("close_environment")}><X className="size-3.5"/></Button>
    <span className="ml-auto text-xs text-muted-foreground">{env.authLocked?"Manual login in progress":human?"You are operating":tab?.worker?"Agent is in use":"Can be handed over to Agent"}</span></>}
  </div>
  <div className="flex items-center gap-1 overflow-x-auto border-b px-2 pt-2" aria-label="Browser tab">
   {env?.tabs.map((t,i)=><button key={t.id} className={"flex max-w-56 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 py-2 text-xs "+(tid===t.id?"bg-muted":"text-muted-foreground")} onClick={()=>setTabId(t.id)} title={t.url}>
    <Globe className="size-3"/><span className="truncate">{t.url==="about:blank"?"New tab page":t.url||"Tab "+(i+1)}</span>{t.human&&<Hand className="size-3"/>}
   </button>)}
   {env&&<Button size="icon-sm" variant="ghost" aria-label="New tab page" disabled={!feed.can_open} onClick={()=>void send("new_tab",{url:address||feed.targets[0]})}><Plus className="size-3.5"/></Button>}
   {tab&&human&&<Button size="icon-sm" variant="ghost" aria-label="Close tab" onClick={()=>void send("close_tab")}><X className="size-3.5"/></Button>}
  </div>
  <form className="flex items-center gap-1.5 border-b p-2" onSubmit={e=>{e.preventDefault();if(!env)void create();else if(tab)void send("navigate",{url:address});else void send("new_tab",{url:address});}}>
   <Button type="button" size="icon-sm" variant="ghost" aria-label="Back" disabled={!human} onClick={()=>void send("back")}><ArrowLeft className="size-4"/></Button>
   <Button type="button" size="icon-sm" variant="ghost" aria-label="Forward" disabled={!human} onClick={()=>void send("forward")}><ArrowRight className="size-4"/></Button>
   <Button type="button" size="icon-sm" variant="ghost" aria-label="Refresh page" disabled={!human} onClick={()=>void send("reload")}><RotateCw className="size-4"/></Button>
   <Input aria-label="Site address" className="h-8 min-w-0 flex-1" placeholder="Enter the site address within the task scope" value={address} onChange={e=>setAddress(e.target.value)} disabled={!feed.can_open}/>
   <Button type="submit" size="sm" disabled={working||!feed.can_open||!!tab&&!human}>Open</Button>
  </form>
  {(error||feed.error)&&<p role="alert" className="px-3 py-2 text-sm text-destructive">{error||feed.error}</p>}
  {feed.paused&&<p className="px-3 py-2 text-xs text-muted-foreground">The task has been suspended and the Agent has stopped operating; you can continue to log in and browse.</p>}
  {tab?<div ref={view} role="application" aria-label="Interactive browser screen" tabIndex={human?0:-1} className={"relative outline-none "+(human?"cursor-crosshair":"")}
   onCompositionEnd={e=>{if(human&&e.data)void send("type",{text:e.data});}} onKeyDown={keyDown} onPaste={e=>{if(human){e.preventDefault();void send("type",{text:e.clipboardData.getData("text").slice(0,4096)});}}}
   onWheel={e=>{if(human)void send("scroll",{x:e.deltaX,y:e.deltaY});}}>
   {image?.tab===tid?<img alt="Task browser screen" draggable={false} src={"data:image/jpeg;base64,"+image.image} className="mx-auto block h-auto w-auto max-h-[62vh] max-w-full"
    onClick={e=>{if(!human)return;view.current?.focus();const box=e.currentTarget.getBoundingClientRect();void send("point",{x:(e.clientX-box.left)*1100/box.width,y:(e.clientY-box.top)*700/box.height});}}/>:<div className="flex min-h-72 items-center justify-center text-sm text-muted-foreground">Reading page...</div>}
  </div>:<div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 text-center">
   <Globe className="size-9 text-muted-foreground/50"/><p className="text-sm">{feed.can_open?"Open the site and start browsing or logging in":"The current task has ended"}</p>
   <p className="max-w-md text-xs leading-6 text-muted-foreground">{feed.can_open?"Tabs within an environment share browser state. When different accounts or anonymous access are required, create a new independent environment.":"The browser environment has been recycled, but the task evidence is still retained."} </p>
   {!!feed.targets.length&&feed.can_open&&<div className="flex flex-wrap justify-center gap-2">{feed.targets.slice(0,3).map(url=><button key={url} className="max-w-80 truncate rounded-md border px-3 py-1.5 text-xs" onClick={()=>setAddress(url)} title={url}>{url}</button>)}</div>}
  </div>}
  {human&&<form className="flex items-center gap-2 border-t px-3 py-2" onSubmit={e=>{e.preventDefault();if(inputText){void send("type",{text:inputText});setInputText("");}}}>
   <Input type="password" autoComplete="off" aria-label="Browser input" className="h-8 min-w-0 flex-1" placeholder="Enter text (supports Chinese) and send it to the current focus of the page" value={inputText} maxLength={4096} onChange={e=>setInputText(e.target.value)}/>
   <Button size="sm" variant="outline" type="submit" disabled={!inputText}>Input</Button>
   <Button size="sm" variant="outline" type="button" onClick={()=>void send("key",{key:"Enter"})}>Enter</Button>
  </form>}
  {tab&&<div className="flex flex-wrap items-center gap-2 border-t p-3">
   <Button size="sm" variant="outline" onClick={()=>void send(human?"release":"take")}><Hand className="size-3.5"/>{human?"Return tab":"Takeover tab"}</Button>
   <Button size="sm" variant="outline" onClick={()=>void send("login")}><LogIn className="size-3.5"/>Log in / switch identity</Button>
   <Input className="h-8 min-w-32 flex-1" aria-label="Handover instructions" placeholder="Optional: Tell the Agent what to check on the current page" value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/>
   <Button size="sm" onClick={()=>void send("handoff",{note})}><Play className="size-3.5"/>Leave to Agent</Button>
  </div>}
  <div className="border-t px-3 py-2 text-xs text-muted-foreground">Environment idle {feed.idle_minutes}  Recycle after minutes or the end of the task. Browser requests inherit the collection and network channels of the task.</div>
 </section>;
}
