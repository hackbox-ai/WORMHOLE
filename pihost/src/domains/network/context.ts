import {AsyncLocalStorage} from 'node:async_hooks';
import type {TargetRoute} from '../traffic/network.ts';
export interface NetworkScope {
 taskId?:number;mode:'standard'|'jump';channelId?:number;name?:string;
 route?:TargetRoute;unixSocket?:string;packetSocket?:string;workdir?:string;caFile?:string;upstream?:string;authorize?:(url:URL)=>Promise<void>;
}
export const networkScope=new AsyncLocalStorage<NetworkScope>();
let provider:((taskId?:number,humanBrowser?:boolean)=>Promise<NetworkScope>)|undefined;
export function bindNetworkProvider(value:typeof provider){provider=value;}
export async function inTaskNetwork<T>(taskId:number|undefined,fn:()=>Promise<T>):Promise<T>{
 if(!provider)return fn();
 const scope=await provider(taskId);
 return networkScope.run(scope,fn);
}
export async function taskNetworkScope(taskId?:number,humanBrowser=false){return provider?provider(taskId,humanBrowser):undefined;}
export function currentNetwork(){return networkScope.getStore();}

export async function networkGuidance(taskId?:number){
 const scope=await taskNetworkScope(taskId);
 if(scope?.mode!=='jump')return '';
 return "\nNetwork Mode: Springboard Proxy."+(taskId?"The network channel bound to this task is selected by the host, and it is prohibited to change the outlet by yourself.":"Target access needs to be associated with a test task first.")+"Target requests prefer http_request and task_browser. Bash and native MCP execute on task-isolated networks; full network channels support TCP, UDP, ICMP, and port probing. HTTP and JS encryption and decryption requests follow the task collection link. Channels that are not full network enabled provide access only to proxy-compatible clients. If the channel is offline or the network tool is not suitable, the execution conditions are insufficient and cannot be considered as the target service does not exist, the port is closed, or the vulnerability is negative. Continue to save local evidence and reports, and mission time limits are still in effect.\n";
}
