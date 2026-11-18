import {mkdir} from 'node:fs/promises';
import {currentNetwork} from '../network/context.ts';
import {targetSpawn,shellQuote} from '../network/sandbox.ts';
import {readFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
/** MCP SDK owns handshake, request ids, paged discovery and cancellation.
 * Connections belong to a discovery or an agent session, never the process. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport,StreamableHTTPError} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {Agent,ProxyAgent,fetch as undiciFetch} from 'undici';
import type {McpServerRecord} from './service.ts';

export interface McpConnection {
  client:Client;
  isClosed():boolean;
  close():Promise<void>;
}
export async function connectMcp(server:McpServerRecord,signal?:AbortSignal,cwd?:string):Promise<McpConnection>{
  const scope=currentNetwork(),jump=scope?.mode==='jump';
  if(jump&&!scope.route)throw new Error("MCP requires running springboard task");
  const dispatcher=jump?new ProxyAgent({uri:scope.route!.proxy,proxyTunnel:false,requestTls:scope.route!.caFile?{ca:readFileSync(scope.route!.caFile)}:undefined}):server.insecure?new Agent({connect:{rejectUnauthorized:false}}):undefined;
  const customFetch=dispatcher?((url:any,init:any)=>undiciFetch(url,{...init,dispatcher})) as unknown as typeof fetch:undefined;
  const headers={...server.env};
  if(server.name==='rea'&&cwd){const scratch=path.join(cwd,'.reverse-tmp');await mkdir(scratch,{recursive:true,mode:0o700});Object.assign(headers,{HOME:cwd,TMPDIR:scratch,TMP:scratch,TEMP:scratch});}
  let stdio={command:String(server.command),args:server.args??[],env:{...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),...headers},cwd};
  if(jump&&server.transport==='stdio'){
    const working=cwd??scope.workdir;if(!working)throw new Error("MCP missing task working directory");
    const mounts:string[]=[];
    for(const arg of [String(server.command),...(server.args??[])])if(path.isAbsolute(arg)&&existsSync(arg)&&statSync(arg).isFile()&&!arg.startsWith('/usr/')&&!arg.startsWith(working+'/')){
      mounts.push(arg);const modules=path.join(path.dirname(arg),'node_modules');if(existsSync(modules))mounts.push(modules);
    }
    const isolated=targetSpawn({command:[String(server.command),...(server.args??[])].map(shellQuote).join(' '),cwd:working,env:stdio.env},{mounts,envKeys:Object.keys(headers)});
    stdio={command:'/bin/bash',args:['-c',isolated.command],env:isolated.env as Record<string,string>,cwd:working};
  }
  const makeTransport=(sse=false)=>server.transport==='stdio'
    ?new StdioClientTransport({...stdio,stderr:'ignore'})
    :sse||server.transport==='sse'
      ?new SSEClientTransport(new URL(String(server.url)),{requestInit:{headers},fetch:customFetch})
      :new StreamableHTTPClientTransport(new URL(String(server.url)),{requestInit:{headers},fetch:customFetch});
  let client=new Client({name:'wormhole-pihost',version:'0.1'},{capabilities:{}}),closed=false;
  const close=async()=>{if(closed)return;closed=true;await client.close();await dispatcher?.close();};
  const abort=()=>{void close().catch(()=>{});};
  signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const bounded=async(p:Promise<void>)=>Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error("MCP handshake timeout"));},15_000);})]).finally(()=>clearTimeout(timer));
  try{
    try{await bounded(client.connect(makeTransport()));}
    catch(error){
      // Streamable HTTP endpoints predating MCP 2025 retain SSE transport.
      // Never retry a tool call: it may already have produced a side effect.
      if(server.transport!=='http'||signal?.aborted||closed||!(error instanceof StreamableHTTPError)||![400,404,405].includes(error.code??0))throw error;
      await client.close();client=new Client({name:'wormhole-pihost',version:'0.1'},{capabilities:{}});
      await bounded(client.connect(makeTransport(true)));
    }
    signal?.throwIfAborted();
    client.onclose=()=>{closed=true;void dispatcher?.close().catch(()=>{});};
    return {client,isClosed:()=>closed,close:async()=>{signal?.removeEventListener('abort',abort);await close();}};
  }catch(error){signal?.removeEventListener('abort',abort);await close().catch(()=>{});throw error;}
}
export async function discoverMcp(server:McpServerRecord):Promise<{name:string;description?:string;inputSchema:Record<string,unknown>}[]>{
  const connection=await connectMcp(server),tools:Awaited<ReturnType<typeof discoverMcp>>=[],seen=new Set<string>();
  try{
    let cursor:string|undefined;
    do{
      const page=await connection.client.listTools(cursor?{cursor}:{},{timeout:15_000});
      for(const tool of page.tools)tools.push(tool);
      cursor=page.nextCursor;
      if(cursor&&seen.has(cursor))throw new Error("MCP tools/list returns duplicate paging cursor");
      if(cursor)seen.add(cursor);
    }while(cursor);
    return tools;
  }finally{await connection.close();}
}
