import {readFile,writeFile} from 'node:fs/promises';
import {performanceInterval} from '../src/domains/observability/performance-interval.ts';
const [beforeFile,afterFile,output]=process.argv.slice(2);if(!beforeFile||!afterFile||!output)throw new Error('expected BEFORE_JSON AFTER_JSON NEW_INTERVAL_JSON');
const before=JSON.parse(await readFile(beforeFile,'utf8')),after=JSON.parse(await readFile(afterFile,'utf8')),report=performanceInterval(before,after);
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
