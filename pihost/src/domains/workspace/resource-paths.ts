import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdir} from 'node:fs/promises';
import type {Pool} from 'pg';
export async function registerTaskResource(pool:Pool,taskId:number,kind:'sessions'|'runtime',file:string){
 if(!Number.isSafeInteger(taskId)||taskId<=0)throw new Error('invalid resource task');
 await pool.query("INSERT INTO task_resource_paths(task_id,kind,path) SELECT id,$2,$3 FROM tasks WHERE id=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING",[taskId,kind,path.resolve(file)]);
}
export function managedResourceRoot(dataDir:string,kind:string,file:string):string{
 const absolute=path.resolve(file),sessions=path.resolve(dataDir,'pi-sessions');
 if(kind==='sessions'&&path.dirname(absolute)===sessions)return sessions;
 if(kind==='runtime'&&path.dirname(absolute)===path.resolve(tmpdir())&&/^wormhole-browser-(?:profile|launch)-[A-Za-z0-9_-]+$/.test(path.basename(absolute)))return path.resolve(tmpdir());
 throw new Error("Resource path is not in managed scope");
}
export async function taskToolEnvironment(cwd:string){
 const root=path.join(cwd,'.runtime');
 const temp=path.join(root,'tmp'),cache=path.join(root,'cache'),npm=path.join(root,'npm');
 await Promise.all([temp,cache,npm].map(p=>mkdir(p,{recursive:true,mode:0o700})));
 return {TMPDIR:temp,TMP:temp,TEMP:temp,XDG_CACHE_HOME:cache,npm_config_cache:npm};
}
