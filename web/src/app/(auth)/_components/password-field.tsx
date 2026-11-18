"use client";
import {useState} from "react";
import {Eye,EyeOff,ArrowUp} from "lucide-react";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";

export function PasswordField({id,label,value,onChange,autoComplete="current-password",autoFocus=false,disabled=false,invalid=false,placeholder="Please enter the login password"}:{
 id:string;label:string;value:string;onChange:(value:string)=>void;autoComplete?:"current-password"|"new-password";autoFocus?:boolean;disabled?:boolean;invalid?:boolean;placeholder?:string;
}){
 const [visible,setVisible]=useState(false),[caps,setCaps]=useState(false);
 return <div className="wormhole-entry-field">
  <Label htmlFor={id}>{label}</Label>
  <div className="wormhole-entry-input">
   <Input id={id} name={id} type={visible?"text":"password"} value={value} onChange={e=>onChange(e.target.value)}
    autoComplete={autoComplete} autoFocus={autoFocus} disabled={disabled} required aria-invalid={invalid}
    aria-describedby={caps?id+"-caps":undefined} placeholder={placeholder}
    onKeyDown={e=>setCaps(e.getModifierState("CapsLock"))} onKeyUp={e=>setCaps(e.getModifierState("CapsLock"))} onBlur={()=>setCaps(false)}/>
   <button type="button" className="wormhole-entry-reveal" aria-label={(visible?"Hide":"Display")+label} aria-pressed={visible} disabled={disabled}
    onMouseDown={e=>e.preventDefault()} onClick={()=>setVisible(v=>!v)}>{visible?<EyeOff/>:<Eye/>}</button>
  </div>
  {caps&&<p id={id+"-caps"} className="wormhole-entry-caps" role="status"><ArrowUp/>Caps Lock is on</p>}
 </div>;
}
