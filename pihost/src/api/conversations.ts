/** preserve DTOs, pointer patches and ID cursors. */
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {streamConversation} from './conversation-stream.ts';
import {readObject} from './json-body.ts';
import {validAttachments} from '../domains/workspace/attachments.ts';
type Reply=(res:ServerResponse,status:number,value:unknown)=>void;
const integer=(s:string|null,def=0)=>s!==null&&/^[+-]?\d+$/.test(s)&&Number.isSafeInteger(Number(s))?Number(s):def;
export async function routeConversations(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:Reply):Promise<boolean>{
 const root=url.pathname==='/api/conversations',batch=url.pathname==='/api/conversations/delete/batch';
 const m=/^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(url.pathname);
 if(!root&&!batch&&!m)return false;
 const sub=m?.[2]??'';
 if(!root&&!batch&&!['','/profile','/messages','/stop','/stream'].includes(sub)&&!/^\/messages\/[^/]+$/.test(sub))return false;
 const fail=(status:number,error:string)=>{json(res,status,{error});return true;};
 const body=async(limit=64*1024)=>{try{return await readObject(req,limit,true);}catch(e){
  const msg=(e as Error).message;fail(msg==='request body too large'?413:400,msg==='request body too large'?"Request body is too large":msg);return null;}};
 const profileOK=async(id:unknown)=>id==null||Number.isSafeInteger(id)&&!!(await ctx.pool.query("SELECT 1 FROM llm_profiles WHERE id=$1 AND api_key<>''",[id])).rowCount;
 if(root&&req.method==='GET'){json(res,200,{conversations:await ctx.conversations.list(url.searchParams.get('preview')==='1')});return true;}
 if(root&&req.method==='POST'){
  const b=await body();if(!b)return true;
  if(b.agent_key!=null&&typeof b.agent_key!=='string'||b.title!=null&&typeof b.title!=='string')return fail(400,'bad json');
  const key=String(b.agent_key??'').trim(),title=String(b.title??'').trim()||"New conversation";
  if(!key)return fail(400,"agent_key cannot be empty");if(Array.from(key).length>120)return fail(400,"agent_key maximum 120 characters");
  if(!await ctx.agents.get(key))return fail(404,"agent does not exist");
  if(!await profileOK(b.llm_profile_id))return fail(400,"The specified LLM configuration does not exist or the API Key is not set");
  if(Array.from(title).length>200)return fail(400,"Title maximum 200 characters");
  const r=await ctx.conversations.create(key,title,b.llm_profile_id??null);json(res,r.ok?200:r.status,r.ok?r.conv:{error:r.error});return true;
 }
 if(batch&&req.method==='POST'){
  const b=await body();if(!b)return true;if(b.ids!=null&&!Array.isArray(b.ids))return fail(400,'bad json');
  if((b.ids??[]).some((v:unknown)=>!Number.isSafeInteger(v)||Number(v)<=0))return fail(400,"Conversation id is invalid");
  const ids=[...new Set<number>(b.ids??[])];if(!ids.length||ids.length>100)return fail(400,"Number of ids must be 1-100");
  await Promise.all(ids.map(id=>ctx.conversations.stop(id)));
  const deleted=(await ctx.pool.query('DELETE FROM conversations WHERE id=ANY($1::bigint[]) RETURNING id',[ids])).rows;
  const present=new Set(deleted.map(r=>Number(r.id)));
  json(res,200,{items:ids.map(id=>({id,ok:present.has(id),...(!present.has(id)?{error:'conversation not found'}:{})}))});return true;
 }
 if(!m)return false;
 const id=integer(m[1]!,NaN);if(!Number.isSafeInteger(id))return fail(400,'bad conversation id');
 if(!await ctx.conversations.get(id))return fail(404,'conversation not found');
 if(sub===''&&req.method==='PATCH'){
  const b=await body();if(!b)return true;if(b.title==null&&b.pinned==null)return fail(400,"At least title or pinned are required");
  if(b.title!=null&&typeof b.title!=='string'||b.pinned!=null&&typeof b.pinned!=='boolean')return fail(400,'bad json');
  if(b.title!=null){b.title=b.title.trim();if(!b.title)return fail(400,"Title cannot be empty");if(Array.from(b.title).length>200)return fail(400,"Title maximum 200 characters");}
  const updated=await ctx.conversations.patch(id,{...(b.title!=null?{title:b.title}:{}),...(b.pinned!=null?{pinned:b.pinned}:{})});
  if(!updated)return fail(404,'conversation not found');json(res,200,updated);return true;
 }
 if(sub==='/profile'&&req.method==='PATCH'){
  const b=await body();if(!b)return true;if(!await profileOK(b.llm_profile_id))return fail(400,"The specified LLM configuration does not exist or the API Key is not set");
  await ctx.conversations.profile(id,b.llm_profile_id??null);json(res,200,{ok:true});return true;
 }
 if(sub===''&&req.method==='DELETE'){await ctx.conversations.remove(id);json(res,200,{deleted:id});return true;}
 if(sub==='/stream'&&req.method==='GET'){await streamConversation(req,res,ctx.conversations,id,url);return true;}
 if(sub==='/messages'&&req.method==='GET'){
  const q=url.searchParams,sv=q.get('since'),r=await ctx.conversations.messages(id,sv?integer(sv):undefined,integer(q.get('limit'),200),integer(q.get('before')));
  json(res,200,{...r,running:ctx.conversations.isRunning(id)});return true;
 }
 if(sub==='/messages'&&req.method==='POST'){
  const b=await body(1024*1024);if(!b)return true;if(b.message!=null&&typeof b.message!=='string')return fail(400,'bad json');
  let attachments;try{attachments=validAttachments(b.attachments);}catch(e){return fail(400,(e as Error).message);}
  const r=await ctx.conversations.send(id,b.message??'',attachments);json(res,r.status,r.status===202?{status:'accepted'}:{error:r.error});return true;
 }
 if(sub==='/stop'&&req.method==='POST'){const status=ctx.conversations.isRunning(id)?'stopping':'idle';
  void ctx.conversations.stop(id).catch(e=>console.error('[conversation] stop failed',id,e));json(res,200,{status});return true;}
 if(sub.startsWith('/messages/')&&req.method==='GET'){
  const seq=integer(sub.slice(10),NaN);if(!Number.isSafeInteger(seq))return fail(400,'bad seq');
  json(res,200,{detail:await ctx.conversations.detail(id,seq)});return true;
 }
 return false;
}
