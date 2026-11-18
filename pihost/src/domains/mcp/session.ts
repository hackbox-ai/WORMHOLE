import {analysisSlots} from '../reverse/resources.ts';
import {appendEvent} from '../../events/ledger.ts';
import {inTaskNetwork} from '../network/context.ts';
/** visible skills gate MCP schemas and invocation.
 * All mutable clients/unlocks belong to this assembly, not a global handler. */
import type {Pool} from 'pg';
import type {ToolDefinition,AgentSession} from '@earendil-works/pi-coding-agent';
import type {McpService,McpServerRecord} from './service.ts';
import type {SkillsService} from '../skills/service.ts';
import {connectMcp,type McpConnection} from './client.ts';
import {assembleTools,bindToolPolicy,toolPolicy} from '../tools/assembly.ts';
import {registerTool,runTool,type GateOptions,type ToolContext} from '../tools/gate.ts';

export interface SessionAugmentation {
  tools:ToolDefinition[];
  attach(session:AgentSession):Promise<void>;
  restore(messages:unknown[]):Promise<void>;
  dispose():Promise<void>;
}
interface RemoteTool {key:string;serverId:number;name:string;description:string;schema:Record<string,unknown>}
const assemblies=new WeakMap<ToolDefinition[],SessionAugmentation>();
export function bindAugmentation(tools:ToolDefinition[],augmentation:SessionAugmentation):ToolDefinition[]{assemblies.set(tools,augmentation);const policy=toolPolicy(augmentation.tools);if(policy)bindToolPolicy(tools,policy.ctx,policy.gate);return tools;}
export function sessionAugmentation(tools:ToolDefinition[]):SessionAugmentation|undefined{return assemblies.get(tools);}
function session(ctx:ToolContext){if(!ctx.mcpSession)throw new Error("MCP session not assembled");return ctx.mcpSession;}
function schemaFingerprint(value:unknown):string{
  const normalize=(v:any):any=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])])):v;
  return JSON.stringify(normalize(value));
}
registerTool({key:'Skill',description:"Load the complete description of the skills visible to this Agent, and unlock the MCP tools associated with the skills.",params:{},required:[],schema:{type:'object',properties:{name:{type:'string'},args:{type:'string'}},required:['name']},execute:(p,ctx)=>session(ctx).invokeSkill(String(p.name),p.args as string|undefined)});
registerTool({key:'SearchExtraTools',description:"Retrieve unlocked deferred tools by name or description, returning the actual parameter schema.",params:{},required:[],schema:{type:'object',properties:{query:{type:'string'}},required:['query']},execute:(p,ctx)=>session(ctx).search(String(p.query))});
registerTool({key:'ExecuteExtraTool',description:"Execution of unlocked tools; params must use the schema returned by SearchExtraTools.",params:{},required:[],schema:{type:'object',properties:{tool_name:{type:'string'},params:{type:'object',additionalProperties:true}},required:['tool_name']},execute:(p,ctx)=>session(ctx).execute(String(p.tool_name),(p.params??{}) as Record<string,unknown>,ctx.nativeToolCallId,ctx.signal)});

export async function augmentSession(pool:Pool,mcp:McpService,skills:SkillsService|undefined,ctx:ToolContext,gate:GateOptions):Promise<SessionAugmentation>{
  gate={...gate,enforceInterceptScope:true};
  const visible=await skills?.visible(ctx.agentKey)??[],all=await mcp.enabledServers(),remote:RemoteTool[]=[];
  const invoked=new Set<string>(),connections=new Map<number,Promise<McpConnection>>();let disposed=false;
  let agentSession:AgentSession|undefined,unsubscribe:(()=>void)|undefined;
  const guidance=new Map<string,{content:string;args:string}>();
  // Streaming triggerTurn:false is persisted only after the entire run settles in
  // pinned Pi 0.85.1. Skill instructions must precede the next provider request.
  // Public steering queues after the current tool result; it never starts a
  // second prompt loop while the owning run is already streaming.
  const inject=async(key:string,item:{content:string;args:string})=>agentSession?.sendCustomMessage(
    {customType:'wormhole-skill',display:true,content:item.content,details:{key,args:item.args}},
    agentSession.isStreaming?{deliverAs:'steer'}:{triggerTurn:false});
  const permitted=async(server:McpServerRecord)=>{
    const current=await mcp.get(Number(server.id));if(!current?.enabled)return false;
    // Current records must match the schema/endpoint admitted for this session.
    for(const key of ['name','transport','command','args','env','url','insecure'] as const)
      if(JSON.stringify(current[key])!==JSON.stringify(server[key]))throw new Error("MCP configuration has changed, please rebuild the session");
    const currentSkills=await skills?.visible(ctx.agentKey)??[];
    const gated=currentSkills.filter(s=>Array.isArray(s.metadata.mcps)&&s.metadata.mcps.includes(String(server.name)));
    if(gated.length)return gated.some(s=>invoked.has(s.key));
    return !!(await pool.query("SELECT 1 FROM agent_visibility WHERE agent_key=$1 AND resource_kind='mcp' AND resource_id=$2",[ctx.agentKey,String(server.id)])).rowCount;
  };
  const access=async(serverId:number)=>{
    ctx.signal?.throwIfAborted();if(disposed)throw new Error("MCP session closed");
    const server=all.find(s=>Number(s.id)===serverId);if(!server||!await permitted(server))throw new Error("MCP tool not unlocked or unbound");
    return server;
  };
  const available=(await pool.query("SELECT resource_id FROM agent_visibility WHERE agent_key=$1 AND resource_kind='mcp'",[ctx.agentKey])).rows.map(r=>r.resource_id);
  for(const server of all){
    if(!available.includes(String(server.id))&&!visible.some(s=>Array.isArray(s.metadata.mcps)&&s.metadata.mcps.includes(String(server.name))))continue;
    const cache=await pool.query('SELECT name,description,schema FROM mcp_tools_cache WHERE server_id=$1 ORDER BY name',[server.id]);
    // Discover uncached servers through SDK; failed discovery retains old cache.
    if(!cache.rowCount){const discovered=await inTaskNetwork(ctx.taskId,()=>mcp.refresh(Number(server.id)));if(!discovered.ok)continue;cache.rows=(await pool.query('SELECT name,description,schema FROM mcp_tools_cache WHERE server_id=$1 ORDER BY name',[server.id])).rows;}
    for(const tool of cache.rows){
      const key=`mcp__${server.name}__${tool.name}`,serverId=Number(server.id);
      remote.push({key,serverId,name:tool.name,description:tool.description,schema:tool.schema});
      registerTool({key,description:tool.description,params:{},required:[],schema:tool.schema,execute:(p,c)=>{return session(c).call(serverId,tool.name,p,c.signal);}});
    }
  }
  const establish=async(server:McpServerRecord)=>{
    if(server.name!=='rea')return connectMcp(server,ctx.signal,ctx.cwd);
    if(analysisSlots.status().active>=analysisSlots.status().limit)await appendEvent(pool,ctx.cwd?ctx.cwd+'/.reverse-events.jsonl':'/var/lib/wormhole/data/reverse-events.jsonl',{business_kind:ctx.businessKind,business_id:ctx.businessId,event_type:'reverse_waiting',payload:{taskId:ctx.taskId,intentId:ctx.intentId,message:"Waiting for reverse analysis resources"}}).catch(()=>{});
    const release=await analysisSlots.acquire(ctx.signal);let connection:McpConnection;
    try{connection=await connectMcp(server,ctx.signal,ctx.cwd);}catch(e){release();throw e;}
    let idle:ReturnType<typeof setTimeout>|undefined,closed=false,active=0;
    const close=async()=>{if(closed)return;closed=true;clearTimeout(idle);clearInterval(health);try{await connection.close();}finally{release();}};
    const health=setInterval(()=>{if(connection.isClosed())void close();},1000);health.unref();
    const reset=()=>{clearTimeout(idle);if(!active){idle=setTimeout(()=>void close(),60000);idle.unref();}};reset();
    const call=connection.client.callTool.bind(connection.client);
    connection.client.callTool=(async(...args:Parameters<typeof call>)=>{clearTimeout(idle);active++;try{return await call(...args);}finally{active--;reset();}}) as typeof connection.client.callTool;
    return {client:connection.client,isClosed:()=>closed||connection.isClosed(),close};
  };
  const sessionContext:ToolContext={...ctx};
  sessionContext.mcpSession={
    call:async(serverId,name,params,signal)=>{
      const server=await access(serverId);signal?.throwIfAborted();
      const admitted=remote.find(t=>t.serverId===serverId&&t.name===name);
      if(!admitted)throw new Error("MCP tool does not exist");
      const latest=(await pool.query('SELECT schema FROM mcp_tools_cache WHERE server_id=$1 AND name=$2',[serverId,name])).rows[0];
      if(!latest||schemaFingerprint(latest.schema)!==schemaFingerprint(admitted.schema))throw new Error("MCP tool schema has changed, please rebuild the session");
      let pending=connections.get(serverId);
      if(!pending){pending=establish(server);connections.set(serverId,pending);pending.catch(()=>connections.delete(serverId));}
      let connection=await pending;
      if(connection.isClosed()){
        // A later, explicit invocation may reconnect. Never replay the failed
        // tools/call: the server could already have performed its side effect.
        connections.delete(serverId);
        pending=establish(server);connections.set(serverId,pending);
        pending.catch(()=>connections.delete(serverId));connection=await pending;
      }
      signal?.throwIfAborted();await access(serverId);
      let result;
      try { result=await connection.client.callTool({name,arguments:params},undefined,{signal,timeout:120_000}); }
      catch(error){connections.delete(serverId);await connection.close().catch(()=>{});throw error;}
      if(result.isError)throw new Error(JSON.stringify(result.content));
      if(server.name==='rea'&&name==='close_binary'){connections.delete(serverId);await connection.close();}
      return result;
    },
    invokeSkill:async(name,args='')=>{
      const current=await skills?.visible(ctx.agentKey)??[];
      const skill=current.find(s=>s.key===name||s.metadata.name===name);if(!skill)throw new Error("Skill is not visible or does not exist");
      // A skill is not authorized until its usage record and guidance injection
      // both succeed. Keep failed loads from leaving an MCP grant behind.
      await skills!.recordUsage(skill.key,ctx.agentKey,ctx.businessKind,ctx.businessId);
      const instructions=skill.instructions.replaceAll('${SKILL_DIR}',skill.dir)+(args.trim()?`\n\n## Additional context from the caller\n\n${args}`:'');
      const item={content:instructions,args};await inject(skill.key,item);guidance.set(skill.key,item);invoked.add(skill.key);
      const names=remote.filter(t=>(skill.metadata.mcps??[]).includes(String(all.find(s=>Number(s.id)===t.serverId)?.name))).map(t=>t.key);
      return `Skill ${JSON.stringify(skill.metadata.name??skill.key)} loaded. Its instructions were added to the conversation as a separate guidance message — follow them.
Tools unlocked:${names.join(', ')}`;
    },
    search:async(query)=>{
      const q=query.trim();if(!q)throw new Error('Error: query is required');
      const matches=[];
      for(const tool of remote){
        const server=all.find(s=>Number(s.id)===tool.serverId)!,hay=`${tool.key} ${tool.description}`.toLowerCase().replaceAll('__',' ');
        const match=q.startsWith('select:')?q.slice(7).split(',').some(token=>token.trim()&&tool.key.toLowerCase().includes(token.trim().toLowerCase())):q.toLowerCase().split(/\s+/).every(token=>hay.includes(token));
        if(await permitted(server)&&match)matches.push({name:tool.key,description:tool.description,input_schema:tool.schema});
      }
      return matches;
    },
    execute:async(name,params,nativeToolCallId,signal)=>{
      const tool=remote.find(t=>t.key===name);if(!tool)throw new Error("Delay tool does not exist");await access(tool.serverId);
      const combined=ctx.signal&&signal?AbortSignal.any([ctx.signal,signal]):ctx.signal??signal;
      const result=await runTool(pool,name,params,{...sessionContext,signal:combined,nativeToolCallId},gate);
      if(result.status!=='executed')throw new Error(result.error??result.status);return result.output;
    }
  };
  const keys=[...(visible.length?['Skill']:[]),...(remote.length?['SearchExtraTools','ExecuteExtraTool']:[])];
  const tools=await assembleTools(pool,keys,sessionContext,gate);
  const skillTool=tools.find(t=>t.name==='Skill');
  if(skillTool)skillTool.description+='\nAvailable skills:\n'+visible.map(s=>`${s.metadata.name??s.key}: ${s.metadata.description??''}`).join('\n');
  const searchTool=tools.find(t=>t.name==='SearchExtraTools');
  const globalNames=[];
  for(const tool of remote)if(await permitted(all.find(s=>Number(s.id)===tool.serverId)!))globalNames.push(tool.key);
  if(searchTool)searchTool.description+='\nAvailable deferred tools:\n'+globalNames.join('\n');
  return {
    tools,
    attach:async(session)=>{agentSession=session;unsubscribe=session.subscribe(event=>{if(event.type==='compaction_end'&&!event.aborted&&event.result)for(const [key,item] of guidance)void inject(key,item);});},
    restore:async(messages)=>{
      // Only successful Skill calls in this persisted session grant an unlock.
      const calls=new Map<string,string>();
      for(const message of messages as any[]){
        if(message.role==='custom'&&typeof message.customType==='string'&&message.customType.endsWith('-skill')&&typeof message.details?.key==='string'){
          const skill=visible.find(s=>s.key===message.details?.key);
          if(skill)guidance.set(skill.key,{content:String(message.content),args:String(message.details?.args??'')});
        }
        if(message.role==='assistant')for(const content of message.content??[])if(content.type==='toolCall'&&content.name==='Skill')calls.set(content.id,String(content.arguments?.name??''));
        if(message.role==='toolResult'&&message.toolName==='Skill'&&!message.isError){const name=calls.get(message.toolCallId);const skill=visible.find(s=>s.key===name||s.metadata.name===name);if(skill)invoked.add(skill.key);}
      }
    },
    dispose:async()=>{disposed=true;unsubscribe?.();await Promise.allSettled([...connections.values()].map(p=>p.then(c=>c.close())));connections.clear();invoked.clear();guidance.clear();}
  };
}
