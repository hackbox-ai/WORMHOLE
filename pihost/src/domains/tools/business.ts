/**
 * G04：Business tool registration for task isolation（insert_assets / report_finding）。
 *
 * Original defect：engine.workerTools Each worker Write capture to global registry taskId of execute Closure，
 * Task B Post-registration tasks A of runTool Will get B Executor - Asset/found writing B、Audit notes A。
 *
 * Fixed the contract: the global registry only has the stability of ”no task state” handler；Task ownership is determined by each call
 * ToolContext（The host is determined and does not trust the model parameters) carried：worker Session ctx.taskId=Task id，
 * Dialogue session ctx.conversationId=Session id（task_id is empty=Cross-task/Independent penetration registration）。
 * engine and platform This registration is called (idempotent, equivalent, repeated registration is harmless)）。
 */
import {browserAuth} from "../browser/auth.ts";
import { registerTool } from "./gate.ts";
import seeds from './business-tool-seeds.json' with {type:'json'};
import type {SourceAssetInput} from '../assets/source-writes.ts';
import type {FindingRecordInput} from '../findings/service.ts';
import {targetRequest} from '../traffic/network.ts';
import type {EvidenceStore} from '../findings/evidence.ts';
import {registerEvidenceTools} from '../findings/evidence-tools.ts';
import type {ModelingService} from '../modeling/service.ts';
import {MODELING_HTTP_TIMEOUT_MS} from '../modeling/execution.ts';

export interface BusinessToolDeps {
  trafficFlow?:import('../traffic/flow.ts').TrafficFlow;
  reverseProxies?:Pick<import('../reverse/proxy.ts').ReverseProxies,'authorize'>;
  fingerprints?:import('../fingerprints/service.ts').FingerprintService;
  modeling?:ModelingService;
  assets: {
    upsertSource(
      input:SourceAssetInput,
      opts?: { viaAgent?: boolean; endpointTool?:boolean },
    ):Promise<{ok:boolean;status:number;asset?:Record<string,unknown>;error?:string}>;
  };
  findings: {
    evidenceStore?:EvidenceStore;
    record(input:FindingRecordInput):Promise<Record<string,unknown>>;
  };
}

export function registerBusinessTools(deps: BusinessToolDeps): void {
  if(deps.findings.evidenceStore)registerEvidenceTools(deps.findings.evidenceStore);
  // G06：HTTP Introduction to Detection - Original worker/pentest Adaptation layer direct connection fetch，Bypass interception/Approval/Audit。
  // Now with assets/Found sharing the same registration：schema Verification → Rules → judge → ask → Execute → Audit。
  registerTool({
    key: "http_request",
    description: "HTTP request",
    params: { url: "string", method: "string", body: "string", proxy: "string",check_id:"string" },
    schema:{type:'object',properties:{url:{type:'string'},method:{type:'string'},body:{type:'string'},proxy:{type:'string'},headers:{type:'object',additionalProperties:{type:'string'}},browser_environment:{type:'string',format:'uuid'},check_id:{type:'string',format:'uuid'}},required:['url'],additionalProperties:false},
    required: ["url"],
    execute: async (p, ctx) => {
      const url = String(p.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error("URL needs to start with http:// or https://");
      const method = (String(p.method ?? "GET")).toUpperCase();
      // Optional per-call proxy. A reverse-engineering proxy only listens on
      // loopback and only loopback is accepted, so one worker cannot turn this
      // into a general-purpose relay.
      const proxy = String(p.proxy ?? "").trim();
      if (proxy) {
        let parsed: URL;
        try { parsed = new URL(proxy); } catch { throw new Error("proxy must be in the formhttp://127.0.0.1:port"); }
        if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) throw new Error("proxy only allows local loopback addresses");
      }
      const headers:Record<string,string>={};
      if(p.headers){if(typeof p.headers!=='object'||Array.isArray(p.headers))throw new Error("headers must be objects");for(const [k,v] of Object.entries(p.headers as Record<string,unknown>)){if(typeof v!=='string'||/[\r\n]/.test(k+v)||k.toLowerCase().startsWith('x-wormhole-'))throw new Error("Invalid request header");headers[k.toLowerCase()]=v;}}
      let browserSession:Awaited<ReturnType<typeof browserAuth>>|undefined;
      let browserIdentity:Awaited<ReturnType<typeof browserAuth>>['receipt']|undefined;
      if(p.browser_environment){
        if(headers.cookie||headers.authorization)throw new Error("Do not pass additional Cookie/Authorization when using the browser environment; please omit browser_environment for anonymous or custom identity requests");
        const auth=await browserAuth(ctx,String(p.browser_environment),url);browserSession=auth;Object.assign(headers,auth.headers);browserIdentity=auth.receipt;
      }
      const checkId=p.check_id?String(p.check_id):undefined;
      let route:import('../traffic/network.ts').TargetRoute|undefined;
      if(proxy){if(!deps.reverseProxies)throw new Error("Reverse proxy manager is unavailable");route=await deps.reverseProxies.authorize(ctx.taskId,proxy,url,method);}
      if(checkId){if(!deps.trafficFlow)throw new Error("Check registration not available");await deps.trafficFlow.request(ctx,checkId,url,method,headers,route?.reverseProxyId);}
      const resp=await targetRequest(url,method,method==='GET'||method==='HEAD'?undefined:String(p.body??''),
        ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(ctx.agentKey==='modeler'?MODELING_HTTP_TIMEOUT_MS:20_000)]):AbortSignal.timeout(ctx.agentKey==='modeler'?MODELING_HTTP_TIMEOUT_MS:20_000),proxy||undefined,{taskId:ctx.taskId,intentId:ctx.intentId,checkId,proxyId:route?.reverseProxyId,browserEnvironmentId:browserIdentity?.environment_id},headers,route);
      if(browserSession?.acceptResponse)await browserSession.acceptResponse(resp.headers);
      if(checkId&&resp.capture_id)await deps.trafficFlow!.attach(checkId,resp.capture_id);
      if(deps.fingerprints&&ctx.taskId)await deps.fingerprints.observeHTTP({taskId:ctx.taskId,intentId:ctx.intentId,businessId:ctx.businessId,signal:ctx.signal,canExecute:ctx.canExecute},{url,method,status:resp.status,headers:resp.headers,body:resp.body,bytes:resp.bytes}).catch(e=>console.warn('[fingerprints] capture:',String(e)));
      const headerMap = Object.fromEntries(Object.entries(resp.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const contentType = String(headerMap['content-type'] ?? '');
      const textual = !contentType || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|x-ndjson))|\+json|\+xml/i.test(contentType);
      const binary = !textual || resp.body.includes('\uFFFD');
      const bodyText = binary ? '' : resp.body.slice(0, 15000);
      const truncationNote = resp.decode_error
        ? `The text cannot be decoded (${resp.decode_error}): original bytes, length preserved ${resp.bytes.length}; If you need clear text, use download_file to get the complete package or change to a smaller request.`
        : resp.truncated
          ? (resp.undecoded
            ? `Response exceeded ${resp.bytes.length} The bytes are truncated, and the text is compressed: no decoding, only a prefix is given; for complete content, use download_file or request with Range`
            : `Response exceeded ${resp.bytes.length} Bytes are truncated, the body is just a prefix, do not treat it as a complete response`)
          : '';
      const binaryNote = binary ? { binary: true, bytes: resp.bytes.length,
        note: `Response is binary (${contentType || "Type not declared"}，${resp.bytes.length} bytes), no text is returned; if you need to download, please use download_file.` } : {};
      return { ...(browserIdentity?{browser_auth:browserIdentity}:{}),request_id: resp.request_id, capture_id: resp.capture_id, wire_capture_id: resp.wire_capture_id,
        status: resp.status, headers: resp.headers, body: bodyText,
        ...(resp.truncated ? {truncated: true, received_bytes: resp.bytes.length} : {}),
        ...(resp.decode_error ? {decode_error: resp.decode_error} : {}),
        ...(truncationNote ? {note: truncationNote} : {}), ...binaryNote,
        ...(deps.fingerprints&&ctx.taskId?{fingerprints:await deps.fingerprints.receipt(ctx.taskId,url).catch(()=>({state:'unavailable'}))}:{}) };
    },
  });

  registerTool({
    key: "insert_assets",
    description: "Asset storage",
    params: {},required: [],schema:seeds.find(s=>s.Key==='insert_assets')!.Schema,
    execute: async (p, ctx) => {
      const results:{index:number;id:number;type:string}[]=[],errors:{index:number;error:string}[]=[];
      const modelingJobs:unknown[]=[],modelingErrors:string[]=[];
      for(const [index,item] of (p.assets as SourceAssetInput[]).entries()){
        const input={...item,type:item.type.trim(),source:'agent',task_id:ctx.taskId??null,owner_node_id:ctx.intentId};
        // Original endpoint tool accepts its optional enrichment service_ip;
        // its plain ip field is a gate candidate but is not persisted there.
        const r=await deps.assets.upsertSource(input,{viaAgent:true,endpointTool:true});
        if(r.ok){
          results.push({index,id:Number(r.asset!.id),type:input.type});
          if(deps.fingerprints&&ctx.taskId&&input.url)await deps.fingerprints.assetRegistered(ctx.taskId,Number(r.asset!.id),input.url).catch(e=>console.warn('[fingerprints] asset:',String(e)));
          if(deps.modeling&&ctx.taskId&&input.type==='service'&&/^https?:\/\//i.test(input.url??'')){
            try{modelingJobs.push(await deps.modeling.request({target:input.url!,name:input.page_title,task_id:ctx.taskId,intent_id:ctx.intentId,asset_id:Number(r.asset!.id),trigger:'discovery',reason:`Agent registration Web system entrance, source asset #${r.asset!.id}`}));}
            catch(e){modelingErrors.push(`${input.url}: ${String(e)}`);}
          }
        }else errors.push({index,error:r.error??"Asset storage failed"});
      }
      // Per-item failures remain structured results. Partial success
      // is not turned into a failed whole batch after some writes committed.
      return {results:results.length?results:null,errors:errors.length?errors:null,...(modelingJobs.length?{modeling_jobs:modelingJobs}:{}),...(modelingErrors.length?{modeling_errors:modelingErrors}:{})};
    },
  });

  registerTool({
    key: "report_finding",
    description: "Report findings",
    params: {},required: [],schema:seeds.find(s=>s.Key==='report_finding')!.Schema,
    execute: async (p, ctx) => {
      if(!ctx.taskId)throw new Error("report_finding requires task context; for platform dialogue, please use add_task_hint to hand over the vulnerability to the corresponding task, and carry the existing traffic_refs in the prompt, which will be registered by the task agent. Registered vulnerabilities can be patched using bind_finding_traffic.");
      const r=await deps.findings.record({...p,task_id:ctx.taskId,intent_id:Number(p.intent_id)||0,worker:ctx.workerName??(ctx.agentKey==='mainagent'?'human':ctx.agentKey==='planner'?'planner':ctx.businessId)} as FindingRecordInput);
      return `finding recorded: ${r.finding_node_id}\n${JSON.stringify(r)}`;
    },
  });
}
