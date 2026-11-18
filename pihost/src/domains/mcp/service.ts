/**
 * F13 MCP Configuration, tool discovery and connection management。
- CRUD + Atom tools Cache; official SDK Implementation stdio / Streamable HTTP / SSE。
- session.ts Implement binding by role、Skill Unlocking, Delay Tools and Practice tools/call。
 */
import { discoverMcp } from "./client.ts";
import type { Pool } from "pg";
import { appendEvent } from "../../events/ledger.ts";

export interface McpServerRecord {
  id?: number;
  name?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  insecure?: boolean;
  tools?: string[];
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
  ) {}

  async list(): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      `SELECT m.id, m.name, m.transport, m.command, m.args, m.env, m.url, m.enabled, m.insecure,
              COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name) FROM mcp_tools_cache t WHERE t.server_id=m.id), '[]'::jsonb) AS tools
       FROM mcp_servers m ORDER BY m.id`,
    );
    // Baseline Shape：id Numeric value; empty field press omitempty Omitted（command/url/tools）
    return r.rows.map((row: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...row, id: Number(row.id) };
      if (!out.command) delete out.command;
      if (!out.url) delete out.url;
      if (Array.isArray(out.tools) && (out.tools as unknown[]).length === 0) delete out.tools;
      if (out.env && Object.keys(out.env as object).length === 0) { /* Baseline empty object retained */ }
      return out;
    });
  }

  async create(input: McpServerRecord): Promise<{ ok: true; server: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    if (!input.name?.trim()) return { ok: false, status: 400, error: "name cannot be empty" };
    const transport = input.transport ?? "stdio";
    if (!["stdio", "http", "sse"].includes(transport)) return { ok: false, status: 400, error: "transport must be stdio | http | sse" };
    if (transport === "stdio" && !input.command) return { ok: false, status: 400, error: "stdio requires command" };
    if (transport !== "stdio" && !input.url) return { ok: false, status: 400, error: "http requires url" };
    const r = await this.pool.query(
      `INSERT INTO mcp_servers (name, transport, command, args, env, url, enabled, insecure)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,COALESCE($7,TRUE),COALESCE($8,FALSE))
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [input.name.trim(), transport, input.command ?? "", JSON.stringify(input.args ?? []), JSON.stringify(input.env ?? {}), input.url ?? "", input.enabled ?? null, input.insecure ?? null],
    );
    if ((r.rowCount ?? 0) === 0) return { ok: false, status: 400, error: "MCP name already exists" };
    await this.audit("mcp_created", { name: input.name });
    return { ok: true, server: r.rows[0] };
  }

  async remove(id: number): Promise<boolean> {
    const tx=await this.pool.connect();let removed=false;
    try{await tx.query('BEGIN');await tx.query("DELETE FROM agent_visibility WHERE resource_kind='mcp' AND resource_id=$1",[String(id)]);removed=!!(await tx.query('DELETE FROM mcp_servers WHERE id=$1',[id])).rowCount;await tx.query('COMMIT');}
    catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
    if(removed)await this.audit('mcp_deleted',{id});return removed;
  }

  async cachedTools(id: number): Promise<Record<string, unknown>[] | null> {
    const exists = await this.pool.query("SELECT 1 FROM mcp_servers WHERE id=$1", [id]);
    if ((exists.rowCount ?? 0) === 0) return null;
    const r = await this.pool.query("SELECT name, description, schema FROM mcp_tools_cache WHERE server_id=$1 ORDER BY name", [id]);
    return r.rows;
  }

  async cachedToolsByAgent(agentKey:string):Promise<{serverName:string;name:string;description:string;schema:Record<string,unknown>}[]>{
    const r=await this.pool.query(`SELECT m.name AS "serverName",t.name,t.description,t.schema
      FROM mcp_tools_cache t JOIN mcp_servers m ON m.id=t.server_id
      JOIN agent_visibility v ON v.resource_kind='mcp' AND v.resource_id=m.id::text AND v.agent_key=$1
      WHERE m.enabled ORDER BY m.id,t.name`,[agentKey]);return r.rows;
  }
  async enabledServers():Promise<McpServerRecord[]>{
    return (await this.pool.query('SELECT * FROM mcp_servers WHERE enabled ORDER BY id')).rows;
  }
  async get(id:number):Promise<McpServerRecord|null>{
    return (await this.pool.query('SELECT * FROM mcp_servers WHERE id=$1',[id])).rows[0]??null;
  }
  /** WORMHOLE POST /api/mcp saves a full record (id=0 adds, nonzero updates). */
  async save(input:McpServerRecord,options:{discover?:boolean}={}):Promise<number>{
    const values=[input.name??'',input.transport??'',input.command??'',JSON.stringify(input.args===undefined?[]:input.args),JSON.stringify(input.env===undefined?{}:input.env),input.url??'',input.enabled??false,input.insecure??false];
    let id=Number(input.id)||0;
    if(id){await this.pool.query(`UPDATE mcp_servers SET name=$1,transport=$2,command=NULLIF($3,''),args=$4::jsonb,env=$5::jsonb,url=NULLIF($6,''),enabled=$7,insecure=$8,updated_at=now() WHERE id=$9`,[...values,id]);}
    else{id=Number((await this.pool.query(`INSERT INTO mcp_servers(name,transport,command,args,env,url,enabled,insecure) VALUES($1,$2,NULLIF($3,''),$4::jsonb,$5::jsonb,NULLIF($6,''),$7,$8) RETURNING id`,values)).rows[0].id);if(input.enabled&&options.discover!==false)await this.refresh(id);}
    await this.audit('mcp_saved',{id,name:input.name});return id;
  }
  /** refresh：Real connection pull tools and update cache */
  async refresh(id: number): Promise<{ ok: boolean; count?: number; error?: string }> {
    const r = await this.pool.query("SELECT * FROM mcp_servers WHERE id=$1", [id]);
    if ((r.rowCount ?? 0) === 0) return { ok: false, error: "MCP does not exist" };
    const server = r.rows[0] as unknown as McpServerRecord;
    try {
      const tools = await discoverMcp(server);
      const tx=await this.pool.connect();
      try{
        await tx.query('BEGIN');
        // A concurrent edit cannot publish discovery results for stale config.
        const locked=(await tx.query('SELECT * FROM mcp_servers WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!locked||JSON.stringify(locked)!==JSON.stringify(server))throw new Error("MCP configuration has been changed, please refresh again");
        await tx.query('DELETE FROM mcp_tools_cache WHERE server_id=$1',[id]);
        for(const t of tools)await tx.query(`INSERT INTO mcp_tools_cache(server_id,name,description,schema,refreshed_at) VALUES($1,$2,$3,$4::jsonb,now())`,[id,t.name,t.description??'',JSON.stringify(t.inputSchema??{})]);
        await tx.query('COMMIT');
      }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
      await this.audit("mcp_refreshed", { id, count: tools.length });
      return { ok: true, count: tools.length };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "mcp", business_id: "global", event_type: event, payload });
  }
}
