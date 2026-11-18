import {Worker} from 'node:worker_threads';
export interface TemplateResult{fields:string[];syntaxError?:string;error?:string;rendered?:string}
let worker:Worker|undefined,ready:Promise<void>|undefined,serial=0;
const pending=new Map<number,{resolve:(r:TemplateResult)=>void;reject:(e:Error)=>void}>();
function start():Promise<void>{
 if(ready)return ready;
 const current=new Worker(new URL('./templates/worker.mjs',import.meta.url));worker=current;
 ready=new Promise<void>((resolve,reject)=>{
  current.on('message',(m:any)=>{
   if(m.ready){resolve();if(!pending.size)current.unref();return;}
   const item=pending.get(m.id);if(!item)return;pending.delete(m.id);
   if(m.error)item.reject(new Error(m.error));else item.resolve(m.result);
   if(!pending.size)current.unref();
  });
  current.on('error',fail);current.on('exit',code=>fail(new Error('template worker exited: '+code)));
  function fail(error:Error){reject(error);for(const item of pending.values())item.reject(error);pending.clear();if(worker===current){worker=undefined;ready=undefined;}}
 });
 return ready;
}
export async function inspectTemplate(template:string):Promise<TemplateResult>{return request(template,{},'parse');}
export async function renderTemplate(template:string,values:Record<string,string>):Promise<TemplateResult>{return request(template,values,'render');}
async function request(template:string,values:Record<string,string>,mode:string):Promise<TemplateResult>{
 await start();const id=++serial;
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker!.ref();worker!.postMessage({id,request:{Template:template,Values:values,Mode:mode}});});
}
export async function stopTemplateWorker():Promise<void>{const current=worker;worker=undefined;ready=undefined;await current?.terminate();}
