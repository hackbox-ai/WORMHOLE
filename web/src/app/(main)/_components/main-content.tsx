"use client";

import { type ReactNode, useEffect } from "react";

import { usePathname } from "next/navigation";

import { SidebarTrigger } from "@/components/ui/sidebar";

// Detail workspaces provide their own header and padding; avoid a second top gutter.
function fullBleedWorkspace(pathname: string) {
  const p = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  // Static export is enabled trailingSlash，The list page itself pathname Yes "/function/tasks/"，
  // Remove the trailing slash before judging the prefix, otherwise the list page will be mistakenly judged as a details page and the global header will be lost.。
  const normalized = p.replace(/\/+$/, "");
  if (normalized.startsWith("/function/tasks/")) return "task-workspace";
  if (normalized === "/function/findings/detail") return "finding-workspace";
  return null;
}

export function MainContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Rebuild reveal observers after client-side navigation changes the page canvas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes must restart the observer.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".page-canvas [data-slot='card']")).slice(0, 80);
    cards.forEach((card) => {
      card.classList.add("wormhole-reveal");
    });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-revealed", "true");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06, rootMargin: "0px 0px -24px 0px" },
    );
    cards.forEach((card) => {
      observer.observe(card);
    });
    return () => observer.disconnect();
  }, [pathname]);

  const workspace = fullBleedWorkspace(pathname);
  if (workspace) {
    const detailWorkbench = workspace === "finding-workspace" ? " workbench-page" : "";
    return <div className={`${workspace}${detailWorkbench} flex min-h-0 min-w-0 flex-1 flex-col`}>{children}</div>;
  }
  const isWorkbenchPage = pathname.startsWith("/function/");

  return (
    <>
      <div className="workspace-sidebar-control flex h-10 md:hidden shrink-0 items-center px-4 md:px-6">
        <SidebarTrigger className="-ml-1 rounded-lg" aria-label="Expand or collapse directory" />
      </div>
      <div className={`page-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0${isWorkbenchPage ? " workbench-page" : ""}`}>
        {children}
      </div>
    </>
  );
}
