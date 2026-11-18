import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {LlmRecords} from '../domains/observability/records.ts';
import {TaskPerformance} from '../domains/observability/task-performance.ts';

function integer(raw:string|null,fallback:number):number{
 if(raw==null||!/^[-+]?\d+$/.test(raw))return fallback;
 const value=Number(raw);return Number.isSafeInteger(value)?value:fallback;
}
export async function routeLlmRecords(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,value:unknown)=>void):Promise<boolean>{
 const path=url.pathname,records=new LlmRecords(ctx.pool);
 try{
  const performance=/^\/api\/tasks\/([1-9]\d*)\/performance$/.exec(path);
  if(performance&&req.method==='GET'){
   if(BigInt(performance[1]!)>(1n<<63n)-1n){json(res,400,{error:'invalid task id'});return true;}
   const report=await new TaskPerformance(ctx.pool).report(performance[1]!);
   json(res,report?200:404,report??{error:'not found'});return true;
  }
  if(path==='/api/llm/records/tasks'&&req.method==='GET'){
   json(res,200,{tasks:await records.tasks()});return true;
  }
  if(path==='/api/llm/records/by-model'&&req.method==='GET'){
   const task=(url.searchParams.get('task')??'').trim();if(!task){json(res,400,{error:'missing task'});return true;}
   json(res,200,{models:await records.models(task)});return true;
  }
  if(path==='/api/llm/records'&&req.method==='GET'){
   const page=integer(url.searchParams.get('page'),0),size=integer(url.searchParams.get('size'),50);
   const result=await records.list({model:url.searchParams.get('model')??'',session:url.searchParams.get('session')??'',task:url.searchParams.get('task')??''},page,size);
   json(res,200,result);return true;
  }
  if(path==='/api/llm/records'&&req.method==='DELETE'){
   const task=(url.searchParams.get('task')??'').trim();if(!task){json(res,400,{error:'missing task'});return true;}
   json(res,200,{deleted:await records.remove(task)});return true;
  }
  const match=/^\/api\/llm\/records\/([^/]+)$/.exec(path);
  if(match&&req.method==='GET'){
   if(!/^[+-]?\d+$/.test(match[1]!)){json(res,400,{error:'invalid id'});return true;}
   const id=BigInt(match[1]!);if(id<-(1n<<63n)||id>(1n<<63n)-1n){json(res,400,{error:'invalid id'});return true;}
   const record=await records.detail(String(id));if(!record){json(res,404,{error:'not found'});return true;}
   json(res,200,record);return true;
  }
 }catch(e){json(res,500,{error:(e as Error).message??String(e)});return true;}
 return false;
}
