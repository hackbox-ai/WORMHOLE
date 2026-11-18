"use client";

import * as React from "react";

import {
  DownloadIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "@/components/settings-layout";
import { Progress } from "@/components/ui/progress";
import { api, sseUrl } from "@/lib/api";
import type { UpdateCheck, UpdateProgress } from "@/lib/types";

/** The maximum time to wait for a new version to come online. An upgrade requires three process starts (temporary storage → Dress up → New version），
 *  Each time is on the second level, three minutes is enough to cover slow disks and Docker Container rebuild。 */
const RESTART_TIMEOUT_MS = 180_000;

function humanSize(n?: number): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UpdateCard() {
  const [info, setInfo] = React.useState<UpdateCheck | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  // and progress Separate: The process is gone after the temporary storage is completed，SSE will be interrupted. At this time, switch to polling. /api/health。
  const [restarting, setRestarting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // quiet At the same time, decide whether to bypass the back-end cache: automatically check the cache when entering the page (the top bar just checked），
  // The user manually clicks ”Check for Updates” to force a return to the source. Otherwise, the newly released version will not be visible until the cache expires.。
  const check = React.useCallback((quiet = false) => {
    setChecking(true);
    api
      .checkUpdate(!quiet)
      .then((r) => {
        setInfo(r);
        if (!quiet) {
          if (r.error) toast.error("Failed to check for updates:" + r.error);
          else if (r.has_update) toast.success(`New version found ${r.latest}`);
          else if (r.comparable) toast.success("This is the latest version");
        }
      })
      .catch((e) => {
        if (!quiet) toast.error("Failed to check for updates:" + (e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  React.useEffect(() => {
    check(true);
  }, [check]);

  // Polling /api/health Until the version number changes。
  //
  // The criterion must be"Version changed"instead of"Can be connected"：During the replacement process, the old version will briefly restart.
  // ，Looking only at connectivity can misjudge success.。
  const waitForNewVersion = React.useCallback(async (fromVersion: string) => {
    setRestarting(true);
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { version?: string };
          if (j.version && j.version !== fromVersion) {
            toast.success(`Updated to ${j.version}, reloading page`);
            await sleep(800);
            window.location.reload();
            return;
          }
        }
      } catch {
        // Failure to connect within the restart window is expected, continue polling。
      }
    }
    setRestarting(false);
    toast.error("Timeout waiting for the WORMHOLE service to restart, please check the service log and host process manager status.");
  }, []);

  // Subscription update progress。SSE Not leaving Next of /api Rewrite (that layer will be buffered and events cannot be pushed out)）。
  const openStream = React.useCallback(
    (fromVersion: string) => {
      const es = new EventSource(sseUrl("/api/update/stream"));
      es.onmessage = (ev) => {
        let p: UpdateProgress;
        try {
          p = JSON.parse(ev.data) as UpdateProgress;
        } catch {
          return;
        }
        setProgress(p);
        if (p.phase === "failed") {
          es.close();
          setBusy(false);
          toast.error("Update failed:" + (p.error || p.message));
          return;
        }
        if (p.phase === "staged") {
          es.close();
          void waitForNewVersion(fromVersion);
        }
      };
      es.onerror = () => {
        // When process exits SSE must be disconnected. If you are already waiting for a reboot, this is normal.，
        // handed over /api/health Just continue polling to determine。
        es.close();
      };
      return es;
    },
    [waitForNewVersion],
  );

  const doUpdate = () => {
    if (!info) return;
    const from = info.current;
    const ok = window.confirm(
      `Confirm to update to ${info.latest}？\n\n` +
        "The update will restart the program and running tasks will be interrupted.\n" +
        (info.mode === "docker"
          ? "\nNote: In-container updates only replace the program itself, and will not update the playwright / nmap and other tool chains in the image;" +
            "If the new version depends on new tools, please use docker compose pull instead."
          : ""),
    );
    if (!ok) return;

    setBusy(true);
    setProgress({ phase: "downloading", percent: 0, message: "Preparing..." });
    const es = openStream(from);
    api.applyUpdate().catch((e) => {
      es.close();
      setBusy(false);
      setProgress(null);
      toast.error("Failed to start update:" + (e as Error).message);
    });
  };

  const doRollback = () => {
    if (!info) return;
    if (
      !window.confirm(
        "Roll back to previous version?\n\nThe program will restart and running tasks will be interrupted.\nNote: The database structure will not be rolled back, and the old version may not recognize the data written by the new version.",
      )
    )
      return;
    const from = info.current;
    setBusy(true);
    api
      .rollbackUpdate()
      .then(() => {
        toast.success("Switched to the previous version, restarting...");
        void waitForNewVersion(from);
      })
      .catch((e) => {
        setBusy(false);
        toast.error("Rollback failed:" + (e as Error).message);
      });
  };

  const phase = progress?.phase;
  const showProgress = busy || restarting;
  // Only the download phase can get the true percentage (press Content-Length Count). Verification/Unzip/Waiting for restart
  // In a stage with unknown duration, the progress bar fills up and a pulse animation is added to indicate it."Busy but not sure how long it will be"。
  const downloading = !restarting && phase === "downloading";
  const pct = downloading ? Math.max(progress?.percent ?? 0, 0) : 100;

  return (
    <SettingsSection title="Versions and Updates">
      <SettingsRow title="Current version" description="Updates and rollbacks restart services and interrupt running tasks.">
        <span className="font-mono text-sm">{info?.current ?? "…"}</span>
        {info?.latest && <Badge variant="outline">Latest {info.latest}</Badge>}
        <Button variant="outline" size="sm" onClick={() => check(false)} disabled={checking || busy || restarting}>
          <RefreshCwIcon className={checking ? "size-4 animate-spin" : "size-4"} />Check for updates
        </Button>
      </SettingsRow>
      <div className="settings-update-details">
        {info?.boot_notice && <p role="status" className="text-muted-foreground text-sm">{info.boot_notice}</p>}
        {info?.error && <p role="alert" className="text-destructive text-sm">Check failed:{info.error}</p>}
        {info && !info.comparable && info.reason && <p className="text-muted-foreground text-sm">{info.reason}</p>}
        {info?.has_update && info.asset_available === false && <p role="alert" className="text-destructive text-sm">Not provided {info.os}/{info.arch}  The release package cannot be updated automatically.</p>}
        {info && !info.has_update && info.comparable && !info.error && <p className="text-muted-foreground text-sm">is currently the latest version.</p>}
        {info?.has_update && info.asset_available !== false && <p className="text-muted-foreground text-sm">Release package {info.asset}{info.size ? ` · ${humanSize(info.size)}` : ""}</p>}
        {info?.mode === "docker" && info.has_update && null}
        {showProgress && <div className="space-y-2"><Progress value={pct} className={downloading ? undefined : "animate-pulse"} /><p className="text-muted-foreground text-sm">{restarting ? "Restarting..." : progress?.message}</p></div>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={doUpdate} disabled={busy || restarting || !info?.has_update || info?.asset_available === false}>
            <DownloadIcon className="size-4" />{info?.has_update ? `Updated to ${info.latest}` : "Update now"}
          </Button>
          {info?.has_backup && <Button variant="outline" size="sm" onClick={doRollback} disabled={busy || restarting}><RotateCcwIcon className="size-4" />Rollback</Button>}
          {info?.html_url && <a href={info.html_url} target="_blank" rel="noreferrer" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:text-foreground">Update log<ExternalLinkIcon className="size-3" /></a>}
        </div>
      </div>
    </SettingsSection>
  );
}
