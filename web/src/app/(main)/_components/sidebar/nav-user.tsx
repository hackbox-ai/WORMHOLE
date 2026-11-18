"use client";

import Link from "next/link";
import { Settings, UserRound } from "lucide-react";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { useWorkspaceNavigation } from "../workspace-navigation";

export function NavUser({user}: {readonly user: {readonly name: string; readonly email: string; readonly avatar: string}}) {
  const {inSettings, openSettings, returnToWorkbench} = useWorkspaceNavigation();
  const {isMobile, setOpenMobile} = useSidebar();
  const closeMobile = () => {if (isMobile) setOpenMobile(false);};
  return (
    <SidebarMenu className="wormhole-rail-footer">
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {if (inSettings) returnToWorkbench(); else openSettings(); closeMobile();}}
          aria-label="Settings"
          aria-pressed={inSettings}
          isActive={inSettings}
          tooltip={{children: "Settings", className: "wormhole-nav-tooltip", sideOffset: 18}}
        >
          <Settings />
          <span data-nav-label>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={{children: `Account · ${user.name}`, className: "wormhole-nav-tooltip", sideOffset: 18}}>
          <Link prefetch={false} href="/system/account" aria-label="Account" onClick={closeMobile}>
            <UserRound />
            <span data-nav-label>Account</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
