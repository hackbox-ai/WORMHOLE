import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {ExplorationService,nodeDTO,goalDTO,type GraphNode} from '../domains/exploration/service.ts';
import {directExplorationScope} from '../domains/exploration/scope.ts';
import {reopenExploration} from '../domains/tasks/completion.ts';

export async function routeExploration(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,
  json:(res:ServerResponse,status:number,value:unknown)=>void,readJson:(req:IncomingMessage)=>Promise<Record<string,unknown>|null>):Promise<boolean>{
  const path=url.pathname, method=req.method??'GET';
  const match=path.match(/^\/api\/tasks\/(\d+)\/(goals|constraints)(?:\/(\d+))?$/);
  const readGraph=/^\/api\/exploration\/(graph|nodes|intents|frontier)$/.test(path)||/^\/api\/tasks\/\d+\/graph$/.test(path);
  if(!match&&!readGraph)return false;
  const graph=new ExplorationService(ctx.pool,id=>ctx.taskEngine.notify(id));
  let taskId=match?Number(match[1]):/^\/api\/tasks\//.test(path)?Number(path.split('/')[3]):Number(url.searchParams.get('task'));
  if(!taskId&&!url.searchParams.get('task'))taskId=Number((await ctx.pool.query("SELECT id FROM tasks WHERE kind='pentest' AND deleted_at IS NULL AND archived=FALSE ORDER BY id DESC LIMIT 1")).rows[0]?.id??0);
  const task=(await ctx.pool.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];
  if(match&&!task){json(res,404,{error:'task not found'});return true;}
  if(readGraph){
    if(method!=='GET'){json(res,405,{error:'method not allowed'});return true;}
    if(path.endsWith('/graph'))json(res,200,await graph.graph(taskId));
    else if(path.endsWith('/nodes'))json(res,200,await graph.page(taskId,url.searchParams));
    else if(path.endsWith('/frontier')){
      const ns=(await graph.nodes(taskId,'intent')).filter(n=>n.state==='open').sort((a,b)=>b.priority-a.priority||Number(a.id)-Number(b.id));json(res,200,ns.slice(0,100).map(nodeDTO));
    }else{
      const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||300)),before=Number(url.searchParams.get('before'))||0;
      const paged=url.searchParams.has('before')||url.searchParams.has('page');
      const ns=(await ctx.pool.query(`WITH ${directExplorationScope} SELECT n.*,s.inherited,CASE WHEN s.inherited THEN s.task_id END AS source_task_id
        FROM exploration_nodes n JOIN scopes s USING(exploration_id) WHERE kind='intent' AND (NOT s.inherited ${paged?"OR state IN('done','blocked','exhausted','stopped')":''})
        AND ($2::bigint=0 OR id<$2) ORDER BY id DESC LIMIT $3`,[taskId,before,limit+1])).rows;
      json(res,200,paged?{items:ns.slice(0,limit).map(nodeDTO),has_more:ns.length>limit}:ns.slice(0,limit).map(nodeDTO));
    }return true;
  }
  const kind=match![2],nodeId=Number(match![3]);
  if(method==='GET'&&!nodeId){
    if(kind==='goals')json(res,200,{goals:(await graph.nodes(taskId,'goal')).map(goalDTO)});
    else{const rows=(await ctx.pool.query("SELECT * FROM task_constraints WHERE task_id=$1 ORDER BY CASE WHEN kind='allow' THEN 0 ELSE 1 END,id",[taskId])).rows;
      json(res,200,{constraints:rows.map(c=>({id:String(c.id),kind:c.kind,text:c.text,...(c.origin?{origin:c.origin}:{}),ts:new Date(c.created_at).toISOString().replace(/\.\d{3}Z$/,'Z')}))});}return true;
  }
  if(ctx.taskEngine.isDeleting(taskId)){json(res,409,{error:`The task is being deleted and cannot be${method==='DELETE'?"Delete":method==='POST'?"New":"Modification"}${kind==='goals'?"Target":"Constraints"}`});return true;}
  const revive=async()=>{await ctx.pool.query("UPDATE tasks SET status='running',paused=FALSE,completed_at=NULL WHERE id=$1 AND deleted_at IS NULL",[taskId]);await reopenExploration(ctx.pool,taskId);ctx.taskEngine.resume(taskId);};
  try{
    const body=method==='DELETE'?{}:await readJson(req);if(!body){json(res,400,{error:'invalid JSON'});return true;}
    if(method==='POST'&&!nodeId){
      if(!String(body.text??'').trim()){json(res,400,{error:kind==='goals'?"Target content cannot be empty":"Constraint content cannot be empty"});return true;}
      await graph.ensure(taskId);
      if(kind==='goals'){const id=await graph.addGoal(taskId,body);const n=await graph.node(taskId,id);await revive();json(res,200,goalDTO(n!));}
      else{const id=await graph.addConstraint(taskId,{...body,type:body.kind??body.type});json(res,200,{id:String(id),kind:body.kind??body.type??'deny',text:String(body.text).trim(),origin:'human'});}
    }else if(nodeId&&['PUT','DELETE'].includes(method)){
      if(kind==='goals'){
        const n=await graph.node(taskId,nodeId,false);if(!n||n.kind!=='goal'){json(res,404,{error:"Target does not exist"});return true;}
        if(method==='DELETE')await graph.transaction(taskId,async c=>{await c.query('DELETE FROM exploration_nodes WHERE id=$1 AND task_id=$2',[nodeId,taskId]);});
        else{
          const text=String(body.text??'').trim();if(!text){json(res,400,{error:"Target content cannot be empty"});return true;}
          await graph.transaction(taskId,async c=>{await c.query("UPDATE exploration_nodes SET title=$2,payload=$3,content_version=content_version+1,updated_at=now() WHERE id=$1",[nodeId,text,JSON.stringify({text,...(body.vulnclass?{vulnclass:String(body.vulnclass).trim()}:{})})]);});
          await revive();
        }
        ctx.taskEngine.notify(taskId);json(res,200,method==='DELETE'?{ok:true}:goalDTO((await graph.node(taskId,nodeId))!));
      }else{
        const current=(await ctx.pool.query('SELECT * FROM task_constraints WHERE id=$1 AND task_id=$2',[nodeId,taskId])).rows[0];if(!current){json(res,404,{error:"Constraint does not exist"});return true;}
        if(method==='DELETE')await graph.transaction(taskId,async c=>{await c.query('DELETE FROM task_constraints WHERE id=$1 AND task_id=$2',[nodeId,taskId]);});
        else{const text=String(body.text??'').trim(),kind=String(body.kind??'deny').trim().toLowerCase();if(!text||!['allow','deny'].includes(kind)){json(res,400,{error:!text?"Constraint content cannot be empty":"kind must be allow or deny"});return true;}
          await graph.transaction(taskId,async c=>{await c.query('UPDATE task_constraints SET text=$2,kind=$3,updated_at=now() WHERE id=$1',[nodeId,text,kind]);});}
        json(res,200,{ok:true});
      }
    }else json(res,405,{error:'method not allowed'});
  }catch(e){json(res,400,{error:e instanceof Error?e.message:String(e)});}
  return true;
}
