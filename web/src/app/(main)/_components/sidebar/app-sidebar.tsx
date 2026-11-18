"use client";

import { FindingAlertBell } from "@/components/finding-alert-bell";
import Link from "next/link";
import { ArrowLeft, CircleHelp } from "lucide-react";


import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { useCurrentUser } from "@/hooks/use-current-user";
import { workbenchItems, settingsItems } from "@/navigation/sidebar/sidebar-items";

import { useWorkspaceNavigation } from "../workspace-navigation";

import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const currentUser = useCurrentUser();
  const { inSettings, returnToWorkbench } = useWorkspaceNavigation();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Sidebar
      {...props}
      variant="sidebar"
      collapsible="icon"
      className="wormhole-icon-rail"
      data-navigation-mode={inSettings ? "settings" : "workbench"}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={{ children: "WORMHOLE", className: "wormhole-nav-tooltip", sideOffset: 18 }}>
              <Link prefetch={false} href="/function/tasks" aria-label="WORMHOLE">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/mark.svg?v=2" className="wormhole-brand-mark size-8 shrink-0" alt="WORMHOLE" width={32} height={32} />
                <span data-nav-label className="flex min-w-0 flex-col leading-tight">
                  <span className="font-semibold text-[15px] tracking-tight">{APP_CONFIG.name}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {inSettings && (
          <SidebarMenu className="mt-2">
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  returnToWorkbench();
                  if (isMobile) setOpenMobile(false);
                }}
                tooltip={{ children: "Return to workbench", className: "wormhole-nav-tooltip", sideOffset: 18 }}
                aria-label="Return to workbench"
                className="text-muted-foreground"
              >
                <ArrowLeft className="size-4" />
                <span data-nav-label>Return to workbench</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>
      <SidebarContent>
        <div
          key={inSettings ? "settings" : "workbench"}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-200"
        >
          <NavMain items={inSettings ? settingsItems : workbenchItems} />
        </div>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu><SidebarMenuItem>
          <SidebarMenuButton asChild tooltip={{ children: "Instructions for use", className: "wormhole-nav-tooltip", sideOffset: 18 }}>
            <Link prefetch={false} href="/help/" aria-label="Instructions for use"><CircleHelp className="size-4" /><span data-nav-label>Instructions for use</span></Link>
          </SidebarMenuButton>
        </SidebarMenuItem></SidebarMenu>
        <FindingAlertBell />
        <NavUser user={currentUser} />
      </SidebarFooter>
    </Sidebar>
  );
}
