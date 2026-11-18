import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {currentNetwork} from './context.ts';
import {targetEnvironment} from '../traffic/network.ts';
export const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export interface IsolationOptions{mounts?:string[];envKeys?:string[];marker?:string;exports?:{socket:string;port:number}[]}
export function targetSpawn<T extends {command:string;cwd:string;env:NodeJS.ProcessEnv}>(input:T,options:IsolationOptions={}):T{
 const scope=currentNetwork();
 if(scope?.mode!=='jump')return {...input,env:{...input.env,...targetEnvironment()}};
 if(!scope.taskId||!scope.unixSocket||!scope.route)throw new Error("The springboard mode command needs to be associated with a test task");
 if(process.platform!=='linux'||!existsSync('/usr/bin/unshare')||!existsSync('/usr/bin/setpriv'))throw new Error("The current environment does not support springboard command isolation");
 const gateway=new URL(scope.route.proxy);gateway.hostname='127.0.0.1';gateway.port='18080';
 const env:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin',TERM:input.env.TERM,LANG:input.env.LANG,HOME:input.cwd};
 for(const [key,value]of Object.entries(input.env))if(key.startsWith('TOOL_'))env[key]=value;
 Object.assign(env,targetEnvironment(),{http_proxy:gateway.href,HTTP_PROXY:gateway.href,https_proxy:gateway.href,HTTPS_PROXY:gateway.href,all_proxy:gateway.href,ALL_PROXY:gateway.href,no_proxy:'',NO_PROXY:''});
 env.WORMHOLE_ISOLATED_CHILD_ENV=JSON.stringify(Object.fromEntries((options.envKeys??[]).filter(k=>input.env[k]!==undefined).map(k=>[k,input.env[k]])));
 const helper=fileURLToPath(new URL('./shell-sandbox.py',import.meta.url));
 const runtime=process.env.WORMHOLE_TOOLS_DIR??'/opt/wormhole/tools',trusted=existsSync(runtime)&&statSync(runtime).uid===0&&(statSync(runtime).mode&0o022)===0;
 const config=JSON.stringify({...options,toolsDir:trusted?runtime:'',mounts:[...(options.mounts??[]),...(trusted?[runtime]:[])],packetSocket:scope.packetSocket});
 const command=['/usr/bin/unshare','--mount','--net','--pid','--fork','--kill-child','--propagation','private','/usr/bin/python3',helper,scope.unixSocket,realpathSync(input.cwd),scope.caFile??'',input.command,config,...(options.marker?[options.marker]:[])].map(shellQuote).join(' ');
 return {...input,command,env};
}
export function checkTaskFile(cwd:string,name:unknown){
 if(currentNetwork()?.mode!=='jump'||typeof name!=='string')return;
 const target=path.resolve(cwd,name),base=realpathSync(cwd);let ancestor=target;
 while(!existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
 const resolved=realpathSync(ancestor);
 if(resolved!==base&&!resolved.startsWith(base+path.sep))throw new Error("Springboard mode file operations are limited to the current working directory");
 if(target!==path.resolve(cwd)&&!target.startsWith(path.resolve(cwd)+path.sep))throw new Error("Springboard mode file operations are limited to the current working directory");
}
