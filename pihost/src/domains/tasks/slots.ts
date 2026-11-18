/** Primary task budget shared by ordinary runs, chat turns and wrap-up; modeling is independent.
 * Re-entrant leases count a task once; the final lease releases its resources. */
export class TaskSlots {
 private leases=new Map<number,number>();
 private waiters:{id:number;signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(e:unknown)=>void;cancel:()=>void}[]=[];
 constructor(private limit:()=>number=()=>3,private changed:()=>void=()=>{}){}
 get size(){return this.leases.size;}
 get ids(){return [...this.leases.keys()];}
 get capacity(){return Math.max(1,Math.min(3,this.limit()));}
 tryAcquire(id:number):(()=>void)|null {
  if(!this.leases.has(id)&&this.size>=this.capacity)return null;
  this.leases.set(id,(this.leases.get(id)??0)+1);let released=false;
  return ()=>{if(released)return;released=true;const n=(this.leases.get(id)??1)-1;if(n)this.leases.set(id,n);else this.leases.delete(id);this.pump();this.changed();};
 }
 acquire(id:number,signal:AbortSignal):Promise<()=>void>{
  if(signal.aborted)return Promise.reject(signal.reason??new Error("Canceled"));
  const release=this.tryAcquire(id);if(release)return Promise.resolve(release);
  return new Promise((resolve,reject)=>{const waiter={id,signal,resolve,reject,cancel:()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(signal.reason??new Error("Canceled"));}};this.waiters.push(waiter);signal.addEventListener('abort',waiter.cancel,{once:true});});
 }
 private pump(){while(this.waiters.length&&this.size<this.capacity){const w=this.waiters.shift()!;w.signal.removeEventListener('abort',w.cancel);if(w.signal.aborted){w.reject(w.signal.reason);continue;}w.resolve(this.tryAcquire(w.id)!);}}
}
