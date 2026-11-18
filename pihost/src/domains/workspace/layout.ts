/** Same work tree as agent/worker.go ensureRunDir and server/chatupload.go. */
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {PihostConfig} from '../../config.ts';
export const workspaceRoot=(config:PihostConfig)=>path.resolve(config.dataDir,'workspace');
export function taskWorkDir(config:PihostConfig,taskId:number,intentId=0):string {
  const base=path.join(workspaceRoot(config),'tasks',String(taskId));return intentId>0?path.join(base,'i'+intentId):base;
}
export const conversationWorkDir=(config:PihostConfig,id:number)=>path.join(workspaceRoot(config),'sessions',String(id));
export async function ensureWorkDir(dir:string):Promise<string>{await mkdir(dir,{recursive:true,mode:0o755});return dir;}
export function artifactSpec(dir:string,worker=false):string {
  return worker?`

**Intermediate product output protocol**: All intermediate products such as scripts, payloads, captured response bodies, temporary data, etc. are all written to the exclusive working directory of this purpose. ${dir}** (It has been automatically created, just write it here with the relative path, no need to manually create the directory). The reproduction scripts, screenshots and report attachments that need to be retained are written into the evidence/ subdirectory, and the path is written in the discovery record; the discardable intermediate files are written into the tmp/ subdirectory - **Do not write /tmp, do not use other absolute paths**.`:
    `

**Intermediate product output protocol**: All intermediate products such as scripts, payloads, captured response bodies, and temporary data are all written to the working directory of this task. ${dir}** (The relative path is written here, the absolute path can also be used). The reproduction scripts, screenshots and report attachments that need to be retained are written into the evidence/ subdirectory, and the path is written in the discovery record; the discardable intermediate files are written into the tmp/ subdirectory - **Do not write /tmp, do not use other absolute paths**.`;
}
