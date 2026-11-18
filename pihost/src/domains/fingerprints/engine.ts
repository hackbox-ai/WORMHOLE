import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {FingerprintRule,Diagnostic,FingerprintMatch} from './rules.ts';
export interface MatchMaterial{url:string;method:string;response_base64:string;favicon_base64?:string}
export interface EngineReply{snapshot:string;diagnostics?:Diagnostic[];matches?:FingerprintMatch[];missing?:string[];error?:string}
export interface MatchingEngine{load(id:string,rules:FingerprintRule[]):Promise<EngineReply>;match(id:string,material:MatchMaterial):Promise<EngineReply>;close():void}
export class FingerprintEngine implements MatchingEngine{
 private child:ChildProcessWithoutNullStreams|null=null;private sequence=0;private pending=new Map<string,{resolve:(r:EngineReply)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private binary=process.env.WORMHOLE_FINGERPRINT_ENGINE||path.resolve(import.meta.dirname,'../../../vendor/fingerprint/fingerprint-engine'+(process.platform==='win32'?'.exe':''));
 available(){return existsSync(this.binary);}
 private start(){if(this.child)return this.child;if(!existsSync(this.binary))throw new Error("Fingerprint engine not built, please run pihost/scripts/build-fingerprint-engine.ps1 or .sh");
  const child=spawn(this.binary,[],{stdio:'pipe',windowsHide:true});this.child=child;
  child.stderr.on('data',()=>{});const reader=createInterface({input:child.stdout});
  reader.on('line',line=>{try{const r=JSON.parse(line),pending=this.pending.get(String(r.id));if(!pending)return;this.pending.delete(String(r.id));clearTimeout(pending.timer);if(r.error)pending.reject(new Error(r.error));else pending.resolve(r);}catch{this.stop(new Error("Fingerprint engine protocol error"));}});
  child.on('error',e=>this.stop(e));child.on('exit',()=>{if(this.child===child)this.stop(new Error("Fingerprint engine has exited"));});return child;
 }
 private stop(error:Error){const child=this.child;this.child=null;child?.kill();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();}
 private call(data:Record<string,unknown>):Promise<EngineReply>{return new Promise((resolve,reject)=>{try{const child=this.start(),id=String(++this.sequence),timer=setTimeout(()=>this.stop(new Error("Fingerprint matching timeout")),30000);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({...data,id})+'\n',e=>{if(e)this.stop(e)});}catch(e){reject(e)}});}
 load(snapshot:string,rules:FingerprintRule[]){return this.call({action:'load',snapshot,rules});}
 match(snapshot:string,material:MatchMaterial){return this.call({action:'match',snapshot,material});}
 close(){this.stop(new Error("Fingerprint engine is down"));}
}
