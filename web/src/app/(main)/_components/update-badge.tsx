"use client";

import * as React from "react";

import Link from "next/link";

import { ArrowUpCircleIcon } from "lucide-react";

import { api } from "@/lib/api";

/**
 * Top column"There is a new version"Tip: Check once when the whole page is loaded. If there is an update, it will be highlighted next to the version number.，
 * Click the ”Version and Updates” card to go directly to the system configuration page。
 *
 * Backend pair The query results for GitHub are 30 Minute cache, so it is safe to check it every time it is mounted here
 * ——Uncertified GitHub API Only 60 times/hours/IP，If there is no such layer of cache, open a few more tabs
 * The quota will be used up, and then I really want to update but I can’t find it.。
 *
 * If the query fails, it will be silent: the top bar is not the place to report errors. The user will see the reason by going to the settings page and clicking ”Check for Updates”。
 */
export function UpdateBadge() {
  const [latest, setLatest] = React.useState("");

  React.useEffect(() => {
    let alive = true;
    api
      .checkUpdate()
      .then((r) => {
        // has_update Already included"Version numbers are comparable"Judgment, the development build will not display this prompt。
        if (alive && r.has_update && r.latest) setLatest(r.latest.replace(/^v(?=\d)/, ""));
      })
      .catch(() => {
        // Silent: No network / GitHub The error should not pop up in the top bar even if the current is limited。
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!latest) return null;

  return (
    <Link
      href="/system/settings"
      title={`New version found ${latest}, click to update`}
      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90"
    >
      {/* Breathing point: There are many elements in the top bar, and pure text is easily ignored. The animation makes it visible at a glance.。 */}
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary-foreground opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
      </span>
      <ArrowUpCircleIcon className="size-3.5" />
      <span className="hidden sm:inline">New version {latest}</span>
      <span className="sm:hidden">New version</span>
    </Link>
  );
}
