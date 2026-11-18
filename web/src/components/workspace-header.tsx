import { HelpButton } from "@/components/user-guide";
import type { ReactNode } from "react";

import { Bot, CircleHelp, Layers } from "lucide-react";
import { workbenchItems, settingsItems } from "@/navigation/sidebar/sidebar-items";
import { cn } from "@/lib/utils";

// Page titles and navigation share their module icons.
const icons = {
  ...Object.fromEntries(
    [...workbenchItems, ...settingsItems]
      .flatMap((group) => group.items.flatMap((item) => item.subItems ?? [item]))
      .filter((item) => item.icon)
      .map((item) => [item.title, item.icon!]),
  ),
  "User Guide": CircleHelp,
  "Asset Sync": Layers,
  "Agent details": Bot,
};

export function WorkspaceHeader({
  title,
  description,
  actions,
  className,
  compact = false,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const Icon = icons[title as keyof typeof icons] ?? Layers;
  return (
    <div className={cn("workspace-heading", compact && "workspace-heading-compact", className)}>
      <div className="workspace-heading-main">
        <span className="workspace-heading-icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="min-w-0">
          <div className="workspace-heading-title"><h1>{title}</h1><HelpButton compact /></div>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="workspace-heading-actions">{actions}</div>}
    </div>
  );
}
