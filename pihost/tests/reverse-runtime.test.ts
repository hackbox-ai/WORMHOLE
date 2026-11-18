import assert from 'node:assert/strict';
import{test}from'node:test';
import{execFileSync}from'node:child_process';
import {createRequire} from 'node:module';

import {connectMcp} from '../src/domains/mcp/client.ts';
import{mkdir,writeFile,rm,mkdtemp}from'node:fs/promises';
test('actual REA/Ghidra native decompilation and Wakaru JS source recovery',{skip:process.env.WORMHOLE_REVERSE_INTEGRATION!=='1',timeout:180000},async()=>{
const root='/opt/wormhole/tools',cwd=await mkdtemp('/tmp/wormhole-rea-real-');
await writeFile(cwd+'/fixture.c','#include <stdio.h>\nint calculate_total(int a,int b){return a*7+b;}\nint main(){printf("WORMHOLE_NATIVE_PROOF:%d",calculate_total(3,4));return 0;}');
execFileSync('gcc',['-g','-O0',cwd+'/fixture.c','-o',cwd+'/fixture']);
await writeFile(cwd+'/sample.js','const values=["WORMHOLE_JS_PROOF","/api/orders"];console.log(values[0],values[1]);');
const c=await connectMcp({name:'rea',transport:'stdio',command:process.execPath,args:[root+'/rea/node_modules/rea-agents/scripts/rea.mjs','--mcp'],env:{GHIDRA_INSTALL_DIR:root+'/ghidra',JAVA_HOME:root+'/jdk',REA_WAKARU_COMMAND:root+'/js/node_modules/@wakaru/cli-linux-x64/wakaru',GHIDRA_HEADLESS_MAXMEM:'1G',JAVA_TOOL_OPTIONS:'-XX:ActiveProcessorCount=2'}},undefined,cwd);
try{const call=async(name, args)=>{const r=await c.client.callTool({name,arguments:args},undefined,{timeout:120000});if(r.isError)throw Error(name+' failed: '+JSON.stringify(r).slice(0,2000));return r;};
await call('open_binary',{path:cwd+'/fixture'});
await call('binary_overview',{});
assert.match(JSON.stringify(await call('analyze_function',{procedure:'calculate_total'})),/a \* 7|7 \* a/);
await call('close_binary',{});
assert.match(JSON.stringify(await call('recover_javascript_sources',{path:cwd+'/sample.js',output_directory:cwd+'/js-output'})),/bundle.js|WORMHOLE_JS_PROOF/);
await writeFile(cwd+'/.editorconfig','root = true\n[*]\nindent_style = space\nindent_size = 2\n');
const formatted=execFileSync(root+'/bin/js-beautify',['-f',cwd+'/sample.js','--editorconfig'],{cwd,encoding:'utf8'});assert.match(formatted,/WORMHOLE_JS_PROOF/);assert.ok(formatted.includes('\n'));
const require=createRequire(root+'/rea/package.json'),pty=require('@lydell/node-pty');
await new Promise<void>((resolve,reject)=>{const child=pty.spawn('/bin/sh',['-c','printf WORMHOLE_PTY_PROOF'],{cwd,env:process.env});let data='';const timer=setTimeout(()=>{child.kill();reject(Error('REA PTY did not return output'));},5000);child.onData((text:string)=>{data+=text;});child.onExit(()=>{clearTimeout(timer);try{assert.match(data,/WORMHOLE_PTY_PROOF/);resolve();}catch(error){reject(error);}});});
}finally{await c.close();await rm(cwd,{recursive:true,force:true});}

});
