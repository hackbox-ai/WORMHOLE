/**
 * F04 Discovery + F16 Notice + F05 Flow Record (Minimum Closed Loop）。
 * Notification Chain：finding Create/Status changes in the same transaction
 * Write notification_events（outbox）；Delivery loop fan-out To enable channel, try again if failed (after upper limit failed）；
 * No event occurs until the status actually changes. Snapshot evidence is immutable: after source traffic is deleted finding Evidence is still readable。
 */
import {baselineFindingReport} from './report-baseline.ts';
import {saveTaskReport} from '../tasks/report.ts';
import type { Pool } from "pg";
import {FINDING_STATUSES,setFindingStatus} from './status.ts';
import { appendEvent } from "../../events/ledger.ts";
import { ExplorationService } from '../exploration/service.ts';
import {EvidenceStore,EVIDENCE_LOCK,normalizeRefs,trafficSummary,type FindingTraffic} from './evidence.ts';
import type {PoolClient} from 'pg';
import {recordNotificationEvent} from '../notify/store.ts';

export interface FindingRecordInput {
  task_id:number;intent_id?:number;vulnclass:string;name?:string;severity:string;
  summary:string;evidence?:string;worker?:string;asset_ids?:number[];
  traffic_refs?:unknown[];evidence_hint_id?:unknown;
}

export class FindingsService {
  private onRecord:((taskId:number)=>void)|undefined;
  setOnRecord(callback:(taskId:number)=>void){this.onRecord=callback;}
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    readonly evidenceStore?:EvidenceStore,
  ) {}

  /** graph, anchors, finding and
   * notification outbox commit together. A foreign intent rolls all of it back. */
  async record(input:FindingRecordInput):Promise<{finding_id:string;finding_node_id:string;traffic:{finding_id:string;version:number;report_version:number;bindings:unknown[]};evidence_status:string;evidence_note:string}>{
    if(!input.task_id)throw new Error("report_finding requires task context; for platform dialogue, please use add_task_hint to hand over the vulnerability to the corresponding task, and carry the existing traffic_refs in the prompt, which will be registered by the task agent. Registered vulnerabilities can be patched using bind_finding_traffic.");
    const flag=(await this.pool.query("SELECT value FROM app_settings WHERE key='settings.agent_traffic_binding'")).rows[0]?.value;
    const enabled=flag==='true';
    const refs=enabled?normalizeRefs(input.traffic_refs):[];
    const hint=enabled&&input.evidence_hint_id!==undefined?Number(input.evidence_hint_id):0;
    if(enabled&&input.evidence_hint_id!==undefined&&(!Number.isSafeInteger(hint)||hint<=0))throw new Error("evidence_hint_id must be a valid hint node ID; omit when there is no handover hint");
    if(!this.evidenceStore&&(refs.length||hint))throw new Error("Traffic evidence storage is unavailable; unregistered vulnerability");
    const write=(client?:PoolClient)=>new ExplorationService(this.pool).transaction(input.task_id,async(c,eid)=>{
      if(this.evidenceStore)await this.evidenceStore.lockTask(c,input.task_id);
      let allRefs=refs;
      if(hint){const n=(await c.query("SELECT payload FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='hint'",[hint,eid])).rows[0];if(!n)throw new Error(`evidence_hint_id=${hint} Must be the prompt node of this task (inherited prompts cannot be used directly for binding)`);allRefs=normalizeRefs([...refs,...normalizeRefs(n.payload.traffic_refs)]);}
      const prepared=this.evidenceStore?.prepare(allRefs)??[];
      if(input.intent_id){const own=await c.query("SELECT 1 FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent'",[input.intent_id,eid]);if(!own.rowCount)throw new Error("intent_id must be the intent of this task (the associated task intent is read-only)");}
      const payload={vulnclass:input.vulnclass,name:input.name??'',severity:input.severity,summary:input.summary,evidence:{by:input.worker??'',poc:input.evidence??''}};
      const node=(await c.query("INSERT INTO exploration_nodes(task_id,exploration_id,kind,payload,priority,state,origin) VALUES($1,$2,'finding',$3::jsonb,9,'confirmed',$4) RETURNING id",[input.task_id,eid,JSON.stringify(payload),input.worker??''])).rows[0].id;
      for(const id of input.asset_ids??[])await c.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[node,id]);
      if(input.intent_id)await c.query("INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,'yields',$3)",[eid,input.intent_id,node]);
      const finding=(await c.query('INSERT INTO findings(task_id,node_id,vulnclass,name,severity,summary,evidence,worker,asset_ids,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$6) RETURNING id',[input.task_id,node,input.vulnclass,input.name??'',input.severity,input.summary,input.evidence??'',input.worker??'',JSON.stringify(input.asset_ids??[])])).rows[0].id;
      // Original RecordNotificationEventTx is best effort under a savepoint:
      // an outbox failure must not invalidate an otherwise valid finding.
      await recordNotificationEvent(c,{kind:'finding_created',finding_id:Number(finding),task_id:input.task_id,vulnclass:input.vulnclass,name:input.name??'',severity:input.severity,summary:input.summary,asset_ids:input.asset_ids??[]});
      if(this.evidenceStore)await this.evidenceStore.add(c,Number(finding),prepared);
      const traffic:FindingTraffic=this.evidenceStore?trafficSummary(await this.evidenceStore.listTx(c,Number(finding))):{finding_id:String(finding),version:0,report_version:0,bindings:[]};
      await c.query('UPDATE findings SET report=$2,report_evidence_version=CASE WHEN evidence_version=0 THEN 0 ELSE -1 END WHERE id=$1',[finding,baselineFindingReport({...input,node_id:Number(node)})]);
      const reportState=(await c.query('SELECT t.status,r.phase,r.reason FROM tasks t LEFT JOIN task_reports r ON r.task_id=t.id WHERE t.id=$1',[input.task_id])).rows[0];
      if(reportState?.phase||['done','failed','timeout'].includes(reportState?.status))await saveTaskReport(c,input.task_id,reportState.phase??'final',reportState.reason??"Supplement the findings of completed tasks");
      return {finding_id:String(finding),finding_node_id:String(node),traffic};
    },client);
    const result=this.evidenceStore?await this.evidenceStore.transaction(c=>write(c)):await write();
    await this.audit('finding_created',{id:result.finding_id,node_id:result.finding_node_id,task_id:input.task_id});
    this.onRecord?.(input.task_id);
    return {...result,evidence_status:result.traffic.bindings.length?'bound':'not_bound',evidence_note:result.traffic.bindings.length?'':enabled?"The vulnerability has been saved and the traffic is not bound. The TCP/no-packet situation can continue normally; if there is already verified HTTP traffic, please use the available bind_finding_traffic or vulnerability page to patch it, and then complete the evidence handover. Don't re-create vulnerabilities.":"The vulnerability has been saved. Agent's automatic binding of traffic has been turned off, and traffic can be manually associated on the page."};
  }

  async create(input: { task_id?: number | null; name: string; severity?: string; asset_ids?: number[]; detail?: string; node_id?: number | null }): Promise<{ ok: boolean; status: number; finding?: Record<string, unknown>; error?: string }> {
    if (!input.name?.trim()) return { ok: false, status: 400, error: "name cannot be empty" };
    const severity = input.severity ?? "medium";
    if (!["info", "low", "medium", "high", "critical"].includes(severity)) return { ok: false, status: 400, error: "severity illegal" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const f = await client.query(
        `INSERT INTO findings (task_id, node_id, name, severity, asset_ids, detail) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [input.task_id ?? null, input.node_id ?? null, input.name.trim(), severity, JSON.stringify(input.asset_ids ?? []), input.detail ?? ""],
      );
      await recordNotificationEvent(client,{kind:'finding_created',finding_id:Number(f.rows[0]!.id),task_id:input.task_id??0,vulnclass:'',name:input.name.trim(),severity,summary:input.detail??'',asset_ids:input.asset_ids??[]});
      await client.query("COMMIT");
      await this.audit("finding_created", { id: f.rows[0]!.id });
      return { ok: true, status: 200, finding: f.rows[0] };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async list(filter: { task?: number; severity?: string; status?: string; q?: string } = {}): Promise<Record<string, unknown>[]> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.task) { args.push(filter.task); where.push(`task_id=$${args.length}`); }
    if (filter.severity) { args.push(filter.severity); where.push(`severity=$${args.length}`); }
    if (filter.status) { args.push(filter.status); where.push(`status=$${args.length}`); }
    if (filter.q) { args.push(`%${filter.q}%`); where.push(`name ILIKE $${args.length}`); }
    return (await this.pool.query(`SELECT f.*, agg.values AS asset_values FROM findings f LEFT JOIN LATERAL (SELECT json_agg(a.value) AS values FROM assets a WHERE a.id = ANY(ARRAY(SELECT jsonb_array_elements_text(f.asset_ids))::bigint[])) agg ON TRUE WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT 200`, args)).rows;
  }

  /** Paginated list: return {items,total}，Supply /api/exploration/findings Tile view。 */
  async page(filter: { task?: number; severity?: string; status?: string; q?: string } = {}, page = 1, pageSize = 10): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.task) { args.push(filter.task); where.push(`task_id=$${args.length}`); }
    if (filter.severity && filter.severity !== "all") { args.push(filter.severity); where.push(`severity=$${args.length}`); }
    if (filter.status && filter.status !== "all") { args.push(filter.status); where.push(`status=$${args.length}`); }
    if (filter.q) { args.push(`%${filter.q}%`); where.push(`(name ILIKE $${args.length} OR detail ILIKE $${args.length})`); }
    const total = (await this.pool.query(`SELECT count(*)::int AS n FROM findings WHERE ${where.join(" AND ")}`, args)).rows[0] as { n: number };
    args.push(pageSize); const lim = args.length;
    args.push((page - 1) * pageSize); const off = args.length;
    const items = (await this.pool.query(`SELECT f.*, agg.values AS asset_values FROM findings f LEFT JOIN LATERAL (SELECT json_agg(a.value) AS values FROM assets a WHERE a.id = ANY(ARRAY(SELECT jsonb_array_elements_text(f.asset_ids))::bigint[])) agg ON TRUE WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT $${lim} OFFSET $${off}`, args)).rows;
    return { items, total: total.n };
  }

  async get(id: number): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query(`SELECT f.*, agg.values AS asset_values FROM findings f LEFT JOIN LATERAL (SELECT json_agg(a.value) AS values FROM assets a WHERE a.id = ANY(ARRAY(SELECT jsonb_array_elements_text(f.asset_ids))::bigint[])) agg ON TRUE WHERE f.id=$1`, [id]);
    return r.rows[0] ?? null;
  }

  /** Status change: no event will be sent and no notification will be sent if the value is the same */
  async changeStatus(id: number, status: string): Promise<{ ok: boolean; status: number; error?: string }> {
    if (!FINDING_STATUSES.includes(status)) return { ok: false, status: 400, error: "status illegal" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result=await setFindingStatus(client,id,status);
      if (!result.found) {
        await client.query("ROLLBACK");
        return { ok: false, status: 404, error: "finding does not exist" };
      }
      if (!result.changed) {
        await client.query("ROLLBACK");
        return { ok: true, status: 200 }; // Status unchanged: no event occurs
      }
      await client.query("COMMIT");
      await this.audit("finding_status_changed", { id, status });
      return { ok: true, status: 200 };
    } catch(e){await client.query('ROLLBACK');throw e;} finally {
      client.release();
    }
  }

  async remove(id: number): Promise<boolean> {
    const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1)',[EVIDENCE_LOCK]);
      if(this.evidenceStore){if(!(await c.query('SELECT 1 FROM findings WHERE id=$1',[id])).rowCount){await c.query('COMMIT');return false;}await this.evidenceStore.lockFinding(c,id);}
      const r=await c.query('DELETE FROM findings WHERE id=$1 RETURNING node_id',[id]);const node=r.rows[0]?.node_id;if(node)await c.query("DELETE FROM exploration_nodes WHERE id=$1 AND kind='finding'",[node]);await c.query('COMMIT');return !!r.rowCount;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  /** Original setFindingCol: standalone write commits, graph sync best effort. */
  async setColumn(id:number,column:'severity'|'name'|'vulnclass',value:string):Promise<boolean>{
    if(!['severity','name','vulnclass'].includes(column))throw new Error('invalid finding column');
    const client=await this.pool.connect();let row:any;
    try{
      await client.query('BEGIN');
      row=(await client.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row){await client.query('ROLLBACK');return false;}
      await client.query(`UPDATE findings SET ${column}=$1 WHERE id=$2`,[value,id]);
      if(column==='severity'&&!['high','critical'].includes(row.severity)&&['high','critical'].includes(value)&&!['false_positive','duplicate','ignored','fixed','resolved','risk_accepted'].includes(row.status))
        await recordNotificationEvent(client,{kind:'finding_severity_escalated',finding_id:id,task_id:Number(row.task_id??0),vulnclass:row.vulnclass??'',name:row.name??'',severity:value,summary:row.summary||row.detail||'',asset_ids:row.asset_ids??[]});
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    if(row.node_id)try{await this.pool.query('UPDATE exploration_nodes SET payload=jsonb_set(payload,$1::text[],to_jsonb($2::text)) WHERE id=$3',[[column],value,row.node_id]);}catch(e){console.error('[findings] graph column sync failed',id,column,e);}

    return true;
  }

  // ── F05 Evidence ──
  async recordExchange(x: { host: string; method?: string; path?: string; status?: number; req_body?: string; res_body?: string; task_id?: number | null }): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO traffic_exchanges (host, method, path, status, req_body, res_body, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [x.host, x.method ?? "GET", x.path ?? "", x.status ?? 0, (x.req_body ?? "").slice(0, 100_000), (x.res_body ?? "").slice(0, 100_000), x.task_id ?? null],
    );
    return r.rows[0]!.id as number;
  }

  async listExchanges(filter: { host?: string; q?: string } = {}): Promise<Record<string, unknown>[]> {
    const where: string[] = ["TRUE"];
    const args: unknown[] = [];
    if (filter.host) { args.push(filter.host); where.push(`host=$${args.length}`); }
    if (filter.q) { args.push(`%${filter.q}%`); where.push(`(path ILIKE $${args.length} OR req_body ILIKE $${args.length} OR res_body ILIKE $${args.length})`); }
    return (await this.pool.query(`SELECT id, host, method, path, status, ts, task_id FROM traffic_exchanges WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 200`, args)).rows;
  }

  async getExchange(id: number): Promise<Record<string, unknown> | null> {
    return (await this.pool.query("SELECT * FROM traffic_exchanges WHERE id=$1", [id])).rows[0] ?? null;
  }

  async deleteExchangesByHost(host: string, exact = true): Promise<number> {
    const r = exact
      ? await this.pool.query("DELETE FROM traffic_exchanges WHERE host=$1", [host])
      : await this.pool.query("DELETE FROM traffic_exchanges WHERE host LIKE $1", [`%${host}%`]);
    return r.rowCount ?? 0;
  }

  /** Evidence binding: the complete content of the snapshot (immutable), still readable after the source is deleted */
  async bindEvidence(findingId: number, exchangeId: number): Promise<boolean> {
    const x = await this.getExchange(exchangeId);
    if (!x) return false;
    const snapshot = {
      host: x.host, method: x.method, path: x.path, status: x.status,
      req_body: x.req_body, res_body: x.res_body, ts: x.ts,
    };
    await this.pool.query(
      `INSERT INTO finding_traffic_evidence (finding_id, exchange_id, snapshot) VALUES ($1,$2,$3::jsonb)`,
      [findingId, exchangeId, JSON.stringify(snapshot)],
    );
    await this.audit("evidence_bound", { findingId, exchangeId });
    return true;
  }

  async evidence(findingId: number): Promise<Record<string, unknown>[]> {
    return (await this.pool.query("SELECT id, exchange_id, snapshot, created_at FROM finding_traffic_evidence WHERE finding_id=$1 ORDER BY id", [findingId])).rows;
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "findings", business_id: "global", event_type: event, payload });
  }
}
