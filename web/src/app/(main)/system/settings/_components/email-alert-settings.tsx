"use client";
import * as React from "react";
import Link from "next/link";
import {toast} from "sonner";
import {SettingsSection,SettingsRow} from "@/components/settings-layout";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {api} from "@/lib/api";

type State=Awaited<ReturnType<typeof api.emailAlerts>>;
export function EmailAlertSettings(){
 const [state,setState]=React.useState<State>();
 const [config,setConfig]=React.useState<Record<string,unknown>>({port:587,tls:false});
 const [enabled,setEnabled]=React.useState(false),[base,setBase]=React.useState("");
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState(false),[dirty,setDirty]=React.useState(false);
 const apply=React.useCallback((s:State)=>{
  setState(s);setEnabled(s.channel?.enabled??false);setBase(s.public_base_url);
  const c=s.channel?.config??{port:587,tls:false};
  setConfig({...c,to:Array.isArray(c.to)?c.to.join(", "):c.to??""});setDirty(false);
 },[]);
 const load=React.useCallback(()=>{setError(false);api.emailAlerts().then(apply).catch(()=>setError(true));},[apply]);
 React.useEffect(load,[load]);
 const change=(key:string,value:unknown)=>{setConfig(c=>({...c,[key]:value}));setDirty(true);};
 const save=async()=>{
  const to=String(config.to??"").split(/[\s,，;；]+/).filter(Boolean);
  if(!String(config.host??"").trim()||!String(config.from??"").trim()||!to.length){toast.error("Please fill in SMTP, sender and recipient");return;}
  setBusy(true);
  try{apply(await api.saveEmailAlerts({enabled,public_base_url:base,config:{...config,port:Number(config.port),to}}));toast.success("Email alert has been saved");}
  catch(e){toast.error("Saving failed:"+(e as Error).message);}finally{setBusy(false);}
 };
 const test=async()=>{
  if(!state?.channel)return;
  setBusy(true);try{await api.notifyTestChannel(state.channel.id);toast.success("Test email has been submitted, please check your inbox");}
  catch(e){toast.error("Test failed:"+(e as Error).message,{duration:10000});}finally{setBusy(false);}
 };
 const field=(key:string,title:string,placeholder="",type="text")=><SettingsRow title={title} htmlFor={"email-"+key}>
  <Input id={"email-"+key} type={type} autoComplete={type==="password"?"new-password":"off"} className="w-full sm:w-80"
   placeholder={key==="password"&&String(config.password??"").startsWith("__masked__")?"Already set, leave blank to remain unchanged":placeholder}
   value={key==="password"&&String(config.password??"").startsWith("__masked__")?"":String(config[key]??"")}
   onChange={e=>change(key,e.target.value)}/>
 </SettingsRow>;
 return <SettingsSection title="High-risk email alert">
  {error?<div className="settings-empty" role="alert">Mail configuration failed to load.<Button size="sm" variant="outline" onClick={load}>Try again</Button></div>:!state?<div className="settings-empty">Loading email configuration...</div>:<>
   <fieldset disabled={busy} className="min-w-0">
    <SettingsRow title="Email Alert" >
     <Switch aria-label="Enable high-risk email alerts" checked={enabled} onCheckedChange={v=>{setEnabled(v);setDirty(true);}}/>
    </SettingsRow>
    {field("to","Receiving email","Multiple mailboxes separated by commas")}
    {field("host","SMTP server","smtp.example.com")}
    <SettingsRow title="SMTP port" htmlFor="email-port">
     <Input id="email-port" className="w-24" type="number" min={1} max={65535} value={String(config.port??587)} onChange={e=>change("port",e.target.value)}/>
     <Select value={config.tls?"tls":"starttls"} onValueChange={v=>{setConfig(c=>({...c,tls:v==="tls",port:v==="tls"?465:587}));setDirty(true);}}>
      <SelectTrigger className="w-44" aria-label="SMTP encryption method"><SelectValue/></SelectTrigger>
      <SelectContent><SelectItem value="starttls">STARTTLS · 587</SelectItem><SelectItem value="tls">TLS · 465</SelectItem></SelectContent>
     </Select>
    </SettingsRow>
    {field("username","Sending account")}
    {field("password","Password/Authorization Code","","password")}
    {field("from","Sending email","wormhole@example.com")}
    <SettingsRow title="WORMHOLE access address" htmlFor="email-base" >
     <Input id="email-base" className="w-full sm:w-80" placeholder="https://wormhole.example.com" value={base} onChange={e=>{setBase(e.target.value);setDirty(true);}}/>
    </SettingsRow>
   </fieldset>
   {!state.global_enabled&&<div className="settings-section-actions text-sm text-muted-foreground">The external notification master switch is turned off.<Button variant="outline" size="sm" disabled={busy} onClick={async()=>{setBusy(true);try{await api.setSettings({notify_enabled:true});setState(s=>s?{...s,global_enabled:true}:s);toast.success("External notifications are on");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}}>Turn on external notifications</Button></div>}
   <div className="settings-section-actions">
    <Button size="sm" disabled={busy} onClick={save}>Save mail settings</Button>
    <Button variant="outline" size="sm" disabled={busy||!state.channel||dirty} onClick={test}>Send test email</Button>
    <Button variant="ghost" size="sm" asChild><Link href="/system/notify">Delivery record</Link></Button>
    {dirty&&<span className="text-muted-foreground text-xs">There are unsaved changes</span>}
   </div>
  </>}
 </SettingsSection>;
}
