/** Seekable artifact JSON. Each frame is independently checked against a manifest
 * pinned in PostgreSQL. Offsets are UTF-16 characters, matching the tool API. */
import {open,lstat,type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compress,decompress,sha256,MAX_BODY_BYTES,type StorageCodec} from './codec.ts';

export const ARTIFACT_FRAME_CHARS=65536;
export const ARTIFACT_FRAMING_THRESHOLD=1024*1024;
const MAGIC=Buffer.from('GTYART02'),MAX_MANIFEST=4*1024*1024;
interface Frame {offset:number;characters:number;rawBytes:number;storedBytes:number;rawHash:string;storedHash:string}
interface Manifest {format:'wormhole-artifact';version:2;codec:StorageCodec;hash:string;rawBytes:number;characters:number;frames:Frame[]}
export interface ArtifactIdentity {hash:string;codec:StorageCodec;rawBytes:number;manifestHash:string}
const hashPattern=/^[a-f0-9]{64}$/;
const whole=(n:number)=>Number.isSafeInteger(n)&&n>=0;
async function exact(handle:FileHandle,length:number,position:number):Promise<Buffer>{
  const result=Buffer.alloc(length);let offset=0;
  while(offset<length){const read=await handle.read(result,offset,length-offset,position+offset);if(!read.bytesRead)throw new Error('truncated artifact file');offset+=read.bytesRead;}
  return result;
}

export async function writeArtifactFrames(file:string,text:string,codec:StorageCodec){
  const rawBytes=Buffer.byteLength(text);if(rawBytes>MAX_BODY_BYTES)throw new Error('storage body exceeds maximum size');
  const manifest:Manifest={format:'wormhole-artifact',version:2,codec,hash:'',rawBytes,characters:text.length,frames:[]};
  const digest=createHash('sha256'),handle=await open(file,'wx',0o600);let storedBytes=0;
  try{
    for(let start=0;start<text.length;){
      let end=Math.min(text.length,start+ARTIFACT_FRAME_CHARS);
      if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
      const raw=Buffer.from(text.slice(start,end)),packed=await compress(raw,codec);digest.update(raw);
      await handle.writeFile(packed);
      manifest.frames.push({offset:storedBytes,characters:end-start,rawBytes:raw.length,storedBytes:packed.length,rawHash:sha256(raw),storedHash:sha256(packed)});
      storedBytes+=packed.length;start=end;
    }
    manifest.hash=digest.digest('hex');const encoded=Buffer.from(JSON.stringify(manifest));
    if(encoded.length>MAX_MANIFEST)throw new Error('artifact manifest exceeds maximum size');
    const trailer=Buffer.alloc(12);MAGIC.copy(trailer);trailer.writeUInt32BE(encoded.length,8);
    await handle.writeFile(encoded);await handle.writeFile(trailer);await handle.sync();
    return {hash:manifest.hash,codec,rawBytes,storedBytes:storedBytes+encoded.length+12,manifestHash:sha256(encoded)};
  }finally{await handle.close();}
}

export class ArtifactFrameReader {
  readonly stats={bytesRead:0,framesRead:0,decompressedBytes:0};
  private starts:number[]=[];
  private constructor(private handle:FileHandle,readonly manifest:Manifest){
    let start=0;for(const frame of manifest.frames){this.starts.push(start);start+=frame.characters;}
  }
  static async open(file:string,expected:ArtifactIdentity){
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BODY_BYTES+8*1024*1024||info.size<12)throw new Error('invalid artifact file');
    const handle=await open(file,'r');
    try{
      const trailer=await exact(handle,12,info.size-12),size=trailer.readUInt32BE(8);
      if(!trailer.subarray(0,8).equals(MAGIC)||size<1||size>MAX_MANIFEST||size>info.size-12)throw new Error('invalid artifact manifest');
      const bytes=await exact(handle,size,info.size-12-size);
      if(sha256(bytes)!==expected.manifestHash)throw new Error('artifact manifest checksum mismatch');
      const m=JSON.parse(bytes.toString('utf8')) as Manifest;
      if(m.format!=='wormhole-artifact'||m.version!==2||m.hash!==expected.hash||m.codec!==expected.codec||m.rawBytes!==expected.rawBytes||
        !hashPattern.test(m.hash)||!whole(m.rawBytes)||m.rawBytes>MAX_BODY_BYTES||!whole(m.characters)||!Array.isArray(m.frames)||m.frames.length>8192)throw new Error('invalid artifact manifest');
      let offset=0,rawBytes=0,characters=0;
      for(const frame of m.frames){
        if(frame.offset!==offset||!whole(frame.characters)||frame.characters<1||frame.characters>ARTIFACT_FRAME_CHARS||
          !whole(frame.rawBytes)||frame.rawBytes<1||frame.rawBytes>ARTIFACT_FRAME_CHARS*4||!whole(frame.storedBytes)||frame.storedBytes<1||
          frame.storedBytes>frame.rawBytes+1024*1024||!hashPattern.test(frame.rawHash)||!hashPattern.test(frame.storedHash))throw new Error('invalid artifact frame');
        offset+=frame.storedBytes;rawBytes+=frame.rawBytes;characters+=frame.characters;
      }
      if(offset!==info.size-12-size||rawBytes!==m.rawBytes||characters!==m.characters)throw new Error('invalid artifact frame totals');
      const reader=new ArtifactFrameReader(handle,m);reader.stats.bytesRead=12+size;return reader;
    }catch(error){await handle.close();throw error;}
  }
  async close(){await this.handle.close();}
  private async frame(index:number){
    const frame=this.manifest.frames[index]!,stored=await exact(this.handle,frame.storedBytes,frame.offset);
    this.stats.bytesRead+=stored.length;this.stats.framesRead++;
    if(sha256(stored)!==frame.storedHash)throw new Error('artifact frame checksum mismatch');
    const raw=await decompress(stored,this.manifest.codec,frame.rawBytes);this.stats.decompressedBytes+=raw.length;
    if(sha256(raw)!==frame.rawHash)throw new Error('artifact raw checksum mismatch');
    const text=new TextDecoder('utf8',{fatal:true}).decode(raw);if(text.length!==frame.characters)throw new Error('artifact character length mismatch');
    return {raw,text};
  }
  /** Full verification is used once before publishing, not for every page. */
  async verify(){
    const digest=createHash('sha256');for(let index=0;index<this.manifest.frames.length;index++)digest.update((await this.frame(index)).raw);
    if(digest.digest('hex')!==this.manifest.hash)throw new Error('artifact full checksum mismatch');
  }
  async restoreText(){
    const digest=createHash('sha256'),parts:string[]=[];
    for(let index=0;index<this.manifest.frames.length;index++){const {raw,text}=await this.frame(index);digest.update(raw);parts.push(text);}
    if(digest.digest('hex')!==this.manifest.hash)throw new Error('artifact full checksum mismatch');
    return parts.join('');
  }
  async read(offset:number,limit:number){
    if(!whole(offset)||!whole(limit)||limit<1||limit>16000)throw new Error('invalid artifact range');
    const total=this.manifest.characters,start=Math.min(offset,total),end=Math.min(start+limit,total);
    if(start===end)return {hash:this.manifest.hash,offset:start,nextOffset:end,totalCharacters:total,done:true,text:''};
    let low=0,high=this.starts.length-1;
    while(low<high){const middle=Math.ceil((low+high)/2);if(this.starts[middle]!<=start)low=middle;else high=middle-1;}
    let result='',actualStart=start,actualEnd=end;
    for(let index=low;index<this.starts.length&&this.starts[index]!<end;index++){
      const frameStart=this.starts[index]!,{text}=await this.frame(index);
      let from=Math.max(0,start-frameStart),to=Math.min(text.length,end-frameStart);
      if(index===low&&from>0&&/[\uDC00-\uDFFF]/.test(text[from]??'')){from--;actualStart--;}
      if(to<text.length&&/[\uDC00-\uDFFF]/.test(text[to]??'')){
        if(to-from===1){to++;actualEnd++;}else{to--;actualEnd--;}
      }
      result+=text.slice(from,to);
    }
    return {hash:this.manifest.hash,offset:actualStart,nextOffset:actualEnd,totalCharacters:total,done:actualEnd===total,text:result};
  }
}
