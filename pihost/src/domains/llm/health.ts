/** one authoritative registry per product database. */
import type {Pool} from 'pg';
import {goLocalTime} from '../findings/reads.ts';
export interface HealthState {fails:number;trips:number;openUntil:number;lastError:string;lastAt:number}
const fresh=():HealthState=>({fails:0,trips:0,openUntil:0,lastError:'',lastAt:0});
export class HealthRegistry {
 private states=new Map<number,HealthState>();
 private writeTail:Promise<unknown>=Promise.resolve();
 private initialized?:Promise<void>;
 private softTrip=0;
 private cooldown=0;
 constructor(readonly pool:Pool,readonly now:()=>number=Date.now){}
 async load(){return this.initialized??=(async()=>{
  try{const rows=(await this.pool.query('SELECT * FROM llm_profile_health WHERE open_until>now()')).rows;
   for(const r of rows)this.restore(Number(r.profile_id),{fails:r.fails,trips:r.trips,openUntil:new Date(r.open_until).getTime(),lastError:r.last_error??'',lastAt:new Date(r.last_at).getTime()});
  }catch(e){console.warn('[llmpool] health restore failed',e);}
 })();}
 restore(id:number,state:HealthState){this.states.set(id,{...state});}
 get(id:number){return {...(this.states.get(id)??fresh())};}
 snapshot(){return new Map([...this.states].map(([id,s])=>[id,{...s}]));}
 open(id:number){return this.get(id).openUntil>this.now();}
 setPolicy(attempts=0,intervalMs=0){this.softTrip=attempts;this.cooldown=intervalMs;}
 private persist(fn:()=>Promise<unknown>){this.writeTail=this.writeTail.then(fn).catch(e=>console.warn('[llmpool] health persistence failed',e));}
 async flush(){await this.writeTail;}
 pass(id:number){const s=this.states.get(id);if(!s||!s.fails&&!s.trips&&!s.openUntil)return;this.reset(id);}
 reset(id:number){this.states.delete(id);this.persist(()=>this.pool.query('DELETE FROM llm_profile_health WHERE profile_id=$1',[id]));}
 resetAll(){const ids=[...this.states.keys()];for(const id of ids)this.reset(id);this.persist(()=>this.pool.query('DELETE FROM llm_profile_health'));}
 trip(id:number,error:string,hard:boolean){
  const s=this.get(id);s.fails++;s.lastError=error;s.lastAt=this.now();const threshold=this.softTrip===0?3:Math.max(0,this.softTrip);let tripped=false;
  if(hard||threshold>0&&s.fails>=threshold){s.trips++;s.openUntil=this.now()+(this.cooldown>0?this.cooldown:[60000,300000,1800000][Math.min(s.trips-1,2)]!);s.fails=0;tripped=true;}
  this.states.set(id,s);this.persist(()=>this.pool.query(`INSERT INTO llm_profile_health(profile_id,fails,trips,open_until,last_error,last_at) VALUES($1,$2,$3,$4,$5,now())
   ON CONFLICT(profile_id) DO UPDATE SET fails=EXCLUDED.fails,trips=EXCLUDED.trips,open_until=EXCLUDED.open_until,last_error=EXCLUDED.last_error,last_at=now()`,[id,s.fails,s.trips,s.openUntil?new Date(s.openUntil):null,s.lastError]));return tripped;
 }
 status(id:number){const s=this.get(id);return {state:this.open(id)?'tripped':s.fails>0?'degraded':'ok',fails:s.fails,trips:s.trips,cooldown_secs:this.open(id)?Math.floor((s.openUntil-this.now())/1000)+1:0,
  ...(s.lastError?{last_error:s.lastError}:{}),...(s.lastAt?{last_at:goLocalTime(new Date(s.lastAt).toISOString().replace(/\.\d{3}Z$/,'Z'))}:{}),};}
}
const registries=new WeakMap<Pool,HealthRegistry>();
export async function healthRegistry(pool:Pool){let registry=registries.get(pool);if(!registry){registry=new HealthRegistry(pool);registries.set(pool,registry);}await registry.load();return registry;}
