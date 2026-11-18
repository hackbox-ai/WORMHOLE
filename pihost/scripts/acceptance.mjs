/** Run suites in separate processes and disposable databases. Never use the application DB. */
import {spawn} from 'node:child_process';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';

const dsn = process.env.WORMHOLE_ACCEPT_ADMIN_DSN;
if (!dsn) throw new Error('Set WORMHOLE_ACCEPT_ADMIN_DSN to an isolated PostgreSQL instance with CREATE DATABASE permission.');
if (process.platform !== 'linux') throw new Error('Use the Docker test image (Linux x86_64).');
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.WORMHOLE_ACCEPT_OUTPUT ?? '/acceptance');
await mkdir(output, {recursive: true});
const admin = new Pool({connectionString: dsn});
const selection = new Set(process.argv.slice(2).map(name => name.replace(/\.test\.ts$/, '')));
let prior=[];
if(process.env.WORMHOLE_ACCEPT_RESUME==='1')try{prior=JSON.parse(await readFile(path.join(output,'results.json'),'utf8')).results;}catch{}
const passed=new Set(prior.filter(result=>result.exitCode===0&&!result.timedOut&&!result.failed).map(result=>result.file));
const files = (await readdir(path.join(root, 'tests'))).filter(file => file.endsWith('.test.ts') && !passed.has(file) && (!selection.size || selection.has(file.replace(/\.test\.ts$/, '')))).sort();
if (!files.length) throw new Error('No matching test suites.');
const runId = Date.now().toString(36);
const results = prior;
try {
  for (const [index, file] of files.entries()) {
    const prefix=file==='modeling.test.ts'?'modeling_test':file==='fingerprint-orchestration.test.ts'?'wormhole_fp_orchestration_test':'wormhole_poc_test';
    const database = `${prefix}_${runId}_${index}_test`;
    const url = new URL(dsn); url.pathname = '/' + database;
    const testDsn = url.toString();
    const dir = `/tmp/${database}`;
    await mkdir(dir + '/agent', {recursive: true});
    await mkdir('/var/lib/wormhole', {recursive: true});
    await writeFile(dir + '/agent/models.json', '{"providers":{}}');
    const config = {listen: {host: '127.0.0.1', port: 18887}, database: {dsn: testDsn}, dataDir: dir, pi: {agentDir: dir + '/agent', modelsPath: dir + '/agent/models.json', provider: 'fixture', modelId: 'fixture'}};
    const configFile = '/var/lib/wormhole/config.test.json';
    await writeFile(configFile, JSON.stringify(config), {mode: 0o600});
    await admin.query(`CREATE DATABASE ${database}`);
    const started = Date.now();
    let log = '', timedOut = false;
    const env = {...process.env, WORMHOLE_CONFIG: configFile};
    for (const kind of ['POC', 'FINGERPRINT', 'MODELING', 'FRESH']) env[`WORMHOLE_${kind}_TEST_DSN`] = testDsn;
    // The core-install regression must exercise an absent optional engine.
    if (file === 'fresh-install.test.ts') env.WORMHOLE_FINGERPRINT_ENGINE = '/nonexistent/fingerprint-engine';
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/' + file], {cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
        child.stdout.on('data', data => {log += data;});
        child.stderr.on('data', data => {log += data;});
        const timer = setTimeout(() => {timedOut = true; try {process.kill(-child.pid, 'SIGKILL');} catch {}}, Number(process.env.WORMHOLE_ACCEPT_TIMEOUT_MS ?? 300000));
        child.on('error', error => {clearTimeout(timer); reject(error);});
        child.on('close', status => {clearTimeout(timer); resolve(status);});
      });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    const count = label => Number(log.match(new RegExp('^# ' + label + ' (\\d+)$', 'm'))?.[1] ?? 0);
    const result = {file, exitCode: code, timedOut, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), durationMs: Date.now() - started};
    const previous=results.findIndex(row=>row.file===file);if(previous>=0)results.splice(previous,1);
    results.push(result);
    await writeFile(path.join(output, file + '.log'), log);
    await writeFile(path.join(output, 'results.json'), JSON.stringify({generatedAt: new Date().toISOString(), node: process.version, results}, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {await admin.end();}
if (results.some(result => result.exitCode !== 0 || result.timedOut || result.failed)) process.exitCode = 1;
