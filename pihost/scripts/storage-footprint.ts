import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
async function walk(directory:string):Promise<{bytes:number;files:number}>{
  let bytes=0,files=0;
  for(const name of await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
    const file=path.join(directory,name),info=await lstat(file);if(info.isSymbolicLink())continue;
    if(info.isDirectory()){const result=await walk(file);bytes+=result.bytes;files+=result.files;}else if(info.isFile()){bytes+=info.size;files++;}
  }return {bytes,files};
}
const report:Record<string,unknown>={};for(const bucket of ['pi-sessions','workspace','storage'])report[bucket]=await walk(path.join(config.dataDir,bucket));
console.log(JSON.stringify(report));
