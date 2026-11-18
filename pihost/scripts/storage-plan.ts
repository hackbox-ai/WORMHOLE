import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(process.argv[2]!,'utf8')),pool=new Pool({connectionString:config.database.dsn,max:1});
try{
 const tasks=(await pool.query('SELECT id::text,status,archived,(deleted_at IS NOT NULL) AS deleted FROM tasks ORDER BY id')).rows;
 const streams=(await pool.query("SELECT business_kind,business_id,count(*)::text AS rows FROM business_events WHERE event_type='message_update' GROUP BY business_kind,business_id ORDER BY count(*) DESC")).rows;
 const taskIds=new Set(tasks.map(t=>t.id));let total=0,orphanRows=0;
 for(const stream of streams){total+=Number(stream.rows);const id=/^task-([1-9]\d*)(?:-|$)/.exec(stream.business_id)?.[1];if(id&&!taskIds.has(id))orphanRows+=Number(stream.rows);}
 console.log(JSON.stringify({tasks,totalUpdateRows:total,orphanTaskUpdateRows:orphanRows,streams:streams.length,largestStreams:streams.slice(0,12)}));
}finally{await pool.end();}
