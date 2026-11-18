import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readlink,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {createHostedSession,resetPiRuntime,type HostedSession} from '../src/pi/session-host.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';
test('F12 interactive_shell consumer drives real native Pi PTYs, screens, ownership, approval and cleanup',async(t)=>{
 const base=loadConfig(),schema='codex_shell_native_'+process.pid+'_'+Date.now(),dir=await mkdtemp(path.join(tmpdir(),'wormhole-shell-native-')),admin=new Pool({connectionString:base.database.dsn});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:base.database.dsn,options:'-c search_path='+schema});await runMigrations(pool);await mkdir(path.join(dir,'agent'));await writeFile(path.join(dir,'agent/models.json'),JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'agent/models.json')}},intercept=new InterceptService(pool,path.join(dir,'dlq'));let host:HostedSession|undefined;
 const env=process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL;
 const mock=await startMockAnthropic(0,{marker:'PTY_FINISHED',tool:body=>{
  const messages=body.messages as any[],text=messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text)).join(' '),mode=text.match(/MODE:([a-z-]+)/)?.[1],owner=text.match(/OWNER:([A-Z_]+)/)?.[1]??'OWNER';
  const calls=messages.flatMap(m=>m.content??[]).filter(b=>b.type==='tool_use').map(b=>b.name),results=messages.flatMap(m=>m.content??[]).filter(b=>b.type==='tool_result').map(b=>JSON.stringify(b.content)).join(' ');
  if(mode==='off')return undefined;
  let command="python3 -u -c 'import sys; print(\"TTY=\"+str(sys.stdin.isatty()),flush=True); print(\"READY> \",end=\"\",flush=True); x=input(); print(\"REPLY=\"+x,flush=True); print(\"DONE> \",end=\"\",flush=True); input()'";
  if(mode==='same-prompt')command="python3 -u -c 'import sys,time; print(\"TTY=\"+str(sys.stdin.isatty()),flush=True); print(\"READY> \",end=\"\",flush=True); x=input(); time.sleep(0.2); print(\"REPLY=\"+x,flush=True); print(\"READY> \",end=\"\",flush=True); input()'";
  if(mode==='monitor'||mode==='dispatch'){
   if(!calls.includes('shell_open'))return {name:'shell_open',input:{command:mode==='monitor'?"printf 'MONITOR_TOKEN\\nMONITOR_TOKEN\\n'; sleep 3":"printf 'DISPATCH_RECEIPT\\n'; sleep 3",mode,...(mode==='monitor'?{watch:['MONITOR_TOKEN']}:{quiet_ms:100,startup_grace_ms:100})}};
   if(!calls.includes('sleep'))return {name:'sleep',input:{seconds:1}};
   if(!calls.includes('shell_close'))return {name:'shell_close',input:{session_id:'sh_1'}};return undefined;
  }
  if(!calls.includes('shell_open'))return {name:'shell_open',input:{command,mode:'interactive',prompt_regex:'READY> $',rows:8,cols:60,quiet_ms:100,startup_grace_ms:100}};
  if(mode==='hold')return undefined;
  if(!calls.includes('shell_send'))return {name:'shell_send',input:{session_id:'sh_1',text:owner,submit:true,...(mode==='same-prompt'?{}:{prompt_regex:'DONE> $'}),timeout_ms:2000,quiet_ms:mode==='same-prompt'?500:100}};
  if(mode==='deny')return undefined;
  if(!calls.includes('shell_read'))return {name:'shell_read',input:{session_id:'sh_1',view:'screen'}};
  if(!calls.includes('shell_list'))return {name:'shell_list',input:{}};
  if(!calls.includes('shell_close'))return {name:'shell_close',input:{session_id:'sh_1'}};
  return undefined;
 }});
 const port=(mock.server.address() as {port:number}).port,profile=Number((await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('pty native','anthropic','mock-1',$1,'fixture',true) RETURNING id",['http://127.0.0.1:'+port])).rows[0].id);
 await pool.query("INSERT INTO agents(key,name,role,builtin,enabled,run_seconds,interactive_shell) VALUES('pty_fixture','PTY','assistant',FALSE,TRUE,0,TRUE)");
 await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1)",[JSON.stringify(['shell_open','shell_send'])]);
 const gate={rules:[],getRules:()=>intercept.gateRules(),requestApproval:(id:number,reason?:string,ms?:number,action?:'deny'|'allow',signal?:AbortSignal)=>intercept.requestApproval(id,reason,ms,action,signal)};
 async function create(id:string){host=await createHostedSession(pool,config,{kind:'chat',businessId:id,cwd:path.join(dir,id),systemPrompt:'Use only the local PTY fixture.',provider:'profile-'+profile,profileBinding:true,freshContext:true,customTools:await assembleTools(pool,[],{businessKind:'chat',businessId:id,agentKey:'pty_fixture'},gate)});return host;}
 async function finish(){await host?.flushEvents();await host?.dispose();host=undefined;}
 async function until(fn:()=>Promise<boolean>){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('PTY approval did not become pending');}
 try{
  await t.test('enabled flag exposes exactly 5 tools and real TTY send/read/screen/close receipts reach model',async()=>{
   const h=await create('pty-round'),start=mock.state.calls.length;assert.deepEqual(h.session.getActiveToolNames().filter(n=>n.startsWith('shell_')).sort(),['shell_close','shell_list','shell_open','shell_read','shell_send']);await h.session.prompt('MODE:round OWNER:OWNER_A');
   const requests=mock.state.calls.slice(start),text=JSON.stringify(requests.at(-1)!.body);assert.ok(text.includes('TTY=True'));assert.ok(text.includes('REPLY=OWNER_A'));assert.ok(text.includes('screen'));assert.ok(text.includes('closed'));assert.equal(requests.length,6);
   const audits=(await pool.query("SELECT tool_key,native_tool_call_id,is_error FROM tool_calls WHERE business_id='pty-round' ORDER BY id")).rows;assert.deepEqual(audits.map(r=>r.tool_key),['shell_open','shell_send','shell_read','shell_list','shell_close']);assert.ok(audits.every(r=>r.native_tool_call_id&&!r.is_error));await finish();
  });
  await t.test('send wait does not mistake the previous identical prompt for new command completion',async()=>{
   const h=await create('pty-same-prompt');await h.session.prompt('MODE:same-prompt OWNER:SAME_PROMPT_OWNER');assert.ok(JSON.stringify(mock.state.calls.at(-1)!.body).includes('REPLY=SAME_PROMPT_OWNER'),'delayed new output must be received before close');await finish();
  });
  await t.test('disabled flag and global kill switch hide tools and avoid dangling Bash advice',async()=>{
   await pool.query("UPDATE agents SET interactive_shell=FALSE WHERE key='pty_fixture'");let h=await create('pty-off');await h.session.prompt('MODE:off');assert.equal(h.session.getActiveToolNames().filter(n=>n.startsWith('shell_')).length,0);assert.ok(!JSON.stringify(mock.state.calls.at(-1)!.body?.tools).includes('改用 shell_open'));await finish();
   await pool.query("UPDATE agents SET interactive_shell=TRUE WHERE key='pty_fixture'");process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL='true';h=await create('pty-global-off');assert.equal(h.session.getActiveToolNames().filter(n=>n.startsWith('shell_')).length,0);await finish();if(env===undefined)delete process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL;else process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL=env;
  });
  await t.test('concurrent owners can each use sh_1 without crossing streams or processes',async()=>{
   const a=await create('pty-owner-a');host=undefined;const b=await create('pty-owner-b');host=undefined;const start=mock.state.calls.length;
   try{await Promise.all([a.session.prompt('MODE:round OWNER:ALPHA_OWNER'),b.session.prompt('MODE:round OWNER:BETA_OWNER')]);const requests=mock.state.calls.slice(start);
    const alpha=requests.filter(r=>JSON.stringify(r.body?.messages).includes('OWNER:ALPHA_OWNER')),beta=requests.filter(r=>JSON.stringify(r.body?.messages).includes('OWNER:BETA_OWNER'));
    assert.ok(JSON.stringify(alpha.at(-1)?.body).includes('REPLY=ALPHA_OWNER'));assert.ok(!JSON.stringify(alpha).includes('BETA_OWNER'));assert.ok(JSON.stringify(beta.at(-1)?.body).includes('REPLY=BETA_OWNER'));assert.ok(!JSON.stringify(beta).includes('ALPHA_OWNER'));
   }finally{await Promise.all([a.dispose(),b.dispose()]);}
  });
  await t.test('shell_send must receive approval; deny leaves zero writes before cleanup',async()=>{
   await intercept.createRule({name:'PTY input approval',match_target:'tool_name',match_type:'string',pattern:'shell_send',action:'ask',enabled:true});const h=await create('pty-approval'),work=h.session.prompt('MODE:deny OWNER:NEVER_WRITTEN');await until(async()=>(await intercept.pending()).length===1);const pending=(await intercept.pending())[0]!;
   await intercept.decide(Number(pending.id),'denied');await work;const record=(await pool.query("SELECT result,is_error FROM tool_calls WHERE business_id='pty-approval' AND tool_key='shell_send'")).rows[0];assert.equal(record.is_error,true);assert.equal(record.result,null);await finish();await pool.query('DELETE FROM intercept_rules');
  });
  await t.test('monitor and dispatch notices enter the live native context without starting a new owner loop',async()=>{
   for(const mode of ['monitor','dispatch']){const h=await create('pty-'+mode);await h.session.prompt('MODE:'+mode);const notices=h.session.messages.filter((m:any)=>m.role==='custom'&&m.customType==='shell-notification') as any[];
    assert.ok(notices.length>=1);if(mode==='monitor')assert.equal(notices.filter(m=>String(m.content).includes('命中 /MONITOR_TOKEN/')).length,1,'same watch fires only once despite duplicate token');
    assert.ok(JSON.stringify(mock.state.calls.at(-1)?.body?.messages).includes(mode==='monitor'?'MONITOR_TOKEN':'DISPATCH_RECEIPT'),'notification reaches subsequent actual provider request');await finish();
   }
  });
  await t.test('disposing a host kills live PTY group rather than leaving its interactive process running',async()=>{
   const h=await create('pty-held');await h.session.prompt('MODE:hold');await h.flushEvents();
   const cwd=path.join(dir,'pty-held'),owned:{pid:string;stat:string}[]=[];
   for(const pid of await readdir('/proc'))if(/^\d+$/.test(pid)&&await readlink('/proc/'+pid+'/cwd').catch(()=>null)===cwd){const stat=await readFile('/proc/'+pid+'/stat','utf8');owned.push({pid,stat:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!});}
   assert.ok(owned.length>0,'a real owned PTY child was running before disposal');await h.dispose();host=undefined;
   await until(async()=>{for(const item of owned){const stat=await readFile('/proc/'+item.pid+'/stat','utf8').catch(()=>null);if(stat&&stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]===item.stat)return false;}return true;});
  });
 }finally{if(env===undefined)delete process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL;else process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL=env;await host?.dispose();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});}
});
