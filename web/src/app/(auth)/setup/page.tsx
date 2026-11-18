"use client";
import {useRef,useState} from "react";
import {LoaderCircle,KeyRound,AlertCircle} from "lucide-react";
import {Button} from "@/components/ui/button";
import {api} from "@/lib/api";
import {auth} from "@/lib/auth";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {PasswordField} from "../_components/password-field";
import {useAuthEntry,authErrorMessage} from "../_components/use-auth-entry";

export default function SetupPage(){
 const {state,checkError,retry}=useAuthEntry("setup");
 const [username,setUsername]=useState("WORMHOLE");
 const [password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[error,setError]=useState(""),[loading,setLoading]=useState(false);
 const busy=useRef(false);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy.current||state!=="ready")return;
  if(!username.trim()){setError("Please enter account");return;}
  if(password.length<8){setError("Password requires at least 8 characters");return;}
  if(password!==confirm){setError("The passwords entered twice are inconsistent");return;}
  busy.current=true;setLoading(true);setError("");
  try{const {token}=await api.initPassword(password,undefined,username.trim());auth.setToken(token);window.location.replace("/function/tasks");}
  catch(error){setError(authErrorMessage(error));}
  finally{busy.current=false;setLoading(false);}
 }
 return <>
  <div className="wormhole-entry-emblem"><KeyRound/></div>
  <div className="wormhole-entry-heading"><h1>Initialize account</h1></div>
  {state==="checking"?<div className="wormhole-entry-connection" role="status"><LoaderCircle className="wormhole-entry-spin"/>Checking</div>:
   state==="unavailable"?<div className="wormhole-entry-recovery"><p className="wormhole-entry-error" role="alert"><AlertCircle/>{checkError}</p><Button className="wormhole-entry-submit" onClick={retry}>Retry connection</Button></div>:
   <form onSubmit={submit} className="wormhole-entry-form" aria-busy={loading}>
    <div className="wormhole-entry-field"><Label htmlFor="username">Account</Label><div className="wormhole-entry-input"><Input id="username" name="username" value={username} onChange={e=>{setUsername(e.target.value);setError("");}} autoComplete="username" maxLength={48} disabled={loading} required placeholder="Please enter account"/></div></div>
    <PasswordField id="password" label="Set password" value={password} onChange={value=>{setPassword(value);setError("");}} autoComplete="new-password" autoFocus disabled={loading} placeholder="At least 8 digits"/>
    <PasswordField id="confirm" label="Confirm password" value={confirm} onChange={value=>{setConfirm(value);setError("");}} autoComplete="new-password" disabled={loading} placeholder="Enter password again"/>
    {error&&<p className="wormhole-entry-error" role="alert"><AlertCircle/>{error}</p>}
    <Button type="submit" className="wormhole-entry-submit" disabled={loading||!username.trim()||!password||!confirm}>{loading?<><LoaderCircle className="wormhole-entry-spin"/>Setting up</>:<>Save and log in</>}</Button>
   </form>}
 </>;
}
