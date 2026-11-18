"use client";

import type { ReactNode } from "react";
import * as React from "react";

import { FindingAlertProvider } from "@/components/finding-alert-provider";
import { AppSidebar } from "@/app/(main)/_components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { auth } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { MainContent } from "./_components/main-content";
import { WorkspaceNavigationProvider } from "./_components/workspace-navigation";

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  // Client-side auth gate — replaces the Next proxy/middleware that static export
  // disables. No token → bounce to /login; render nothing until confirmed so no
  // protected UI (or its API calls) flashes for a logged-out visitor.
  const [authed, setAuthed] = React.useState(false);
  React.useEffect(() => {
    if (auth.getToken()) {
      setAuthed(true);
    } else {
      // When the client guard thinks that it is not logged in, it must be cleared at the same time. cookie：Otherwise proxy.ts Only
      // “cookie Existence” takes us from /login Redirected back to the main interface, bouncing back and forth with this guard
      // Form infinite redirects → White screen（cookie and localStorage Triggered when inconsistent）。
      auth.clearToken();
      window.location.href = "/login";
    }
  }, []);

  if (!authed) return null;

  return (
    <FindingAlertProvider>
    <SidebarProvider
      iconOnly
      className="h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "72px",
        } as React.CSSProperties
      }
    >
      <WorkspaceNavigationProvider>
        <AppSidebar />
        <SidebarInset
          className={cn(
            "[html[data-content-layout=centered]_&>*]:mx-auto",
            "[html[data-content-layout=centered]_&>*]:w-full",
            "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
            "peer-data-[variant=inset]:border",
            "[--dashboard-header-height:--spacing(12)]",
            "app-main-surface min-h-0 min-w-0 overflow-x-hidden overflow-y-auto",
          )}
        >
          <MainContent>{children}</MainContent>
        </SidebarInset>
      </WorkspaceNavigationProvider>
    </SidebarProvider>
    </FindingAlertProvider>
  );
}
