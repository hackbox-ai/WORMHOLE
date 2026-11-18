import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ArtifactFrameReader,writeArtifactFrames,ARTIFACT_FRAME_CHARS} from '../src/storage/artifact-frames.ts';
import {hasZstd,type StorageCodec} from '../src/storage/codec.ts';

for(const codec of ['identity','gzip',...(hasZstd()?['zstd']:[])] as StorageCodec[])test(`seekable ${codec}: exact JSON, Unicode boundaries and bounded partial decompression`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-artifact-frames-'));
  try{
    const text=JSON.stringify({prefix:'prefix',content:('中文 🧪\r\n\u0000 '+('x'.repeat(31))).repeat(30000),tail:'CRITICAL_TAIL'}),file=path.join(root,'object');
    const identity=await writeArtifactFrames(file,text,codec),reader=await ArtifactFrameReader.open(file,identity);
    try{
      const page=await reader.read(text.length-60,60);assert.equal(page.text,text.slice(page.offset,page.nextOffset));assert.ok(page.text.includes('CRITICAL_TAIL'));
      assert.equal(reader.stats.framesRead,1);assert.ok(reader.stats.decompressedBytes<300000);assert.ok(reader.stats.bytesRead<identity.storedBytes);
      let offset=0,restored='';while(offset<text.length){const page=await reader.read(offset,7777);assert.ok(page.nextOffset>offset);restored+=page.text;offset=page.nextOffset;}
      assert.equal(restored,text);await reader.verify();
      const emoji=text.indexOf('🧪');assert.equal((await reader.read(emoji,1)).text,'🧪','tiny pages must make progress without splitting surrogate pairs');
      assert.equal((await reader.read(emoji+1,1)).text,'🧪');
      assert.equal((await reader.read(text.length+100,10)).text,'');
      await assert.rejects(reader.read(0,16001),/range/);await assert.rejects(reader.read(-1,10),/range/);
    }finally{await reader.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('manifest pinning, corrupt frames and incomplete publication fail explicitly',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-artifact-corrupt-'));
  try{
    const file=path.join(root,'object'),text=JSON.stringify({data:'X'.repeat(ARTIFACT_FRAME_CHARS*4)}),identity=await writeArtifactFrames(file,text,'gzip'),original=await readFile(file);
    await assert.rejects(ArtifactFrameReader.open(file,{...identity,manifestHash:'0'.repeat(64)}),/checksum/);
    const h=await open(file,'r+');try{await h.write(Buffer.from([0]),0,1,0);}finally{await h.close();}
    const reader=await ArtifactFrameReader.open(file,identity);try{await assert.rejects(reader.read(0,20),/checksum/);assert.equal((await reader.read(text.length-10,10)).text,text.slice(-10));}finally{await reader.close();}
    await writeFile(file,original.subarray(0,original.length-1));await assert.rejects(ArtifactFrameReader.open(file,identity),/manifest/);
    await writeFile(file,original);const wrong=await ArtifactFrameReader.open(file,identity);try{await wrong.verify();}finally{await wrong.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});
