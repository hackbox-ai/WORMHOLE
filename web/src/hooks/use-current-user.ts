"use client";
import {useEffect,useState} from "react";
import {auth,AUTH_CHANGED_EVENT,type CurrentUser} from "@/lib/auth";
import {api} from "@/lib/api";
const FALLBACK:CurrentUser={id:"1",name:"WORMHOLE",username:"WORMHOLE",email:"",avatar:"",role:"operator"};
export function useCurrentUser():CurrentUser{
 const [user,setUser]=useState<CurrentUser>(FALLBACK);
 useEffect(()=>{
  let disposed=false,version=0;
  function refresh(){
   const current=auth.getCurrentUser();if(current)setUser(current);
   const request=++version;
   if(auth.getToken())void api.account().then(({username})=>{if(!disposed&&request===version&&username)setUser(u=>({...u,name:username,username}));}).catch(()=>{});
  }
  function storage(e:StorageEvent){if(e.key==="wormhole_token"||e.key===null)refresh();}
  refresh();window.addEventListener(AUTH_CHANGED_EVENT,refresh);window.addEventListener("storage",storage);
  return()=>{disposed=true;version++;window.removeEventListener(AUTH_CHANGED_EVENT,refresh);window.removeEventListener("storage",storage);};
 },[]);
 return user;
}
