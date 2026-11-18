import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {messageTitle,severityLabel,statusLabel,statusChange,type NotificationMessage} from './render.ts';
const codecDir=new URL('../../../vendor/go-template/',import.meta.url);
let verified:Promise<void>|undefined,tail:Promise<unknown>=Promise.resolve();
export const DEFAULT_WEBHOOK_TEMPLATE=`{
  "title": {{json .Title}},
  "batch": {{.Batch}},
  "count": {{.Count}},
  "items": [
{{- range $i, $it := .Items}}
{{- if $i}},{{end}}
    {
      "finding_id": {{$it.FindingID}},
      "name": {{json $it.Name}},
      "vulnclass": {{json $it.VulnClass}},
      "severity": {{json $it.Severity}},
      "summary": {{json $it.Summary}},
      "assets": {{json $it.Assets}},
      "detail_url": {{json $it.DetailURL}}
    }
{{- end}}
  ]
}`;
function sentAt(now:Date):string{const offset=-now.getTimezoneOffset(),pad=(n:number)=>String(n).padStart(2,'0'),date=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;return date+(offset===0?'Z':(offset>0?'+':'-')+pad(Math.floor(Math.abs(offset)/60))+':'+pad(Math.abs(offset)%60));}
function data(message:NotificationMessage){return {Title:messageTitle(message),Batch:message.batch,Count:message.items.length,HomeURL:message.home_url,SentAt:sentAt(new Date()),Items:message.items.map(it=>({FindingID:it.finding_id,Name:it.name,VulnClass:it.vulnclass,Severity:it.severity,SeverityLabel:severityLabel(it.severity),Summary:it.summary,Assets:it.assets,DetailURL:it.detail_url,FromStatus:it.from_status??'',ToStatus:it.to_status??'',StatusLabel:statusChange(it)?statusLabel(it.from_status??'')+' → '+statusLabel(it.to_status??''):''}))};}
/** Fixed, checksummed standard-library codec. Plain fields only, no template
 * host methods or user-selected executable. Kill and drain on timeout/abort. */
async function execute(command:unknown,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();
  const file=process.platform==='linux'&&process.arch==='x64'?'codec-linux-amd64':process.platform==='win32'&&process.arch==='x64'?'codec-windows-amd64.exe':'';
  if(!file)throw new Error("There is no validated template executor for the current platform");
  const executable=new URL(file,codecDir);verified??=Promise.all([readFile(executable),readFile(new URL('codec.sha256',codecDir),'utf8')]).then(([bytes,manifest])=>{const expected=manifest.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===file)?.[0];if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error("Template standard library verification failed");});await verified;signal?.throwIfAborted();
  return await new Promise<string>((resolve,reject)=>{
    const child=spawn(fileURLToPath(executable),[],{env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot??'C:\\Windows'}:{},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',failed:Error|undefined,settled=false;child.stdout.setEncoding('utf8');child.stderr.resume();
    const stop=(error:Error)=>{failed??=error;child.kill('SIGKILL');};
    const abort=()=>stop(signal?.reason instanceof Error?signal.reason:new Error("Template execution canceled"));signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(new Error("Template execution took more than 5 seconds")),5000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',text=>output+=text);child.stdin.on('error',()=>stop(new Error("Template input transfer failed")));
    child.once('error',()=>{if(settled)return;settled=true;cleanup();reject(new Error("Template standard library cannot be started"));});
    child.once('close',code=>{if(settled)return;settled=true;cleanup();if(failed){reject(failed);return;}if(code!==0){reject(new Error("Template standard library execution failed"));return;}try{const r=JSON.parse(output) as {error:string;body:string};r.error?reject(new Error(r.error)):resolve(r.body);}catch{reject(new Error("Template standard library response format is invalid"));}});
    child.stdin.end(JSON.stringify(command));if(signal?.aborted)abort();
  });
}
function serial(command:unknown,signal?:AbortSignal):Promise<string>{const result=tail.then(()=>execute(command,signal));tail=result.catch(()=>{});return result;}
export async function validateWebhookTemplate(template:string,signal?:AbortSignal):Promise<void>{await serial({op:'validate',template},signal);}
export function renderWebhookTemplate(template:string,message:NotificationMessage,signal?:AbortSignal):Promise<string>{return serial({op:'render',template:template.trim()?template:DEFAULT_WEBHOOK_TEMPLATE,data:data(message)},signal);}
export function renderWebhookRequest(template:string,message:NotificationMessage,signal?:AbortSignal):Promise<string>{return serial({op:'wire',template:template.trim()?template:DEFAULT_WEBHOOK_TEMPLATE,data:data(message)},signal);}
