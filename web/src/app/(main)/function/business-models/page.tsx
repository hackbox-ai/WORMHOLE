"use client";
import * as React from "react";

import { useSearchParams } from "next/navigation";

import { BusinessModelingPanel } from "@/components/business-modeling-panel";

function ModelingPage() {
  const params = useSearchParams();
  return <BusinessModelingPanel initialId={params.get("id") ?? undefined} />;
}
export default function Page() {
  return (
    <React.Suspense fallback={<div className="p-6 text-muted-foreground text-sm">Loading business modeling...</div>}>
      <ModelingPage />
    </React.Suspense>
  );
}
