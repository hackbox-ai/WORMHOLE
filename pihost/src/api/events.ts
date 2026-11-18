/**
 * B07 SSE Event Replay - From business_events Persistent ledger button cursor Reissue。
 * Refreshing the page does not rely on the memory ring buffer to restore history（RUNBOOK §2）。
 * GET /api/events?kind=<business_kind>&id=<business_id>&cursor=<seq>
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {eventPage} from '../storage/cold-events.ts';
import {replaySessionPayload} from '../pi/event-payload.ts';
import {ArchiveRowReader} from '../storage/event-archive.ts';

export async function streamEvents(req: IncomingMessage, res: ServerResponse, pool: Pool, dataDir?:string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const kind = url.searchParams.get("kind") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const sequence=(value:unknown)=>typeof value==='string'&&/^\d{1,19}$/.test(value)&&BigInt(value)<=9223372036854775807n?value:'0';
  let cursor = sequence(url.searchParams.get('cursor'));
  const lastEventID = sequence(req.headers['last-event-id']);
  if (BigInt(lastEventID) > BigInt(cursor)) cursor = lastEventID;

  if (!kind || !id) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "missing kind/id" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 2000\n\n`);

  let closed = false;
  let wake:()=>void=()=>{};
  const close=()=>{closed=true;wake();};
  req.on('close',close);res.on('close',close);res.on('error',close);
  const wait=(drain:boolean)=>new Promise<void>(resolve=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const done=()=>{if(timer)clearTimeout(timer);res.off('drain',done);wake=()=>{};resolve();};
    wake=done;
    if(drain)res.once('drain',done);else timer=setTimeout(done,1000);
    if(closed)done();
  });

  const archiveReader=new ArchiveRowReader(8*1024**2,4,1024**2);
  try{
  while (!closed) {
    const rows = await eventPage(pool,kind,id,cursor,dataDir,200,archiveReader);
    for (const row of rows) {
      if(closed)break;
      if(!res.write(`id: ${row.seq}\nevent: ${row.event_type}\ndata: ${JSON.stringify({ seq: row.seq, ts: undefined, event_type: row.event_type, payload: replaySessionPayload(row.event_type,row.payload) })}\n\n`))await wait(true);
      cursor = row.seq;
    }
    // Drain a historical backlog immediately. Poll only after catching up.
    if(!closed&&rows.length<200)await wait(false);
  }
  }finally{archiveReader.clear();req.off('close',close);res.off('close',close);res.off('error',close);res.end();}
}
