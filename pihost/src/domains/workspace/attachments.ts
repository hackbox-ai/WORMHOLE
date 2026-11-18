import {mkdir,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import type {MultipartFile} from './multipart.ts';
export interface ChatAttachment {name:string;path:string;size:number;abs?:string}
export const MAX_CHAT_UPLOAD=128<<20;
export function composeAgentMessage(msg:string,attachments:ChatAttachment[],baseDir:string):string {
  if(!attachments.length)return msg;
  return msg+"\n\n[Attachments uploaded by users] (absolute path, use Read/Bash to view if necessary):"+attachments.map(a=>'\n- '+path.join(baseDir,a.path)+'（'+humanBytes(a.size)+'）').join('');
}
function humanBytes(n:number):string{return n>=1<<20?(n/(1<<20)).toFixed(1)+' MB':n>=1<<10?(n/(1<<10)).toFixed(1)+' KB':n+' B';}
export async function saveAttachments(dir:string,files:MultipartFile[]):Promise<ChatAttachment[]> {
  await mkdir(dir,{recursive:true,mode:0o755});const out:ChatAttachment[]=[];
  for(const file of files){const name=path.posix.basename(file.name);if(!name||name==='.'||name==='..'||/[\/\\]/.test(name))continue;
    // Go filepath.Ext treats a leading dot as the extension as well.
    const ext=name.includes('.')?name.slice(name.lastIndexOf('.')):'',stem=name.slice(0,name.length-ext.length);
    for(let i=0;;i++){const base=i?`${stem}-${i}${ext}`:name,dest=path.join(dir,base);
      try{await copyFile(file.tempPath,dest,constants.COPYFILE_EXCL);out.push({name:base,path:'uploads/'+base,size:file.size,abs:dest});break;}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }
  }return out;
}
export function validAttachments(input:unknown):ChatAttachment[] {
  if(input==null)return [];if(!Array.isArray(input))throw new Error("attachments must be an array");
  return input.map(a=>{if(!a||typeof a!=='object'||Array.isArray(a))throw new Error("Attachment format error");
    for(const key of ['path','name','abs'])if(a[key]!=null&&typeof a[key]!=='string')throw new Error("Attachment format error");
    if(a.size!=null&&!Number.isSafeInteger(a.size))throw new Error("Attachment format error");
    return {name:a.name??'',path:a.path??'',size:a.size??0,...(typeof a.abs==='string'&&a.abs?{abs:a.abs}:{})};});
}
