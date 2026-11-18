"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GuideReader } from "@/components/user-guide";
import { WorkspaceHeader } from "@/components/workspace-header";
import { guideTopic } from "@/lib/user-guide";

function HelpPage() {
  const params = useSearchParams(),
    router = useRouter();
  const location = { topic: guideTopic(params.get("topic") ?? "quickstart").id, section: params.get("section") ?? "" };
  return (
    <div className="guide-page">
      <WorkspaceHeader title="Instructions for use" compact />
      <GuideReader
        location={location}
        onNavigate={(topic, section = "") => {
          const query = new URLSearchParams({ topic });
          if (section) query.set("section", section);
          router.push("/help/?" + query.toString(), { scroll: false });
        }}
      />
    </div>
  );
}
export default function Page() {
  return (
    <React.Suspense fallback={<p role="status">Loading instructions</p>}>
      <HelpPage />
    </React.Suspense>
  );
}
