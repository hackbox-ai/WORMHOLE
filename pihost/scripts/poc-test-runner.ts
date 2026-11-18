import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const config=JSON.parse(await readFile(process.env.WORMHOLE_CONFIG!,'utf8'));
if(!new URL(config.database.dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('isolated database required');
const files=process.argv.slice(2);
const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1',...(files.length?files:['tests/poc-catalog.test.ts','tests/poc-orchestration.test.ts'])],{stdio:'inherit',env:{...process.env,WORMHOLE_POC_TEST_DSN:config.database.dsn}});
child.on('exit',code=>{process.exitCode=code??1;});
