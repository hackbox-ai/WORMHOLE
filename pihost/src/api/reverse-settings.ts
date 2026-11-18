import type{IncomingMessage,ServerResponse}from'node:http';
import type{AppContext}from'./server.ts';
import{readObject}from'./json-body.ts';
export async function routeReverseSettings(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 const root=url.pathname==='/api/reverse/capabilities',task=url.pathname.match(/^\/api\/tasks\/(\d+)\/code-analysis$/);if(!root&&!task)return false;
 const runtime=ctx.taskEngine?.reverseRuntime;if(!runtime){json(res,503,{error:"Analysis service is not ready yet"});return true;}
 try{if(task&&req.method==='GET'){const id=Number(task[1]);if(!(await ctx.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rowCount){json(res,404,{error:"Task does not exist"});return true;}json(res,200,await runtime.taskSummary(id));return true;}
 if(root&&req.method==='GET'){json(res,200,await runtime.payload(url.searchParams.get('refresh')==='1'));return true;}
 if(root&&req.method==='PUT'){json(res,200,await runtime.apply(await readObject(req,16384)));return true;}json(res,405,{error:"Unsupported operation"});
 }catch(e){json(res,req.method==='PUT'?400:500,{error:e instanceof Error?e.message:"Analysis configuration operation failed"});}return true;
}
