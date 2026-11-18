import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
/** Original deepenFinding's bounded body and response, before legacy routes. */
export async function routeFindingFollowUp(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/exploration\/findings\/([^/]+)\/deepen$/);if(!match||req.method!=='POST')return false;
  const raw=match[1]!;if(!/^[+-]?\d+$/.test(raw)||Number(raw)<=0||!Number.isSafeInteger(Number(raw))){json(res,400,{error:'bad finding id'});return true;}
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>32*1024){json(res,413,{error:"Request body is too large"});return true;}chunks.push(b);}
  let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{json(res,400,{error:'bad json: '+(length?'invalid JSON':'EOF')});return true;}
  if(body!=null&&(Array.isArray(body)||typeof body!=='object')){json(res,400,{error:`bad json: json: cannot unmarshal ${Array.isArray(body)?'array':typeof body} into Go value of type struct { Description string "json:\"description\"" }`});return true;}
  if(body?.description!=null&&typeof body.description!=='string'){json(res,400,{error:`bad json: json: cannot unmarshal ${typeof body.description} into Go struct field .description of type string`});return true;}
  try{const result=await ctx.findingsWorkflow.deepen(Number(raw),body?.description??'');json(res,result.status,result.ok?result.body:{error:result.error});}
  catch(e){json(res,500,{error:(e as Error).message});}return true;
}
