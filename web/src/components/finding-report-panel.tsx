"use client";
import * as React from "react";
import Link from "next/link";
import {FileTextIcon,RefreshCwIcon,HistoryIcon,SquareIcon} from "lucide-react";
import {toast} from "sonner";
import {api} from "@/lib/api";
import type {Finding,FindingReportHistory} from "@/lib/types";
import {Badge} from "./ui/badge";
import {Button} from "./ui/button";
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from "./ui/dialog";
import {RecordSurface,SurfaceBody,SurfaceHeader,SurfaceTitle} from "./workbench-layout";
import {DocumentView} from "./document-view";
import {CopyButton} from "./copy-button";
export const reportStatusNames:Record<string,string>={basic:"To be improved",pending:"Waiting to generate",running:"Generating",completed:"Completed",needs_evidence:"Certificate pending",failed:"Build failed",cancelled:"Canceled"};
export function ReportStatusBadge({status}:{status?:string}){
 return <Badge variant="outline" className={"shrink-0 text-[10px] "+(status==="completed"?"text-emerald-500":status==="failed"||status==="needs_evidence"?"text-amber-500":"text-muted-foreground")}>{status==="running"&&<RefreshCwIcon className="mr-1 size-3 animate-spin"/>}Report{reportStatusNames[status??"basic"]??"To be improved"}</Badge>;
}
export function FindingReportPanel({finding,onUpdated}:{finding:Finding;onUpdated:()=>void}){
 const [history,setHistory]=React.useState<FindingReportHistory|null>(null),[error,setError]=React.useState(""),[busy,setBusy]=React.useState(false),[versionsOpen,setVersionsOpen]=React.useState(false),[oldBody,setOldBody]=React.useState("");
 const onDone=React.useRef(onUpdated);onDone.current=onUpdated;const previous=React.useRef("");
 const load=React.useCallback(async()=>{try{const data=await api.findingReportHistory(finding.id);setHistory(data);setError("");const marker=data.jobs.map(j=>j.id+":"+j.state+":"+j.attempts).join("|");if(previous.current&&previous.current!==marker)onDone.current();previous.current=marker;}catch(e){setError((e as Error).message);}},[finding.id]);
 React.useEffect(()=>{previous.current="";void load();},[load]);
 const active=history?.jobs.some(j=>["pending","running"].includes(j.state));
 React.useEffect(()=>{if(!active)return;const timer=setInterval(()=>void load(),2500);return()=>clearInterval(timer);},[active,load]);
 const latest=history?.jobs[0],status=finding.report_status??"basic",draft=latest?.state==="needs_evidence"?latest.draft:"";
 const baseline=!!finding.report?.includes("Compiled based on registered evidence. Scope of influence");
 const body=draft||(!baseline?finding.report:"");
 const act=async(action:"retry"|"cancel")=>{setBusy(true);try{if(action==="retry")await api.retryFindingReport(finding.id);else await api.cancelFindingReport(finding.id);await load();onDone.current();toast.success(action==="retry"?"Report arrangement has been arranged":"Report sorting canceled");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}};
 return <><RecordSurface>
 <SurfaceHeader className="flex-row flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><FileTextIcon className="size-4 text-muted-foreground"/><SurfaceTitle className="text-sm">{draft?"Draft report":body?"Vulnerability Report":"Report compilation"}</SurfaceTitle><ReportStatusBadge status={status}/></div><div className="flex flex-wrap gap-1">
 {body&&<CopyButton text={body} successMessage="Report copied"/>}
 <Button variant="ghost" size="sm" onClick={()=>setVersionsOpen(true)}><HistoryIcon/>Version record</Button>
 {!finding.inherited&&(active?<Button variant="ghost" size="sm" disabled={busy} onClick={()=>act("cancel")}><SquareIcon/>Cancel sorting</Button>:<Button variant="outline" size="sm" disabled={busy} onClick={()=>act("retry")}><RefreshCwIcon/>{status==="completed"?"Rearrange":status==="failed"?"Try again":"Generate report"}</Button>)}
 </div></SurfaceHeader>
 <SurfaceBody className="space-y-4">
 {error&&<p role="alert" className="text-sm text-destructive">{error}<Button size="sm" variant="link" onClick={load}>Refresh</Button></p>}
 {status==="running"&&<p className="text-xs text-muted-foreground">{latest?.progress||"The existing evidence is being sorted and the test task continues to run."}</p>}
 {latest?.error&&status!=="completed"&&<p className="text-sm text-amber-500">{latest.error}</p>}
 {draft&&<div className="rounded-md border border-amber-500/30 p-3 text-sm"><div className="font-medium">There is a draft, and the following evidence still needs to be supplemented</div><ul className="mt-2 list-disc space-y-1 pl-4">{latest?.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></div>}
 {finding.report_stale&&body&&<p className="text-sm text-amber-500">The evidence has been updated and the current text is the previous version of the report.</p>}
 {body?<DocumentView text={body} label="Vulnerability report directory"/>:<p className="text-sm text-muted-foreground">Discovery and original evidence preserved, full report{active?"Queuing or sorting":"Still to be improved"}。</p>}
 {!!finding.report_quality?.source_refs?.length&&<p className="break-all text-xs text-muted-foreground">Source of evidence:{finding.report_quality.source_refs.slice(0,8).join(" · ")}{finding.report_quality.source_refs.length>8?" etc.":""}</p>}
 {latest?.conversation_id&&<Link href={"/chat?c="+latest.conversation_id} className="text-xs text-muted-foreground hover:underline">View report compilation process · Chapter {latest.attempts}  times</Link>}
 </SurfaceBody></RecordSurface>
 <Dialog open={versionsOpen} onOpenChange={v=>{setVersionsOpen(v);if(!v)setOldBody("");}}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl"><DialogHeader><DialogTitle>Report version and generation record</DialogTitle><DialogDescription>The text before generation is retained, and the old version can be viewed; the test will not be re-executed during report compilation.</DialogDescription></DialogHeader>
 <div className="space-y-2">{history?.jobs.map(j=><div key={j.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-xs"><span>Evidence version {j.evidence_version} · {reportStatusNames[j.state]??j.state} · {j.attempts}  attempts</span><span className="text-muted-foreground">{new Date(j.created_at).toLocaleString("en-US")}</span>{j.error&&<p className="w-full text-amber-500">{j.error}</p>}</div>)}
 {history?.versions.map(v=><div key={v.id} className="flex items-center justify-between border-b py-2 text-xs"><span>History text #{v.id} · {new Date(v.created_at).toLocaleString("en-US")}</span><Button size="sm" variant="ghost" onClick={async()=>{try{setOldBody((await api.findingReportVersion(finding.id,v.id)).body);}catch(e){toast.error((e as Error).message);}}}>View</Button></div>)}
 {!history?.jobs.length&&!history?.versions.length&&<p className="py-6 text-sm text-muted-foreground">There is no generated record yet, and the existing text remains unchanged.</p>}</div>
 {oldBody&&<DocumentView text={oldBody} label="Historical report directory"/>}
 </DialogContent></Dialog></>;
}

export function TaskReportBackfillButton({findings}:{findings:Finding[]}){
 const [open,setOpen]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState("");
 const ids=[...new Set(findings.filter(f=>!f.inherited&&f.report_status!=="completed").map(f=>Number(f.finding_id||f.id)).filter(n=>Number.isSafeInteger(n)&&n>0))];
 const run=async()=>{setBusy(true);setError("");try{for(let i=0;i<ids.length;i+=20)await api.backfillFindingReports(ids.slice(i,i+20),false);setOpen(false);toast.success("Report sorting has been arranged and existing tests continue to run");}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <><Button size="sm" variant="ghost" disabled={!ids.length} onClick={()=>setOpen(true)}>Complete report</Button><Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v);}}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Complete this task report</DialogTitle><DialogDescription>will be {ids.length}  The discovery arrangement report needs to be sorted out. Only existing evidence is used, completed reports are retained, and targets are not retested.</DialogDescription></DialogHeader>{error&&<p className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancel</Button><Button disabled={busy||!ids.length} onClick={run}>{busy?"Arranging...":"Confirm finishing"}</Button></div></DialogContent></Dialog></>;
}
