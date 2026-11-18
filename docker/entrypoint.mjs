import {mkdir,access,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const root=process.env.WORMHOLE_DATA_ROOT??'/var/lib/wormhole';
await mkdir(root+'/agent',{recursive:true});
await mkdir(root+'/data',{recursive:true});
try{await access(root+'/agent/models.json');}catch{await writeFile(root+'/agent/models.json',JSON.stringify({providers:{}})+'\n',{mode:0o600,flag:'wx'});}
if(!process.env.WORMHOLE_CONFIG){
 const password=process.env.WORMHOLE_DB_PASSWORD;if(!password)throw new Error('WORMHOLE_DB_PASSWORD is required');
 const user=encodeURIComponent(process.env.WORMHOLE_DB_USER??'wormhole');
 const db=encodeURIComponent(process.env.WORMHOLE_DB_NAME??'wormhole');
 const host=process.env.WORMHOLE_DB_HOST??'postgres',port=Number(process.env.WORMHOLE_DB_PORT??5432);
 const config={listen:{host:'0.0.0.0',port:18887},database:{dsn:`postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`},dataDir:root+'/data',pi:{agentDir:root+'/agent',modelsPath:root+'/agent/models.json',provider:'',modelId:''}};
 const file=root+'/config.json';await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});process.env.WORMHOLE_CONFIG=file;
}
const command=process.argv.slice(2);if(!command.length)throw new Error('Missing application command');
const child=spawn(command[0],command.slice(1),{stdio:'inherit',env:process.env});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
