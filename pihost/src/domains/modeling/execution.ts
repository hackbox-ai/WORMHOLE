import {ModelingError} from './service.ts';

export const MODELING_HTTP_TIMEOUT_MS=8000;
export interface ModelingEntrance {status:number;body:string}
type ProbeResult={status:string;output?:unknown;error?:string;executionFailed?:boolean};
/** Use the ordinary audited HTTP gate and configured target route, never a bypass. */
export async function probeModelingEntrance(target:string,execute:()=>Promise<ProbeResult>,signal?:AbortSignal):Promise<ModelingEntrance>{
  let last="No target response received";
  for(let attempt=0;attempt<2;attempt++){
    signal?.throwIfAborted();
    const result=await execute();signal?.throwIfAborted();
    if(result.status==='executed'){
      const output=result.output as {status?:unknown;body?:unknown}|undefined,status=Number(output?.status);
      if(status>=100&&status<=599)return {status,body:String(output?.body??'').slice(0,8000)};
      last="HTTP tool did not return a valid status code";
    }else{
      last=result.error??result.status;
      if(!result.executionFailed&&result.status!=='error')throw new ModelingError("Ingress check blocked by tool policy:"+last,409);
    }
  }
  throw new ModelingError(`The target entrance is unreachable:${target}; Two requests did not get an HTTP response (up to 8 seconds each). Please check the current target exit, DNS, or global proxy and try again. The existing draft has been retained, and common sense inference will not be used as the target actual measurement results. Final error:${last.slice(0,200)}`,409);
}

export const MODELING_EXECUTION_GUIDANCE=`
Modeling is only responsible for Web interfaces, entities and relationships, and does not take over the acceptance steps, vulnerability verification, original TCP/UDP testing or delivery reports of the original task; the original task goals and descriptions are only used to limit the scope of authorization. The text passed in by the host does not require you to perform the original task again.
Modeling execution strategy: First deliver a reusable, streamlined first version, and then deepen it through incremental modeling. Reuse the entry response provided by the host to avoid repeatedly requesting the same entry. When crawling pages, JS, and APIs, priority is given to obtaining a small amount of key evidence in parallel; if the same entry fails twice in a row, retry will be stopped. Cross-site network troubleshooting is not performed, and there is no need for curl --retry or long TaskOutput waiting.
First save 2 to 3 identified interfaces and core entities, and then add them by module. Limit each submission to approximately 2,000 output tokens; omit large paragraphs of examples, duplicate responses, and unfounded field enumerations. There is only one operation for the same path and HTTP method. Multiple actions are summarized by parameter enumeration or x-wormhole-actions, and the entire submitted content is not rewritten. After the main modules have been covered, api_model_done is timely to explain the coverage and gaps. It is not required to exhaust all functions.
api_model_submit Minimum legal fragment example: {"paths":{"/health":{"get":{"responses":{"200":{"description":"Success"}}}}}}. Each status code response object requires a description string; operation.description is not a substitute for responses["200"].description. The original content/schema can be retained, and there is no need to delete the response structure to modify the description.
The paths of api_model_submit only contain paths starting with /; responses only contain status codes, and summary/tags are placed in the operation layer. The openapi document object is placed in the document header, and the entities are placed in the outermost entities. Don't stuff openapi/info/entities into paths, and don't use the entire public framework's memory as target site evidence. The parts without actual evidence are explicitly left as gaps.`;

export const MODELING_SETTLEMENT_PROMPT="Expansion of the modeling scope is now stopped, and further network requests or long-term commands are prohibited. Check the submitted draft and only complete necessary local references and entity relationships; api_model_done immediately after passing the verification, and use a short summary to explain what has been covered, not covered, and inferred. If there is insufficient evidence or the draft cannot be corrected, clearly state the reason for the obstruction and keep the draft, and do not make it up.";

export function modelingRunBudget(deadlineMs:number,ownSeconds:number,now=Date.now()){
  const total=Math.max(2,Math.min(ownSeconds>0?ownSeconds:900,deadlineMs>0?(deadlineMs-now)/1000:900));
  const settlementSeconds=Math.min(60,Math.max(1,total/5));
  return {seconds:Math.max(1,total-settlementSeconds-5),settlementSeconds};
}
