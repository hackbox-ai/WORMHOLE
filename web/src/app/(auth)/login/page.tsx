"use client";
import {useEffect,useRef,useState} from "react";
import {LoaderCircle,LockKeyhole,AlertCircle} from "lucide-react";
import {Button} from "@/components/ui/button";
import {api} from "@/lib/api";
import {auth} from "@/lib/auth";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {PasswordField} from "../_components/password-field";
import {useAuthEntry,authErrorMessage} from "../_components/use-auth-entry";

export default function LoginPage(){
 const {state,checkError,retry}=useAuthEntry("login");
 const [username,setUsername]=useState("WORMHOLE");
 useEffect(()=>{setUsername(auth.getRememberedUsername());},[]);
 const [password,setPassword]=useState(""),[error,setError]=useState(""),[loading,setLoading]=useState(false),[invalid,setInvalid]=useState(false);
 const busy=useRef(false);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy.current||state!=="ready"||!username.trim()||!password)return;
  busy.current=true;setLoading(true);setError("");setInvalid(false);
  try{const {token}=await api.login(username.trim(),password);auth.setToken(token);window.location.replace("/function/tasks");}
  catch(error){setError(authErrorMessage(error));setInvalid((error as {status?:number}).status===401);}
  finally{busy.current=false;setLoading(false);}
 }
 return <>
  <div className="wormhole-entry-emblem"><LockKeyhole/></div>
  <div className="wormhole-entry-heading"><h1>Login</h1></div>
  {state==="checking"?<div className="wormhole-entry-connection" role="status"><LoaderCircle className="wormhole-entry-spin"/>Connecting</div>:
   state==="unavailable"?<div className="wormhole-entry-recovery"><p className="wormhole-entry-error" role="alert"><AlertCircle/>{checkError}</p><Button className="wormhole-entry-submit" onClick={retry}>Retry connection</Button></div>:
   <form onSubmit={submit} className="wormhole-entry-form" aria-busy={loading}>
    <div className="wormhole-entry-field"><Label htmlFor="username">Account</Label><div className="wormhole-entry-input"><Input id="username" name="username" value={username} onChange={e=>{setUsername(e.target.value);setError("");setInvalid(false);}} autoComplete="username" maxLength={48} disabled={loading} aria-invalid={invalid} required placeholder="Please enter account"/></div></div>
    <PasswordField id="password" label="Password" value={password} onChange={value=>{setPassword(value);setInvalid(false);setError("");}} autoFocus disabled={loading} placeholder="Please enter password" invalid={invalid}/>
    {error&&<p className="wormhole-entry-error" role="alert"><AlertCircle/>{error}</p>}
    <Button type="submit" className="wormhole-entry-submit" disabled={loading||!username.trim()||!password}>{loading?<><LoaderCircle className="wormhole-entry-spin"/>Logging in</>:<>Login</>}</Button>
   </form>}
 </>;
}
