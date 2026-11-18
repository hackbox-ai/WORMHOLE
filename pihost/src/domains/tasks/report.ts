import type {Pool,PoolClient} from 'pg';
import {reportTime} from '../findings/report.ts';
import {baselineFindingReport,evidenceBlock,evidenceText} from '../findings/report-baseline.ts';
type DB=Pick<Pool,'query'>|PoolClient;
type Phase='draft'|'final';
export function reportLeadSeconds(timeout:number):number{return Math.min(60,Math.max(5,Math.floor(timeout/10)));}

async function findings(db:DB,taskId:number){
 const rows=(await db.query(`SELECT f.id,f.node_id,f.name,f.vulnclass,f.severity,f.summary,f.evidence,f.report,f.status,f.report_status,f.evidence_version,f.report_evidence_version,n.payload
  FROM findings f LEFT JOIN exploration_nodes n ON n.id=f.node_id WHERE f.task_id=$1 ORDER BY f.id`,[taskId])).rows;
 const legacy=(await db.query("SELECT id AS node_id,payload FROM exploration_nodes n WHERE task_id=$1 AND kind='finding' AND NOT EXISTS(SELECT 1 FROM findings f WHERE f.node_id=n.id) ORDER BY id",[taskId])).rows;
 return [...rows,...legacy].map(r=>({...r,name:r.name||r.payload?.name,vulnclass:r.vulnclass||r.payload?.vulnclass,severity:r.severity||r.payload?.severity||'info',summary:r.summary||r.payload?.summary,evidence:evidenceText(r.evidence||r.payload?.evidence)}));
}
/** Live rendering includes Reporter updates and works for historical tasks too. */
export async function taskMarkdown(db:DB,taskId:number,now=new Date(),context?:{phase:Phase;reason:string}):Promise<string|null>{
 const t=(await db.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];if(!t)return null;
 if(t.archived){const saved=(await db.query('SELECT markdown FROM task_reports WHERE task_id=$1',[taskId])).rows[0];if(saved)return saved.markdown;}
 const rows=await findings(db,taskId),rank:Record<string,number>={critical:0,high:1,medium:2,low:3,info:4};rows.sort((a,b)=>(rank[a.severity]??4)-(rank[b.severity]??4));
 const counts=(await db.query('SELECT a.type,count(*)::int n FROM assets a JOIN task_asset_links l ON l.asset_id=a.id WHERE l.task_id=$1 GROUP BY a.type ORDER BY a.type',[taskId])).rows;
 const scopes=(await db.query('SELECT kind,domain,net::text,value FROM task_scope WHERE task_id=$1 ORDER BY id',[taskId])).rows;
 const states=(await db.query("SELECT id,kind,title,state,payload FROM exploration_nodes WHERE task_id=$1 AND ((kind='goal' AND payload ? 'resolution') OR (kind='intent' AND state IN('open','running','paused','blocked','stopped','exhausted'))) ORDER BY id",[taskId])).rows;
 const phase=context?.phase??(['done','failed','timeout'].includes(t.status)?'final':'draft');
 let out=`# Penetration Test Report — ${t.name?.trim()||t.description?.trim()||"Unnamed task"}

- **Test Objective**:${t.target_input||t.goal?.trim()||"(unspecified)"}
- **Generation Time**:${reportTime(now)}
- **Reporting Stage**:${phase==='final'?"Mission Ending":"Executing draft"}\n${context?.reason?"- **Ending reason**:"+context.reason+'\n':''}
## Summary

- Registered findings: **${rows.length}**
- Assets for this task:${counts.length?counts.map(r=>r.type+' '+r.n).join('、'):"There are no associated assets yet"}
- The report only organizes existing records and does not consider unverified clues or missing conditions as confirmed conclusions.

## Test range

${scopes.length?scopes.map(s=>'- '+(s.domain||s.net||s.value||s.kind)).join('\n'):"Subject to the goals and constraints of the mission statement."}

## Discovery

`;
 if(!rows.length)out+="No vulnerabilities are registered this time; this does not mean that the target does not have security issues.\n\n";
 for(const [i,f] of rows.entries()){
  out+=`### ${i+1}. [${String(f.severity).toUpperCase()}] ${f.name||f.vulnclass||"Uncategorized"}\n\n${f.summary||''}\n\n`;
  out+="- Report compilation:"+(f.report_status==='completed'?"Completed":f.report_status==='needs_evidence'?"Certificate pending":"To be improved")+'\n';
  if(f.node_id)out+="- Path node found: #"+f.node_id+'\n';
  if(f.id)out+="- [View findings and links](/function/findings/detail?id="+f.id+')\n';
  out+="\n**Original evidence:**\n\n"+evidenceBlock(f.evidence)+"\n\n**Detailed Report:**\n\n"+(f.report?.trim()||baselineFindingReport(f))+'\n\n';
  if(f.report&&Number(f.evidence_version)!==Number(f.report_evidence_version))out+="> The traffic evidence has been updated or has not yet been reviewed. The above report retains textual evidence, and the traffic text needs further verification.\n\n";
 }
 out+="## Check results and unfinished directions\n\n";
 if(!states.length)out+="There are no recorded negative conclusions or unfinished directions; comprehensive coverage is not claimed based on this.\n";
 for(const n of states){const r=n.payload?.resolution;out+=`- #${n.id} ${n.title||n.payload?.text||n.payload?.summary||n.kind}：${r?.outcome||n.state}${r?.reason?'；'+r.reason:''}${r?.evidence_id?"(Based on #"+r.evidence_id+'）':''}\n`;}
 return out;
}
/** Caller holds the task row lock. Snapshot and terminal transition commit together. */
export async function saveTaskReport(db:DB,taskId:number,phase:Phase,reason:string):Promise<boolean>{
 const t=(await db.query('SELECT kind,status,paused,archived,deleted_at FROM tasks WHERE id=$1',[taskId])).rows[0];
 if(!t||t.kind==='modeling'||t.deleted_at||t.archived||phase==='draft'&&['done','failed','timeout'].includes(t.status))return false;
 const rows=await findings(db,taskId);
 for(const f of rows)if(f.id&&!f.report?.trim())await db.query("UPDATE findings SET report=$2,report_evidence_version=CASE WHEN evidence_version=0 THEN 0 ELSE -1 END WHERE id=$1 AND btrim(report)=''",[f.id,baselineFindingReport(f)]);
 const markdown=await taskMarkdown(db,taskId,new Date(),{phase,reason});if(!markdown?.trim())throw new Error("The task report was not generated and the task cannot be ended.");
 await db.query(`INSERT INTO task_reports(task_id,phase,reason,markdown,finding_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id) DO UPDATE SET phase=EXCLUDED.phase,reason=EXCLUDED.reason,markdown=EXCLUDED.markdown,finding_count=EXCLUDED.finding_count,generated_at=now()`,[taskId,phase,reason,markdown,rows.length]);
 return true;
}
export async function withTaskReport<T>(pool:Pool,taskId:number,reason:string,finish:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);const result=await finish(c);const t=(await c.query('SELECT status FROM tasks WHERE id=$1',[taskId])).rows[0];if(t&&['done','failed','timeout'].includes(t.status))await saveTaskReport(c,taskId,'final',reason);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function checkpointTaskReport(pool:Pool,taskId:number):Promise<void>{
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);const saved=await saveTaskReport(c,taskId,'draft',"The deadline is approaching, sort out existing discoveries and unfinished directions");if(saved)await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('task',$1,'task_report_checkpoint','{}')",[String(taskId)]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
