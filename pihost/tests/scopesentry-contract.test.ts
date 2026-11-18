import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {Pool} from 'pg';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {AssetsService} from '../src/domains/assets/service.ts';
import {SyncService,seedScopeSentry} from '../src/domains/sync/scopesentry.ts';

test('optional ScopeSentry: actual MCP transport, credentials, paging, typed writes and disable',async t=>{
 const pool=new Pool({connectionString:loadConfig().database.dsn});
 const dir=await mkdtemp('/tmp/wormhole-scopesentry-');
 let requests=0,fail=false;
 const calls:{name:string,args:Record<string,unknown>}[]=[];
 const backend=createServer(async(req,res)=>{
  requests++;
  if(req.headers['x-api-key']!=='local-contract-token'){res.writeHead(401);res.end();return;}
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  const server=new Server({name:'scopesentry-contract',version:'1'},{capabilities:{tools:{}}});
  const names=['list_projects_data','list_tasks','get_project','list_assets'];
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:names.map(name=>({name,inputSchema:{type:'object',properties:{}}}))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
   const name=request.params.name,args=request.params.arguments??{};calls.push({name,args});
   if(fail)return {isError:true,content:[{type:'text',text:'controlled upstream error'}]};
   let data:unknown;
   if(name==='list_projects_data')data={result:{All:[{id:'fixture',name:'Contract fixture'}]},tag:'local'};
   else if(name==='list_tasks')data={list:[{id:'fixture-task'}]};
   else if(name==='get_project')data={name:'Contract fixture',target:'example.test'};
   else if(name==='list_assets'){
    const rows=args.asset_type==='subdomain'?[{host:'api.example.test',type:'A',value:['192.0.2.20'],ip:['192.0.2.20']},{host:'www.example.test',type:'A',value:['192.0.2.21']}]:args.asset_type==='asset'?[{url:'https://api.example.test',service:'http',status:200,title:'Fixture',products:['ContractProduct']}]:[{name:'Contract app',category:'web'}];
    data={list:rows.slice((Number(args.pageIndex)-1)*Number(args.pageSize),Number(args.pageIndex)*Number(args.pageSize))};
   }else throw new Error('Unexpected tool '+name);
   return {content:[{type:'text',text:JSON.stringify(data)}]};
  });
  res.on('close',()=>void server.close());await server.connect(transport);await transport.handleRequest(req,res);
 });
 try{
  await runMigrations(pool);await seedScopeSentry(pool);
  const assets=new AssetsService(pool,dir+'/events.jsonl'),sync=new SyncService(pool,assets,dir+'/events.jsonl');
  await t.test('unconfigured service never makes a request',async()=>{assert.equal((await sync.status()).configured,false);await assert.rejects(sync.projects(1,1,''),/未配置/);assert.equal(requests,0);});
  await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+(backend.address() as {port:number}).port;
  await t.test('explicit configuration authenticates and discovers tools',async()=>{await sync.datasource({url,api_key:'local-contract-token'});const status=await sync.status();assert.equal(status.reachable,true);assert.equal((status.tools as string[]).length,4);assert.ok(!JSON.stringify(status).includes('local-contract-token'));});
  await t.test('project and task lists use the documented response envelopes',async()=>{assert.equal((await sync.projects(2,10,'fixture')).projects[0].id,'fixture');assert.equal((await sync.tasks(1,10,'')).tasks[0].id,'fixture-task');assert.ok(calls.some(c=>c.name==='list_projects_data'&&c.args.pageIndex===2&&c.args.search==='fixture'));});
  await t.test('paged import writes assets, companies and scope; repeated import deduplicates',async()=>{const req={dimension:'project',targets:['fixture'],create_company:true,page_size:1};const result=await sync.sync(req);assert.deepEqual(result.synced,{subdomain:2,app:1,service:1,ip:1});assert.equal(result.errors,null);const count=Number((await pool.query('SELECT count(*) FROM assets')).rows[0].count);await sync.sync({...req,create_company:false});assert.equal(Number((await pool.query('SELECT count(*) FROM assets')).rows[0].count),count);assert.ok(calls.some(c=>c.name==='list_assets'&&c.args.pageIndex===3));assert.equal((await pool.query("SELECT count(*) FROM companies WHERE name='Contract fixture'")).rows[0].count,'1');});
  await t.test('upstream errors propagate and disabled integrations make no requests',async()=>{fail=true;await assert.rejects(sync.projects(1,1,''),/controlled upstream error/);fail=false;await pool.query("UPDATE mcp_servers SET enabled=false WHERE name='ScopeSentry'");const before=requests;await assert.rejects(sync.tasks(1,1,''),/已禁用/);assert.equal((await sync.status()).reachable,false);assert.equal(requests,before);});
 }finally{backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));await pool.end();await rm(dir,{recursive:true,force:true});}
});
