"use client";

import * as React from "react";

import { CheckIcon, CopyIcon, DownloadIcon, FileTextIcon } from "lucide-react";
import { toast } from "sonner";

import { DocumentView } from "@/components/document-view";
import { Button } from "@/components/ui/button";
import { RecordSurface, SurfaceBody, SurfaceHeader, SurfaceTitle } from "@/components/workbench-layout";
import { api } from "@/lib/api";
import { copyText } from "@/lib/utils";

export function ReportTab({ taskId }: { taskId: string }) {
  const [report, setReport] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    const load = () => api.report(taskId)
      .then((text) => {
        if (active) { setReport(text); setError(""); }
      })
      .catch((e) => {
        if (active) setError((e as Error).message || "Report loading failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId]);

  async function copy() {
    if (!report) return;
    const ok = await copyText(report);
    if (ok) {
      setCopied(true);
      toast.success("Markdown copied");
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Copy failed, please manually select text to copy");
    }
  }

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-16 text-muted-foreground text-sm">
        <FileTextIcon className="size-8 opacity-40" />

        Loading…
      </div>
    );
  } else if (report) {
    content = (
      <DocumentView text={report} />
    );
  } else {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-16 text-muted-foreground text-sm">
        <FileTextIcon className="size-8 opacity-40" />
        {error || "No report yet"}
      </div>
    );
  }

  return (
    <RecordSurface className="task-report-workspace">
      <SurfaceHeader className="flex-row items-center justify-between">
        <SurfaceTitle className="flex items-center gap-2 text-sm">
          <FileTextIcon className="size-4" />  Mission report
        </SurfaceTitle>
        <div className="flex gap-2">
          {report && <Button size="sm" variant="outline" onClick={() => {
            const url = URL.createObjectURL(new Blob([report], {type: "text/markdown;charset=utf-8"}));
            const link = document.createElement("a"); link.href = url; link.download = `task-${taskId}-report.md`; link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}><DownloadIcon />  Export</Button>}
          {report && (
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />}  Copy
            </Button>
          )}
        </div>
      </SurfaceHeader>
      <SurfaceBody>{content}</SurfaceBody>
    </RecordSurface>
  );
}
