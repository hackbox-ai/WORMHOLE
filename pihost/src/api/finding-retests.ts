import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
export async function routeFindingRetests(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
 const active=url.pathname==='/api/exploration/findings/retests/active',match=url.pathname.match(/^\/api\/exploration\/findings\/([^/]+)\/retests$/);
 if(!active&&!match)return false;if(req.method!=='GET'&&req.method!=='POST')return false;
 if(!ctx.findingRetests){json(res,503,{error:'retest runtime is not available'});return true;}
 try{
  if(active&&req.method==='GET'){json(res,200,{retests:await ctx.findingRetests.active()});return true;}
  if(!match)return false;const raw=match[1]!,id=Number(raw);
  if(!/^[+-]?\d+$/.test(raw)||id<=0||!Number.isSafeInteger(id)){json(res,400,{error:'bad finding id'});return true;}
  if(req.method==='GET'){
   if(!(await ctx.pool.query('SELECT 1 FROM findings WHERE id=$1',[id])).rowCount)json(res,404,{error:'finding not found'});
   else json(res,200,{retests:await ctx.findingRetests.history(id)});return true;
  }
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>64*1024){json(res,413,{error:"Request body is too large"});return true;}chunks.push(b);}
  let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:size?'invalid JSON':'EOF'});return true;}
  if(body!=null&&(typeof body!=='object'||Array.isArray(body))){json(res,400,{error:'invalid JSON object'});return true;}
  if(body?.notes!=null&&typeof body.notes!=='string'){json(res,400,{error:`json: cannot unmarshal ${typeof body.notes} into Go struct field .notes of type string`});return true;}
  const r=await ctx.findingRetests.start(id,body?.notes??'');json(res,r.status,r.ok?r.body:{error:r.error});
 }catch(e){json(res,500,{error:(e as Error).message});}return true;
}
