"use client";
import {useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {api} from "@/lib/api";
import {auth} from "@/lib/auth";

export function authErrorMessage(error:unknown):string{
 const status=(error as {status?:number})?.status;
 if(status===401)return "Incorrect account or password";
 if(status===429)return "Requests are too frequent, please try again later.";
 if(status&&status>=500)return "Service is temporarily unavailable, please try again later";
 if(["AbortError","TimeoutError"].includes((error as Error)?.name))return "Connection timed out, please try again";
 if(error instanceof TypeError)return "Connection failed, please check the network and try again";
 return error instanceof Error?error.message:"The operation is not completed, please try again";
}
export function useAuthEntry(mode:"login"|"setup"){
 const router=useRouter(),[state,setState]=useState<"checking"|"ready"|"unavailable">("checking"),[checkError,setCheckError]=useState(""),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let disposed=false;const abort=new AbortController();
  setState("checking");setCheckError("");
  if(mode==="login"){
   const token=auth.getToken();
   if(token){auth.setToken(token);window.location.replace("/function/tasks");return;}
  }
  const timeout=setTimeout(()=>abort.abort(),10000);
  api.authStatus(abort.signal).then(({initialized})=>{
   if(disposed)return;
   if(mode==="login"&&!initialized){router.replace("/setup");return;}
   if(mode==="setup"&&initialized){router.replace("/login");return;}
   setState("ready");
  }).catch(error=>{if(!disposed){setState("unavailable");setCheckError(authErrorMessage(error));}}).finally(()=>clearTimeout(timeout));
  return()=>{disposed=true;clearTimeout(timeout);abort.abort();};
 },[mode,router,attempt]);
 return {state,checkError,retry:()=>setAttempt(v=>v+1)};
}
