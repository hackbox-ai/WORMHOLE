/** Numeric diagnostics only: no prompts, tool inputs, credentials or response text. */
export interface ModelCallPerformance {
  version:1;startedAt:string;totalMs:number;firstContentMs:number|null;afterFirstContentMs:number|null;
  rateWaitMs:number;retryWaitMs:number;httpWaitMs:number;httpAttempts:number;
  requestBytes:number;responseBytes:number;contextMessages:number;tools:number;systemBytes:number;
}
export class CallPerformance {
  private start:number;private ended?:number;private first?:number;
  private rateWait=0;private retryWait=0;private httpWait=0;private attempts=0;
  private requestSize=0;private responseSize=0;private messages=0;private tools=0;private systemSize=0;
  readonly startedAt=new Date().toISOString();
  constructor(private now=()=>performance.now()){this.start=now();}
  context(messages:number,tools:number,systemBytes:number){this.messages=messages;this.tools=tools;this.systemSize=systemBytes;}
  request(bytes:number){this.requestSize=bytes;}
  response(bytes:number){this.responseSize+=bytes;}
  httpStart(){this.attempts++;const start=this.now();let ended=false;return()=>{if(!ended){this.httpWait+=this.now()-start;ended=true;}};}
  addRateWait(ms:number){this.rateWait+=Math.max(0,ms);}
  addRetryWait(ms:number){this.retryWait+=Math.max(0,ms);}
  observe(event:{type:string;delta?:unknown}){
    if(this.first===undefined&&(event.type==='toolcall_start'||['text_delta','thinking_delta','toolcall_delta'].includes(event.type)&&!!event.delta))this.first=this.now();
  }
  finish(){this.ended??=this.now();}
  snapshot():ModelCallPerformance {
    const end=this.ended??this.now(),round=(n:number)=>Math.round(Math.max(0,n)*1000)/1000;
    return {version:1,startedAt:this.startedAt,totalMs:round(end-this.start),firstContentMs:this.first===undefined?null:round(this.first-this.start),
      afterFirstContentMs:this.first===undefined?null:round(end-this.first),rateWaitMs:round(this.rateWait),retryWaitMs:round(this.retryWait),httpWaitMs:round(this.httpWait),
      httpAttempts:this.attempts,requestBytes:this.requestSize,responseBytes:this.responseSize,contextMessages:this.messages,tools:this.tools,systemBytes:this.systemSize};
  }
}
