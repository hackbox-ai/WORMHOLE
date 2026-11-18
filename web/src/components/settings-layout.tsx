import { HelpButton } from "@/components/user-guide";
import type { ComponentProps, ReactNode } from "react";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceHeader } from "@/components/workspace-header";

export function SettingsPage({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("settings-workspace", className)}>
      <WorkspaceHeader compact title={title} actions={actions} />
      {children}
    </div>
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2 className="settings-section-title">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

export function SettingsRow({ title, htmlFor, description, help, badge, children }: {
  title: string;
  htmlFor?: string;
  description?: ReactNode;
  help?: { topic: string; section?: string };
  badge?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
          {badge && <span className="settings-tag">{badge}</span>}
          {help && <HelpButton compact topic={help.topic} section={help.section} label={title + "Description"} />}
        </div>
        {description && <p className="settings-row-description">{description}</p>}

      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsPanel({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("settings-panel", className)} {...props} />;
}
export function SettingsPanelHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("settings-panel-header", className)} {...props} />;
}
export function SettingsPanelBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("settings-panel-body", className)} {...props} />;
}
export function SettingsPanelTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("settings-section-title", className)} {...props} />;
}
export function SettingsPanelDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("settings-row-description", className)} {...props} />;
}

export function SettingsResourceRow({ title, description, icon, kind, meta, actions, onOpen }: {
  title: string; description?: ReactNode; icon?: ReactNode; kind?: ReactNode; meta?: ReactNode; actions?: ReactNode; onOpen: () => void;
}) {
  return (
    <div className="settings-resource-row">
      <button type="button" className="settings-resource-open" onClick={onOpen} aria-label={`Configuration ${title}`}>
        <span className="settings-resource-icon" aria-hidden="true">{icon}</span>
        <span className="settings-resource-name"><span className="settings-resource-title">{title}</span>{description && <span className="settings-resource-description">{description}</span>}</span>
        <span className="settings-resource-kind">{kind}</span>
        <span className="settings-resource-counts"><span className="settings-meta-value">{meta}</span></span>
        <ChevronRight className="settings-resource-chevron" aria-hidden="true" />
      </button>
      {actions && <div className="settings-inline-actions">{actions}</div>}
    </div>
  );
}
