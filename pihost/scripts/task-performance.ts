/** Export a consistent baseline without request/response bodies or tool params. */
import {readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {TaskPerformance} from '../src/domains/observability/task-performance.ts';
const [configFile,taskId,output]=process.argv.slice(2);
if(!configFile||!taskId||!output)throw new Error('expected CONFIG TASK_ID NEW_REPORT_JSON');
const config=JSON.parse(await readFile(configFile,'utf8')),pool=new Pool({connectionString:config.database.dsn,max:1,application_name:'wormhole-task-performance'});
try{
  const report=await new TaskPerformance(pool).report(taskId);if(!report)throw new Error('task not found');
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,taskId,calls:report.model.calls,measuredCalls:report.model.measured_calls}));
}finally{await pool.end();}
