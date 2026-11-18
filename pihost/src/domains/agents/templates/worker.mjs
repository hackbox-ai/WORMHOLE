import {parentPort} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
createRequire(import.meta.url)('./wasm_exec.cjs');
const go=new globalThis.Go();
const {instance}=await WebAssembly.instantiate(await readFile(new URL('./template.wasm',import.meta.url)),go.importObject);
void go.run(instance);
if(typeof globalThis.__gatyushaTemplateCompat!=='function')throw new Error('template compatibility initialization failed');
parentPort.on('message',({id,request})=>{
 try{parentPort.postMessage({id,result:JSON.parse(globalThis.__gatyushaTemplateCompat(JSON.stringify(request)))});}
 catch(error){parentPort.postMessage({id,error:String(error)});}
});
parentPort.postMessage({ready:true});
