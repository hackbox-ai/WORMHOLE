"use client";
import {useEffect,useRef,useState} from "react";
import {toast} from "sonner";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {api} from "@/lib/api";
import {auth} from "@/lib/auth";
export function ChangeUsernameDialog({open,onOpenChange,username}:{open:boolean;onOpenChange:(open:boolean)=>void;username:string}){
 const [next,setNext]=useState(username),[password,setPassword]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const busy=useRef(false);
 useEffect(()=>{if(open){setNext(username);setPassword("");setError("");}},[open,username]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(busy.current||!next.trim()||!password)return;
  busy.current=true;setSaving(true);setError("");
  try{const result=await api.changeUsername(next.trim(),password);auth.setToken(result.token);toast.success("Username has been modified");onOpenChange(false);}
  catch(error){setError((error as Error).message);}
  finally{busy.current=false;setSaving(false);}
 }
 return <Dialog open={open} onOpenChange={value=>{if(!busy.current)onOpenChange(value);}}><DialogContent className="sm:max-w-md"><form onSubmit={submit}>
  <DialogHeader><DialogTitle>Modify username</DialogTitle><DialogDescription>Enter the current password to confirm the change.</DialogDescription></DialogHeader>
  <div className="flex flex-col gap-4 py-5">
   <div className="space-y-2"><Label htmlFor="account-username">New username</Label><Input id="account-username" name="username" value={next} onChange={e=>{setNext(e.target.value);setError("");}} maxLength={48} autoComplete="username" disabled={saving} required/></div>
   <div className="space-y-2"><Label htmlFor="account-password">Current password</Label><Input id="account-password" name="password" type="password" value={password} onChange={e=>{setPassword(e.target.value);setError("");}} autoComplete="current-password" disabled={saving} required/></div>
   {error&&<p className="text-sm text-destructive" role="alert">{error}</p>}
  </div>
  <DialogFooter><Button type="button" variant="outline" onClick={()=>onOpenChange(false)} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving||!next.trim()||!password}>{saving?"Saving":"Save"}</Button></DialogFooter>
 </form></DialogContent></Dialog>;
}
