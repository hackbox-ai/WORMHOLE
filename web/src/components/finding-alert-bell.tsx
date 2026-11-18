"use client";

import Link from "next/link";

import { Bell, CheckCheck, Settings2, Volume2, VolumeX } from "lucide-react";

import { useFindingAlerts } from "@/components/finding-alert-provider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { severityLabel } from "@/lib/finding-alerts";

export function FindingAlertBell() {
  const alerts = useFindingAlerts();
  const unread = alerts.state.items.filter((item) => !item.read).length;
  const soundLabel = !alerts.state.sound ? "Turn on sound" : "Click to activate sound";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={alerts.inboxOpen} onOpenChange={alerts.setInboxOpen}>
          <SidebarMenuButton
            asChild
            tooltip={{ children: "Discovery reminder", className: "wormhole-nav-tooltip", sideOffset: 18 }}
          >
            <PopoverTrigger aria-label={`Discovery reminder${unread ? `，${unread} unread items` : ""}`} className="relative">
              <Bell className="size-4" />
              <span data-nav-label>Discovery reminder</span>
              {unread > 0 && <span className="finding-alert-badge">{unread > 99 ? "99+" : unread}</span>}
            </PopoverTrigger>
          </SidebarMenuButton>
          <PopoverContent
            side="right"
            align="end"
            sideOffset={14}
            className="w-[320px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden p-0"
            aria-label="Discovery reminder list"
          >
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <span className="font-medium text-xs">

                Discovery reminder{unread > 0 && <span className="ml-1.5 text-muted-foreground">{unread}</span>}
              </span>
              <button
                type="button"
                aria-label="Mark all as read"
                disabled={!unread}
                onClick={alerts.markAll}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <CheckCheck className="size-3.5" />
              </button>
            </div>
            <div className="max-h-[320px] overflow-y-auto" aria-live="polite">
              {alerts.state.items.length === 0 ? (
                <p className="px-3 py-7 text-center text-muted-foreground text-xs">No new findings yet</p>
              ) : (
                alerts.state.items.map((item) => (
                  <button
                    key={item.finding_id}
                    type="button"
                    onClick={() => alerts.open(item)}
                    className="flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left last:border-0 hover:bg-muted/60"
                    data-read={!!item.read}
                  >
                    <span
                      className="finding-alert-dot mt-1.5 shrink-0"
                      data-severity={item.severity}
                      style={{ opacity: item.read ? 0.35 : 1 }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-xs ${item.read ? "text-muted-foreground" : "font-medium"}`}
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {severityLabel[item.severity] ?? item.severity}  · Task #{item.task_id} · {item.task_name}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
              <button
                type="button"
                onClick={() => void alerts.enableSound(!alerts.state.sound || !alerts.soundReady)}
                className="flex items-center gap-1.5 hover:text-foreground"
                aria-label={alerts.state.sound && alerts.soundReady ? "Turn off the reminder sound" : "Turn on and listen"}
              >
                {alerts.state.sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                {alerts.state.sound && alerts.soundReady ? "Sound is on" : soundLabel}
              </button>
              <Link
                href="/system/notify/"
                onClick={() => alerts.setInboxOpen(false)}
                aria-label="Reminder settings"
                className="rounded p-1 hover:bg-muted"
              >
                <Settings2 className="size-3.5" />
              </Link>
            </div>
            {!alerts.ready && <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">Connecting reminder...</p>}
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
