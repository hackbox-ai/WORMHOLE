import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Data workspaces use flat sections. Visual summaries opt into a bounded panel. */
export function RecordSurface({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="record-surface" className={cn("record-surface flex min-w-0 flex-col gap-4", className)} {...props} />;
}

export function SurfaceHeader({ className, ...props }: ComponentProps<"header">) {
  return <header data-slot="surface-header" className={cn("surface-header flex min-w-0 flex-col gap-1", className)} {...props} />;
}

export function SurfaceTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 data-slot="surface-title" className={cn("text-sm font-medium leading-snug", className)} {...props} />;
}

export function SurfaceDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="surface-description" className={cn("text-xs leading-relaxed text-muted-foreground", className)} {...props} />;
}

export function SurfaceBody({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="surface-body" className={cn("min-w-0", className)} {...props} />;
}

export function SurfaceFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer data-slot="surface-footer" className={cn("flex items-center gap-3 border-t py-3", className)} {...props} />;
}

export function MetricStrip({ items, className }: { items: { label: string; value: ReactNode; detail?: ReactNode }[]; className?: string }) {
  return <dl className={cn("workbench-metric-strip", className)}>{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd>{item.detail && <p>{item.detail}</p>}</div>)}</dl>;
}
