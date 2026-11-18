import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {compress,decompress,packBody,unpackBody,hasZstd,MAX_BODY_BYTES,type StorageCodec} from '../src/storage/codec.ts';
import {packRecordBodies,expandRecordBodies} from '../src/storage/record-body.ts';
import {EventArchiveWriter,readEventArchive,readArchiveManifest,verifyEventArchive,ArchiveRowReader} from '../src/storage/event-archive.ts';

const codecs: StorageCodec[] = ['identity','gzip',...(hasZstd()?['zstd' as const]:[])];
const raw = Buffer.from('中文 🧪\u0000\r\n'.repeat(8000));
test('interleaved worker lookup reuses verified frames, preserves exact JSON and obeys the byte budget',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-interleaved-cache-')),entries:{directory:string;hash:string;lines:string[];blocks:number}[]=[];
  const reader=new ArchiveRowReader(1024*1024,16);
  try{
    for(let worker=0;worker<6;worker++){
      const directory=path.join(root,String(worker)),writer=await EventArchiveWriter.create(directory,'gzip',{},32768),lines=[];
      for(let i=0;i<120;i++){const seq=String(9007199254740993n+BigInt(i*6+worker));const line=`{"seq":"${seq}","payload":{"exact":9007199254740993123,"seq":"nested-must-not-be-used","body":${JSON.stringify('🧪'.repeat(500))}}}`;lines.push(line);await writer.append(line);}
      const manifest=await writer.finish(),hash=createHash('sha256').update(await readFile(path.join(directory,'manifest.json'))).digest('hex');entries.push({directory,hash,lines,blocks:manifest.blocks.length});
    }
    for(let i=0;i<120;i++)for(let worker=0;worker<6;worker++){const entry=entries[worker]!,line=entry.lines[i]!,seq=JSON.parse(line).seq;assert.equal(await reader.read(entry.directory,entry.hash,seq),line);}
    assert.equal(reader.stats.framesRead,entries.reduce((sum,entry)=>sum+entry.blocks,0));assert.ok(reader.stats.hits>600);assert.ok(reader.stats.peakResidentBytes<=reader.byteBudget);
    reader.clear();assert.equal(reader.stats.residentBytes,0);
    const tiny=new ArchiveRowReader(1024,1);for(const entry of entries)assert.equal(await tiny.read(entry.directory,entry.hash,JSON.parse(entry.lines[0]!).seq),entry.lines[0]);assert.equal(tiny.stats.residentBytes,0,'oversize frames are not retained');
    await assert.rejects(reader.read(entries[0]!.directory,'0'.repeat(64),JSON.parse(entries[0]!.lines[0]!).seq),/manifest checksum/);
  }finally{reader.clear();await rm(root,{recursive:true,force:true});}
});
for (const codec of codecs) test(`body ${codec}: exact Unicode/CRLF/NUL bytes, bounded output`, async()=>{
  const bytes=await compress(raw,codec);
  assert.deepEqual(await decompress(bytes,codec,raw.length),raw);
  await assert.rejects(decompress(bytes,codec,raw.length-1));
  await assert.rejects(decompress(bytes,codec,MAX_BODY_BYTES+1),/invalid storage length/);
  if(codec!=='identity')assert.ok(bytes.length<raw.length/5);
});
test('packed bodies verify checksums and preserve distinct protocol and normalized representations',async()=>{
  const values={request_body:'normalized:'+raw.toString(),response_body:'ok',raw_request:'wire:'+raw.toString(),raw_response:'data: 🧪\r\n\r\n'};
  const packed=await packRecordBodies(values),row={id:'1',body_storage:packed.bytes,body_codec:packed.codec,body_raw_bytes:packed.rawBytes,body_sha256:packed.hash};
  const result=await expandRecordBodies(row);
  for(const [key,value]of Object.entries(values))assert.equal(result[key],value);
  assert.equal(result.request_text,values.request_body);assert.equal(result.response_text,values.response_body);
  assert.ok(!('body_storage'in result));assert.ok(packed.bytes.length<packed.rawBytes/5);
  await assert.rejects(expandRecordBodies({...row,body_sha256:'0'.repeat(64)}),/checksum/);
  await assert.rejects(expandRecordBodies({...row,body_codec:'unknown'}),/codec/);
  const old={id:'2',request_text:'legacy',request_body:'legacy',raw_request:null,body_storage:null};
  const legacy=await expandRecordBodies(old);assert.equal(legacy.request_body,'legacy');assert.ok(!('body_storage'in legacy));
});
test('short bodies stay uncompressed, equal strings have one reference, malformed envelopes rejected',async()=>{
  const packed=await packRecordBodies({request_body:'same',response_body:'same',raw_request:'same',raw_response:null});
  assert.equal(packed.codec,'identity');
  const envelope=await unpackBody(packed) as any;
  assert.deepEqual(envelope.strings,['same']);assert.equal(envelope.fields.raw_response,null);
  const bad=await packBody({version:1,strings:['x'],fields:{request_body:99,response_body:null,raw_request:null,raw_response:null}});
  await assert.rejects(expandRecordBodies({body_storage:bad.bytes,body_codec:bad.codec,body_raw_bytes:bad.rawBytes,body_sha256:bad.hash}),/reference/);
});

for(const codec of codecs)test(`archive ${codec}: bounded blocks, full hash, exact rows and selective range`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-codec-'));
  try{
    const directory=path.join(root,'events'),writer=await EventArchiveWriter.create(directory,codec,{taskId:'44'},2048);
    // Source JSON numbers larger than JS safe integers are intentionally never parsed/re-serialized.
    const lines=Array.from({length:30},(_,i)=>`{"seq":"${9007199254740993n+BigInt(i)*3n}","payload":{"exact":9007199254740993123,"text":${JSON.stringify('中🧪'.repeat(150)+i)}}}`);
    for(const line of lines)await writer.append(line);
    const manifest=await writer.finish();assert.ok(manifest.blocks.length>3);
    const restored=[];for await(const line of readEventArchive(directory))restored.push(line);
    assert.deepEqual(restored,lines);
    assert.equal(manifest.rawHash,createHash('sha256').update(lines.join('\n')+'\n').digest('hex'));
    assert.deepEqual(await verifyEventArchive(directory),{rows:lines.length,rawHash:manifest.rawHash});
    const first=manifest.blocks[0]!;
    await unlink(path.join(directory,manifest.blocks.at(-1)!.file));
    const selected=[];for await(const line of readEventArchive(directory,{fromSeq:first.firstSeq,toSeq:first.lastSeq}))selected.push(line);
    assert.deepEqual(selected,lines.slice(0,first.rows),'range reader does not open unrelated blocks');
    await assert.rejects(async()=>{for await(const _ of readEventArchive(directory)){};});
    await assert.rejects(writer.append(lines[0]!),/finished/);
    await assert.rejects(EventArchiveWriter.create(directory,codec),{code:'EEXIST'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('archive refuses duplicate/order errors, damaged frames, unsafe manifests and incomplete output',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-corrupt-'));
  try{
    const directory=path.join(root,'events'),writer=await EventArchiveWriter.create(directory,'gzip',{},1024);
    await writer.append('{"seq":"1","payload":{}}');
    await assert.rejects(writer.append('{"seq":"1"}'),/increase/);
    await assert.rejects(readArchiveManifest(directory),{code:'ENOENT'});
    const manifest=await writer.finish(),file=path.join(directory,manifest.blocks[0]!.file),original=await readFile(file);
    const corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;await writeFile(file,corrupt);
    await assert.rejects(async()=>{for await(const _ of readEventArchive(directory)){};},/checksum/);
    await assert.rejects(verifyEventArchive(directory),/checksum/);
    await writeFile(file,original);
    const manifestPath=path.join(directory,'manifest.json');
    await writeFile(manifestPath,JSON.stringify({...manifest,blocks:[{...manifest.blocks[0],file:'../escape'}]}));
    await assert.rejects(readArchiveManifest(directory),/path/);
    await writeFile(manifestPath,JSON.stringify({...manifest,rawHash:'0'.repeat(64)}));
    await assert.rejects(async()=>{for await(const _ of readEventArchive(directory)){};},/full checksum/);
    await assert.rejects(verifyEventArchive(directory),/full checksum/);
  }finally{await rm(root,{recursive:true,force:true});}
});
