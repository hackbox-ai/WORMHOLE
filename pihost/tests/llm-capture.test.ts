/** Exact transport bytes, not just presence of a recording row. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WireCapture,captureWireFetch,capturedCall,profileCall,normalizedRequestBody} from '../src/domains/llm/profile-wire.ts';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import type {Pool} from 'pg';
import {profileStream} from '../src/domains/llm/pool-stream.ts';
import {taskStream} from '../src/domains/llm/task-stream.ts';
const message:any={role:'assistant',api:'anthropic-messages',provider:'env-test',model:'wire',content:[{type:'text',text:'ok'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
const model:any={api:'anthropic-messages',provider:'env-test',id:'wire'};
test('F07 原 capture 多 attempt 精确换行、超过4MiB仍完整（含多字节字符）',()=>{
 const capture=new WireCapture();capture.startAttempt(500).push('failed\n');capture.startAttempt(200).push('成功');
 assert.equal(capture.rawResponse(),'===== attempt 1/2 — HTTP 500 =====\nfailed\n===== attempt 2/2 — HTTP 200 =====\n成功\n');
 const large=new WireCapture(),text='中'.repeat(1500000);large.startAttempt(200).push(text);assert.equal(large.rawResponse(),text);
});
test('F07 无 profile transport 精确录请求、跨块UTF-8与取消前已读正文',async()=>{
 const capture=new WireCapture(),bytes=Buffer.from('data: 中文\n\n');let canceled=false;
 const transport=captureWireFetch(async(input)=>{assert.equal(await new Request(input).text(),'actual request');return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,8));c.enqueue(bytes.subarray(8));},cancel(){canceled=true;}}));},capture);
 const response=await transport('http://fixture',{method:'POST',body:'actual request'}),reader=response.body!.getReader();await reader.read();await reader.read();await reader.cancel();
 assert.equal(capture.rawRequest(),'actual request');assert.equal(capture.rawResponse(),'data: 中文\n\n');assert.equal(canceled,true);
});
test('F07 streaming=false raw_request 与最终网络body相同，raw_response 保留JSON不记转换SSE',async()=>{
 let sent='';const reply=JSON.stringify({id:'msg',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}),holder:any={};
 const native:any=(_model:any,_context:any,options:any)=>{const out=createAssistantMessageEventStream();void(async()=>{const r=await options.fetch('http://fixture/v1/messages',{method:'POST',body:JSON.stringify({messages:[],stream:true,stream_options:{include_usage:true}})});assert.match(await r.text(),/message_stop/);out.push({type:'done',reason:'stop',message});out.end(message);})();return out;};
 const stream=profileCall(native,{} as Pool,{format:'anthropic',streaming:false} as any,model,{messages:[]}, {fetch:async(input)=>{sent=await new Request(input).text();return new Response(reply,{headers:{'content-type':'application/json'}});}}, {},holder);
 for await(const _event of stream){}await stream.result();assert.deepEqual(JSON.parse(sent),{messages:[],stream:false});assert.equal(holder.capture.rawRequest(),sent);assert.equal(holder.capture.rawResponse(),reply);
});
test('F07 环境调用经公开fetch hook记录一次，终止事件前持久化回调完成',async()=>{
 const holder:any={},records:any[]=[],native:any=(_m:any,_ctx:any,options:any)=>{const out=createAssistantMessageEventStream();void(async()=>{const response=await options.fetch('http://fixture',{method:'POST',body:'{"messages":[],"stream":true}'});await response.text();out.push({type:'done',reason:'stop',message});out.end(message);})();return out;};
 const stream=capturedCall(native,model,{messages:[]},{fetch:async()=>new Response('environment bytes')},holder,async(m,latency,capture)=>{await new Promise(r=>setImmediate(r));records.push({m,latency,request:capture.rawRequest(),response:capture.rawResponse()});});
 for await(const event of stream)if(event.type==='done')assert.equal(records.length,1);await stream.result();assert.equal(records.length,1);assert.equal(records[0].response,'environment bytes');assert.equal(JSON.parse(records[0].request).stream,true);
 assert.deepEqual(JSON.parse(normalizedRequestBody('{"tools":[{"type":"function","function":{"name":"echo"}}]}')).tools,['echo']);
});
test('F07 profile/task终止事件等待自己的调用落库，不让prompt完成先于录制',async()=>{
 const native:any=()=>{const out=createAssistantMessageEventStream();queueMicrotask(()=>{out.push({type:'done',reason:'stop',message});out.end(message);});return out;};
 const pool:any={query:async()=>({rows:[]})},runtime:any={registerProvider(){},setRuntimeApiKey:async()=>{},getModel:()=>model};
 const profile:any={id:1,name:'fixture',format:'anthropic',model:'wire',api_key:'fixture',base_url:'http://fixture'};
 for(const mode of ['profile','task']){let persisted=false;const record=async()=>{await new Promise(r=>setImmediate(r));persisted=true;};
  const fn=mode==='profile'?profileStream(native,pool,runtime,async()=>({profile,binding:true,allowPool:false}),record):taskStream(native,{pool,current:async()=>({model,source:'environment'})} as any,()=>{},record);
  const stream=fn(model,{messages:[]});let done=false;for await(const event of stream)if(event.type==='done'){done=true;assert.equal(persisted,true,mode+' must wait for recorder');}await stream.result();assert.equal(done,true);
 }
});
