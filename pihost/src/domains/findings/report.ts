/** Finding Markdown and CSV rendering. */
import type {FindingRow} from './view.ts';
import {timeKey} from './view.ts';
const nz=(v:string|undefined,f:string)=>v||f;
export function reportTime(value:Date|string){const d=new Date(value),p=(n:number)=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;}
const title=(f:FindingRow)=>f.name||f.vulnclass||"Uncategorized";
// Preserve the original sevRank map, including unknown/info rank zero.
const rank:Record<string,number>={critical:0,high:1,medium:2,low:3,'':4};
const sorted=(rows:FindingRow[])=>[...rows].sort((a,b)=>{const r=(rank[a.severity]??0)-(rank[b.severity]??0);if(r)return r;const first=timeKey(a.created_iso??a.created_at),second=timeKey(b.created_iso??b.created_at);return first<second?1:first>second?-1:0;});
function traffic(f:FindingRow,attachments:boolean){const bindings=f.traffic_bindings??[],stale=!!f.report&&Number(f.evidence_version)!==Number(f.report_evidence_version);if(!bindings.length&&!stale)return '';let out=`
## Associated traffic evidence

Evidence version:${f.evidence_version};Binding quantity:${bindings.length}。\n\n`;if(stale)out+="Evidence has been changed, detailed report to be updated.\n\n";for(const [i,b] of bindings.entries()){out+=`${i+1}. **Evidence #${b.id} · ${b.role}** — \`${b.snapshot.method} ${b.snapshot.url.replaceAll('`','%60')}\`, status code ${b.snapshot.status}\n`;if(b.note)out+='   '+b.note.replaceAll('\n','\n   ')+'\n';if(attachments)out+=`   [Request message](evidence/${f.id}/${b.id}/request.http) · [Response message](evidence/${f.id}/${b.id}/response.http)\n`;}return out+'\n';}
export function findingMarkdown(f:FindingRow,now:Date){let out=`# [${nz(f.severity,'info').toUpperCase()}] ${title(f)}\n\n`;if(f.vulnclass)out+=`- **Category**:${f.vulnclass}\n`;out+=`- **Severity Level**:${nz(f.severity,'info')}
- **Status**:${nz(f.status,'pending')}\n`;if(f.task_description?.trim())out+=`- **Assigned tasks**:${f.task_description.trim()}\n`;out+=`- **Discovery Time**:${reportTime(f.created_at)}
- **Generation Time**:${reportTime(now)}\n\n`;if(f.report_status)out+="- **Report Collation Status**:"+(({completed:"Completed",basic:"To be improved",pending:"Waiting to generate",running:"Generating",needs_evidence:"Certificate pending",failed:"Build failed",cancelled:"Canceled"} as Record<string,string>)[f.report_status]??f.report_status)+'\n\n';if(f.summary?.trim())out+=`## Overview

${f.summary.trim()}\n\n`;if(f.evidence?.trim())out+=`## Evidence

\`\`\`
${f.evidence.trim()}\n\`\`\`\n\n`;if(f.report?.trim())out+=`## Detailed report

${f.report.trim()}\n`;return out+traffic(f,true);}
export function findingsMarkdown(rows:FindingRow[],now:Date){const items=sorted(rows),counts:Record<string,number>={};for(const f of items)counts[f.severity]=(counts[f.severity]??0)+1;let out=`# Vulnerability discovery summary report

- **Generation Time**:${reportTime(now)}
- **Total number of findings**:${items.length} indivual

## Summary

| Severity Level | Quantity |
| --- | --- |
`;for(const [key,label] of [['critical',"Serious"],['high',"High risk"],['medium',"Medium risk"],['low',"Low risk"]])out+=`| ${label} | ${counts[key!]??0} |\n`;out+='\n';if(!items.length)return out+"_No matching vulnerabilities. _\n";out+="## Vulnerability details\n\n";for(const [i,f] of items.entries()){out+=`### ${i+1}. [${nz(f.severity,'info').toUpperCase()}] ${title(f)}\n\n`;if(f.vulnclass)out+=`- **Category**:${f.vulnclass}\n`;out+=`- **Status**:${nz(f.status,'pending')}\n`;if(f.task_description?.trim())out+=`- **Assigned tasks**:${f.task_description.trim()}\n`;out+=`- **Discovery Time**:${reportTime(f.created_at)}\n\n`;if(f.report_status)out+="- **Report Collation Status**:"+(({completed:"Completed",basic:"To be improved",pending:"Waiting to generate",running:"Generating",needs_evidence:"Certificate pending",failed:"Build failed",cancelled:"Canceled"} as Record<string,string>)[f.report_status]??f.report_status)+'\n\n';if(f.summary?.trim())out+=f.summary.trim()+'\n\n';if(f.evidence?.trim())out+=`**Evidence:**

\`\`\`
${f.evidence.trim()}\n\`\`\`\n\n`;if(f.report?.trim())out+="**Detailed Report:**\n\n"+f.report.trim()+'\n\n';out+=traffic(f,false)+'---\n\n';}return out;}
export function findingFilename(f:FindingRow){let name=`${nz(f.severity,'info')}_${title(f)}_#${f.id}`.replace(/[^\p{Script=Han}\p{L}\p{N}._-]+/gu,'_').replace(/^[._]+|[._]+$/g,'');if(!name)name='finding_'+f.id;return Buffer.from(name).subarray(0,120).toString('utf8')+'.md';}
export function findingsCSV(rows:FindingRow[]){const csv=(a:string[])=>a.map(s=>/[",\n\r]/.test(s)||/^\s/u.test(s)?'"'+s.replaceAll('"','""')+'"':s).join(',')+'\n';return '\uFEFF'+csv(['ID',"Name","Category","Severity level","Status","Associated tasks","Discovery time","Overview","Number of traffic evidence","Traffic Evidence ID"])+sorted(rows).map(f=>csv([String(f.id),title(f),f.vulnclass,nz(f.severity,'info'),nz(f.status,'pending'),f.task_description,reportTime(f.created_at),f.summary?.trim()??'',String(f.traffic_bindings?.length??0),(f.traffic_bindings??[]).map((b:FindingRow)=>b.id).join(',')])).join('');}
