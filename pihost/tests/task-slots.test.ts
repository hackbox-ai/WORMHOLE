import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaskSlots} from '../src/domains/tasks/slots.ts';
import {parseBatchTargets} from '../src/domains/tasks/batches.ts';

test('mixed task owners never exceed three, roll forward independently and retain wrap-up leases',async()=>{
 const slots=new TaskSlots(()=>99),signal=new AbortController().signal;
 const ordinary=slots.tryAcquire(1)!,batch=slots.tryAcquire(2)!,chat=await slots.acquire(3,signal);
 assert.equal(slots.size,3);assert.equal(slots.tryAcquire(4),null);
 let entered=false;const next=slots.acquire(4,signal).then(release=>{entered=true;return release;});
 const wrap=slots.tryAcquire(2)!;batch();await Promise.resolve();assert.equal(entered,false,'cleanup retains the task slot');
 wrap();const fourth=await next;assert.equal(entered,true);assert.deepEqual(slots.ids,[1,3,4]);
 ordinary();chat();fourth();fourth();assert.equal(slots.size,0);
});
test('aborted waiting owners never start; a lower configured limit still applies',async()=>{
 const slots=new TaskSlots(()=>1),release=slots.tryAcquire(1)!;const abort=new AbortController();
 const blocked=slots.acquire(2,abort.signal);abort.abort();await assert.rejects(blocked);release();assert.equal(slots.size,0);assert.ok(slots.tryAcquire(3));
});
test('targets normalize and dedupe without losing meaningful URL paths',()=>{
 const p=parseBatchTargets('EXAMPLE.COM.\nexample.com\n192.0.2.1\n2001:0db8::1\nhttps://EXAMPLE.com:443/a?q=1#top\nhttps://example.com/a?q=1\nexample.com:8080/b\n\n');
 assert.equal(p.errors.length,0);assert.equal(p.items.length,5);assert.equal(p.duplicates.length,2);assert.equal(p.items[3]!.target,'https://example.com/a?q=1');assert.equal(p.items[4]!.host,'example.com');
 const bad=parseBatchTargets('999.999.999.999\nftp://example.com/x\nhttps://name:pass@example.com\nhello world\n-bad.example');assert.equal(bad.items.length,0);assert.equal(bad.errors.length,5);
 assert.throws(()=>parseBatchTargets(Array(502).fill('example.com').join('\n')));
});
