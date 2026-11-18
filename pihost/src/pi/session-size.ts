import {readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
/** Decide before SessionManager loads a JSONL file. Never edit SDK checkpoints. */
export async function workerSessionTooLarge(directory:string,maximum:number):Promise<boolean>{
  let latest:{mtime:number;bytes:number}|undefined;
  for(const name of await readdir(directory)){
    if(!name.endsWith('.jsonl'))continue;
    const info=await lstat(path.join(directory,name));if(!info.isFile()||info.isSymbolicLink())continue;
    if(!latest||info.mtimeMs>latest.mtime)latest={mtime:info.mtimeMs,bytes:info.size};
  }
  return (latest?.bytes??0)>maximum;
}
