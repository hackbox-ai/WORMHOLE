/** Streaming multipart parser. Complete parsing precedes destination writes.
 * https://github.com/mscdex/busboy -- temporary files removed on every exit. */
import busboy from 'busboy';
import {createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage} from 'node:http';
export interface MultipartFile {name:string;size:number;tempPath:string}
export async function parseUpload(req:IncomingMessage,maxBytes:number):Promise<{files:MultipartFile[];cleanup():Promise<void>}> {
  const contentType=req.headers['content-type']??'';
  if(!/^multipart\/form-data\b/i.test(contentType))throw new Error("request Content-Type isn't multipart/form-data");
  if(!/;\s*boundary=/i.test(contentType))throw new Error('no multipart boundary param in Content-Type');
  const dir=await mkdtemp(path.join(tmpdir(),'pihost-upload-')),files:MultipartFile[]=[],writes:Promise<void>[]=[];
  const cleanup=()=>rm(dir,{recursive:true,force:true});
  let parser:ReturnType<typeof busboy>,bytes=0;
  try{parser=busboy({headers:req.headers,defParamCharset:'utf8',preservePath:true,limits:{fieldSize:32<<20,fieldNameSize:1<<20,headerPairs:10000}});}catch(e){await cleanup();throw e;}
  parser.on('file',(field,stream,info)=>{
    if(field!=='file'||!info.filename){stream.resume();return;}
    const file={name:info.filename,size:0,tempPath:path.join(dir,String(files.length))};files.push(file);
    stream.on('data',(chunk:Buffer)=>file.size+=chunk.length);
    const writing=pipeline(stream,createWriteStream(file.tempPath,{mode:0o644}));writes.push(writing);writing.catch(e=>parser.destroy(e));
  });
  const counter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maxBytes?new Error('http: request body too large'):null,chunk);}});
  const aborted=()=>counter.destroy(new Error('upload disconnected'));
  req.once('aborted',aborted);req.once('error',aborted);
  const parsing=pipeline(counter,parser);req.pipe(counter);
  try{await parsing;await Promise.all(writes);return {files,cleanup};}
  catch(e){req.unpipe(counter);req.resume();await Promise.allSettled(writes);await cleanup();throw e;}
  finally{req.off('aborted',aborted);req.off('error',aborted);}
}
