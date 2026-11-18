/** Optional real-model checkpoint smoke. Skip performs no DB/file writes. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createHostedSession,resetPiRuntime,setCallRecorder,type HostedSession} from '../src/pi/session-host.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
import {expandRecordBodies} from '../src/storage/record-body.ts';
test('真实 GLM 三轮：同会话上下文→dispose/reopen checkpoint→口令恢复与录制', {skip:process.env.RUN_GLM_E2E!=='1'}, async()=>{
 const base=loadConfig(),runtime=JSON.parse(await readFile(process.env.WORMHOLE_REAL_CONFIG??'/var/lib/wormhole/config.json','utf8'));
 const models=JSON.parse(await readFile(runtime.pi.modelsPath,'utf8')),provider=String(runtime.pi.provider),modelId=String(runtime.pi.modelId);assert.ok(models.providers?.[provider]);
 const tag=process.pid+'_'+Date.now(),schema='codex_glm_checkpoint_'+tag,dir=await mkdtemp(path.join(tmpdir(),'wormhole-glm-checkpoint-')),admin=new Pool({connectionString:base.database.dsn});let pool:Pool|undefined,host:HostedSession|undefined;
 try{
  await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);
  const agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{[provider]:models.providers[provider]}}),{mode:0o600});
  await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.llm_record','true')");const writer=new LlmRecords(pool);setCallRecorder((entry,on)=>writer.recordCall(entry,on,entry.businessKind));resetPiRuntime();
  const config={...base,dataDir:dir,pi:{agentDir,modelsPath,provider,modelId}},businessId='checkpoint-'+tag,nonce='CHECKPOINT_'+tag;
  const args={kind:'chat' as const,businessId,systemPrompt:'你是会话恢复测试助手，遵照用户指令准确记忆并原样复述测试口令，不使用工具。'};
  const prompt=async(text:string)=>{const timer=setTimeout(()=>void host?.session.abort(),45000);try{await host!.session.prompt(text);assert.equal(await host!.flushEvents(),0);assert.equal(host!.modelFailure,undefined);return JSON.stringify(host!.session.messages.filter(m=>m.role==='assistant').at(-1)?.content);}finally{clearTimeout(timer);}};
  host=await createHostedSession(pool,config,args);await prompt('记住本会话测试口令：'+nonce+'。这一轮只回复 READY。');
  assert.match(await prompt('只回复上一轮告诉你的口令，原样回复。'),new RegExp(nonce));const checkpointId=host.session.sessionId,checkpointFile=host.session.sessionFile;
  await host.dispose();host=undefined;resetPiRuntime();host=await createHostedSession(pool,config,args);assert.equal(host.session.sessionId,checkpointId,'same native checkpoint reopened');assert.equal(host.session.sessionFile,checkpointFile,'same native checkpoint file');
  assert.match(await prompt('现在再次只回复最初告诉你的测试口令。'),new RegExp(nonce));
  const usage=(await pool.query('SELECT input_tokens,output_tokens,status FROM llm_usage')).rows,records=await Promise.all((await pool.query('SELECT * FROM llm_records')).rows.map(expandRecordBodies));
  assert.equal(usage.length,3);assert.equal(records.length,3);assert.ok(usage.every(r=>r.status==='ok'));assert.ok(records.every(r=>r.raw_request&&r.raw_response));assert.ok(records[2].raw_request.includes(nonce),'reopened provider request retains original context');
  console.log(JSON.stringify({provider,model:modelId,turns:3,checkpointReopened:true,usageCalls:usage.length,recordings:records.length,inputTokens:usage.reduce((n,r)=>n+Number(r.input_tokens),0),outputTokens:usage.reduce((n,r)=>n+Number(r.output_tokens),0)}));
 }finally{await host?.dispose();setCallRecorder(null);resetPiRuntime();await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
