import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {streamEvents} from '../src/api/events.ts';

class Response extends EventEmitter{
  frames:string[]=[];ended=false;block=false;
  writeHead(){};
  write(frame:string){this.frames.push(frame);return !(this.block&&frame.startsWith('id:'));}
  end(){this.ended=true;}
}
test('full SSE pages catch up without per-page sleeps and preserve the reconnect cursor',async(t)=>{
  const request=Object.assign(new EventEmitter(),{url:'/api/events?kind=worker&id=task-44&cursor=1',headers:{'last-event-id':'10'}}),response=new Response();
  const waits:number[]=[],cursors:unknown[]=[];
  t.mock.method(globalThis,'setTimeout',(callback:()=>void,ms:number)=>{waits.push(ms);queueMicrotask(callback);return 1 as any;});
  const pool={query:async(_sql:string,values:unknown[])=>{
    cursors.push(values[2]);
    if(cursors.length===1)return{rows:Array.from({length:200},(_,i)=>({seq:String(11+i),event_type:'message_update',payload:{delta:String(i)}}))};
    request.emit('close');return{rows:[]};
  }};
  await streamEvents(request as any,response as any,pool as any);
  assert.deepEqual(cursors,['10','210']);assert.deepEqual(waits,[]);
  assert.equal(response.frames.filter(f=>f.startsWith('id:')).length,200);assert.equal(response.ended,true);
});
test('SSE backpressure waits for the consumer and disconnect wakes it without leaking listeners',async()=>{
  const request=Object.assign(new EventEmitter(),{url:'/api/events?kind=worker&id=task-44',headers:{}}),response=new Response();response.block=true;
  const pool={query:async()=>({rows:[{seq:'1',event_type:'first',payload:{}},{seq:'2',event_type:'second',payload:{}}]})};
  const running=streamEvents(request as any,response as any,pool as any);
  await setImmediate();assert.equal(response.frames.filter(f=>f.startsWith('id:')).length,1);assert.equal(response.listenerCount('drain'),1);
  request.emit('close');await running;
  assert.equal(response.ended,true);assert.equal(response.listenerCount('drain'),0);assert.equal(request.listenerCount('close'),0);
});

test('SSE reconnect retains bigint cursor precision',async()=>{
  const request=Object.assign(new EventEmitter(),{url:'/api/events?kind=worker&id=fixture&cursor=9007199254740992',headers:{'last-event-id':'9007199254740993'}}),response=new Response(),cursors:unknown[]=[];
  const pool={query:async(_sql:string,values:unknown[])=>{cursors.push(values[2]);request.emit('close');return{rows:[]};}};
  await streamEvents(request as any,response as any,pool as any);assert.deepEqual(cursors,['9007199254740993']);
});

test('historical SSE sends delta-sized updates and retains final messages without mutating the stored snapshot',async(t)=>{
  const request=Object.assign(new EventEmitter(),{url:'/api/events?kind=worker&id=fixture',headers:{}}),response=new Response();let calls=0;
  t.mock.method(globalThis,'setTimeout',(callback:()=>void)=>{queueMicrotask(callback);return 1 as any;});
  const snapshot={role:'assistant',content:[{type:'text',text:'x'.repeat(1024*1024)}]},payload={type:'message_update',message:snapshot,assistantMessageEvent:{type:'text_delta',delta:'🧪',partial:snapshot}};
  const pool={query:async()=>{if(calls++){request.emit('close');return {rows:[]};}return {rows:[{seq:'1',event_type:'message_update',payload},{seq:'2',event_type:'message_end',payload:{type:'message_end',message:snapshot}}]};}};
  await streamEvents(request as any,response as any,pool as any);
  const update=response.frames.find(frame=>frame.startsWith('id: 1'))!;assert.ok(Buffer.byteLength(update)<1024);assert.ok(update.includes('🧪'));assert.ok(update.includes('storage_version'));
  assert.ok(response.frames.find(frame=>frame.startsWith('id: 2'))!.includes(snapshot.content[0]!.text));assert.equal(payload.assistantMessageEvent.partial,snapshot);
});
