export function evidenceText(value:unknown):string{
 if(typeof value==='string')return value;
 if(value&&typeof value==='object'&&'poc' in value&&typeof value.poc==='string')return value.poc;
 return value==null?'':JSON.stringify(value,null,2);
}
export function evidenceBlock(value:unknown):string{
 const text=evidenceText(value).trim();if(!text)return "No recurrence evidence has been provided and further verification is required.";
 const fence='`'.repeat(Math.max(3,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1)));
 return fence+'\n'+text+'\n'+fence;
}
/** A durable evidence-only baseline. Reporter may replace it with analysis. */
export function baselineFindingReport(f:{name?:string;vulnclass?:string;severity?:string;summary?:string;evidence?:unknown;node_id?:string|number}):string{
 return `# ${f.name||f.vulnclass||"Registered discovery"}

> Organized based on registered evidence. The scope of impact, root causes, and unsupplemented parts of the repair plan still need to be verified.

## Vulnerability Overview

${f.summary?.trim()||"No detailed description has been provided."}

- Severity level (registration value):${f.severity||'info'}
- Category:${f.vulnclass||"Uncategorized"}${f.node_id?"\n- Path node found: #"+f.node_id:''}

## Reproduction steps and evidence

${evidenceBlock(f.evidence)}

## Impact and root cause

Based on the above actual records; no inferences will be made about the unverified scope of influence and root causes.

## Repair and retest

Repair measures will be supplemented based on the actual root cause. After repair, retest according to the recorded steps.
`;
}
