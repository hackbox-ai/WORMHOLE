/** Local, deterministic synthetic comparison. Never calls a model or target. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {packBody,unpackBody,sha256} from '../src/storage/codec.ts';
import {writeArtifactFrames,ArtifactFrameReader} from '../src/storage/artifact-frames.ts';
const [output]=process.argv.slice(2);if(!output)throw new Error('expected NEW_REPORT_JSON');
const root=await mkdtemp(path.join(tmpdir(),'wormhole-performance-benchmark-'));
try{
  const lines=Array.from({length:40000},(_,i)=>JSON.stringify({id:i,status:i%7?'observed':'negative',text:"Fixed tool log Chinese 🧪 "+('common evidence prefix '.repeat(9)),value:sha256(Buffer.from(String(i)))}));
  const value={content:[{type:'text',text:lines.join('\n')+'\nCRITICAL_TAIL'}],details:{}},text=JSON.stringify(value),packed=await packBody(value);
  const file=path.join(root,'framed'),framed=await writeArtifactFrames(file,text,packed.codec),pages=96;
  const offsets=Array.from({length:pages},(_,i)=>Math.floor((text.length-8000)*i/(pages-1)));
  const oldSamples:number[]=[],newSamples:number[]=[];let decompressedBytes=0,readBytes=0,framesRead=0;
  for(const offset of offsets){const start=performance.now(),restored=JSON.stringify(await unpackBody(packed));oldSamples.push(performance.now()-start);assert.equal(restored.slice(offset,offset+8000),text.slice(offset,offset+8000));}
  for(const offset of offsets){
    const start=performance.now(),reader=await ArtifactFrameReader.open(file,framed);
    try{const page=await reader.read(offset,8000);assert.equal(page.text,text.slice(page.offset,page.nextOffset));newSamples.push(performance.now()-start);decompressedBytes+=reader.stats.decompressedBytes;readBytes+=reader.stats.bytesRead;framesRead+=reader.stats.framesRead;}finally{await reader.close();}
  }
  const reader=await ArtifactFrameReader.open(file,framed);try{await reader.verify();}finally{await reader.close();}
  const stats=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return {totalMs:values.reduce((a,b)=>a+b,0),p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)]};};
  const report={format:'wormhole-performance-benchmark',version:1,capturedAt:new Date().toISOString(),node:process.version,platform:process.platform,
    workload:{synthetic:true,rows:40000,pages,limit:8000,rawBytes:packed.rawBytes,codec:packed.codec,sha256:packed.hash},
    legacy:{...stats(oldSamples),storedBytes:packed.bytes.length,decompressedBytes:pages*packed.rawBytes},
    framed:{...stats(newSamples),storedBytes:framed.storedBytes,decompressedBytes,readBytes,framesRead},
    correctness:{fullHash:true,allRequestedPages:true},
    limitations:['Synthetic artifact pagination only; not task or model latency','Legacy compressed input is already in memory; framed timing includes open, manifest validation and file reads','Independent frames add metadata and can reduce compression across boundaries','OS filesystem cache is not cleared']};
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
}finally{await rm(root,{recursive:true,force:true});}
