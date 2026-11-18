/** Session leases keep stateful REA contexts separate and bound JVM residency. */
export class AnalysisSlots{
 private limit=1;private active=0;private waiters:{signal?:AbortSignal;resolve:(release:()=>void)=>void;reject:(e:Error)=>void;abort:()=>void}[]=[];
 configure(limit:number){this.limit=limit;this.pump();}
 status(){return {limit:this.limit,active:this.active,queued:this.waiters.length};}
 private pump(){while(this.active<this.limit&&this.waiters.length){const item=this.waiters.shift()!;item.signal?.removeEventListener('abort',item.abort);if(item.signal?.aborted){item.reject(new Error("Analysis canceled"));continue;}this.active++;let released=false;item.resolve(()=>{if(released)return;released=true;this.active--;this.pump();});}}
 acquire(signal?:AbortSignal){signal?.throwIfAborted();return new Promise<()=>void>((resolve,reject)=>{const item={signal,resolve,reject,abort:()=>{const index=this.waiters.indexOf(item);if(index>=0)this.waiters.splice(index,1);reject(new Error("Analysis canceled"));}};signal?.addEventListener('abort',item.abort,{once:true});this.waiters.push(item);this.pump();});}
}
export const analysisSlots=new AnalysisSlots();
