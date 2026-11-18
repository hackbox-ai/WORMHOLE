import {appendEvents, type LedgerRow} from './ledger.ts';
import type {Pool} from 'pg';

/** Preserve every SSE event and its order, with bounded INSERT batches instead
 * of one promise/round trip per token. flush is a durability barrier. */
export class EventBatchWriter {
  private queue:LedgerRow[]=[];
  private tail:Promise<void>=Promise.resolve();
  private timer:ReturnType<typeof setTimeout>|undefined;
  private failure:unknown;
  deadCount=0;
  constructor(private pool:Pool,private dlq:string,private batchSize=64){}
  append(row:LedgerRow):void {
    this.queue.push(row);
    if(this.queue.length>=this.batchSize)this.drain();
    else if(!this.timer)this.timer=setTimeout(()=>this.drain(),20);
  }
  private drain():void {
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    const rows=this.queue.splice(0);
    if(!rows.length)return;
    this.tail=this.tail.then(async()=>{
      for(let i=0;i<rows.length;i+=this.batchSize){
        const chunk=rows.slice(i,i+this.batchSize);
        if(!await appendEvents(this.pool,this.dlq,chunk))this.deadCount+=chunk.length;
      }
    }).catch(error=>{this.failure??=error;});
  }
  async flush():Promise<number>{
    this.drain();
    let previous:Promise<void>;
    do{previous=this.tail;await previous;this.drain();}while(previous!==this.tail);
    if(this.failure)throw this.failure;
    return this.deadCount;
  }
}
