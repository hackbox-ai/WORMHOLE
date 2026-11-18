"use client";

import * as React from "react";

import { Bot, ChevronRight, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { HelpButton } from "@/components/user-guide";
import { AgentEditor } from "@/components/agent-editor";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SettingsPage } from "@/components/settings-layout";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";

function DeleteAgentButton({ agent, onDeleted, labeled = false }: { agent: Agent; onDeleted: () => void; labeled?: boolean }) {
  const [open, setOpen] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
  async function remove() {
    if (busy) return;
    setBusy(true); setError("");
    try { await api.deleteAgent(agent.key); toast.success("Agent \"deleted\"" + agent.name + "」"); setOpen(false); onDeleted(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (agent.builtin) return null;
  return <AlertDialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);if(value)setError("");}}}>
    <AlertDialogTrigger asChild><Button type="button" variant="ghost" size={labeled ? "sm" : "icon-sm"}
      className="settings-resource-delete text-muted-foreground hover:text-destructive" aria-label={"Delete " + agent.name}>
      <Trash2Icon className="size-3.5" />{labeled && "Delete Agent"}
    </Button></AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Delete Agent &quot;{agent.name}」？</AlertDialogTitle>
        <AlertDialogDescription>Prompt words, triggers and ability bindings will be deleted together, and historical conversations will be retained. This action cannot be undone.</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <Button variant="destructive" disabled={busy} onClick={remove}>{busy ? "Deleting..." : "Delete"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function AgentListRow({ agent, onOpen, onDeleted }: { agent: Agent; onOpen: () => void; onDeleted: () => void }) {
  return <div className="settings-resource-row settings-agent-row">
    <button type="button" onClick={onOpen} className="settings-resource-open" aria-label={"Edit " + agent.name}>
      <span className="settings-resource-icon"><Bot aria-hidden="true" /></span>
      <span className="settings-resource-name">
        <span className="settings-resource-title">{agent.name}<span className="settings-resource-key">{agent.key}</span></span>
        {agent.description && <span className="settings-resource-description">{agent.description}</span>}
      </span>
      <span className="settings-resource-kind">{agent.builtin ? "Built-in" : "Custom"}{!agent.enabled && <span className="settings-tag">Disable</span>}</span>
      <span className="settings-resource-counts">MCP {agent.mcp_count ?? 0}<span>·</span>Skill {agent.skill_count ?? 0}<span>·</span>Tools {agent.tool_count ?? 0}</span>
      <ChevronRight className="settings-resource-chevron" aria-hidden="true" />
    </button>
    <div className="settings-resource-actions"><DeleteAgentButton agent={agent} onDeleted={onDeleted} /></div>
  </div>;
}

export default function AgentsPage() {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [editKey, setEditKey] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    setLoading(true);
    setLoadError(false);
    api.agents().then(setAgents).catch(() => setLoadError(true)).finally(() => setLoading(false));
  }, []);
  React.useEffect(() => {
    reload();
  }, [reload]);

  const editing = agents.find((a) => a.key === editKey) ?? null;

  return (
    <SettingsPage title="Agent" actions={<Button size="sm" onClick={()=>{setEditKey(null);setCreating(true);}}><PlusIcon />Create new Agent</Button>}>
      <div className="settings-list-toolbar"><span>{loading ? "Loading…" : `${agents.length} Agents`}</span><span>Prompt word · Model · Capability authorization</span></div>
      <div className="settings-resource-list" aria-label="Agent list">
        {loadError ? <div className="settings-empty" role="alert">Loading failed.<Button variant="outline" size="sm" onClick={reload}>Try again</Button></div>
          : loading && !agents.length ? <div className="settings-empty" role="status">Loading Agent…</div>
          : !agents.length ? <div className="settings-empty">No Agent yet</div>
          : agents.map((a) => <AgentListRow key={a.key} agent={a} onOpen={() => setEditKey(a.key)} onDeleted={reload} />)}
      </div>

      <Sheet open={creating || !!editing} onOpenChange={(o) => {if(!o && !createBusy){setCreating(false);setEditKey(null);}}}>
        <SheetContent
          side="right"
          className="settings-detail-sheet flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        >
          {creating && <>
            <SheetHeader className="px-4"><SheetTitle className="flex items-center gap-2">Create new Agent<HelpButton compact topic="agents" section="Create a new custom Agent" /></SheetTitle><SheetDescription className="sr-only">Configure custom Agent</SheetDescription></SheetHeader>
            <AgentEditor key="new-agent" onBusyChange={setCreateBusy} onCancel={()=>setCreating(false)} onCreated={agent=>{
              setAgents(current=>[...current,agent]);setCreating(false);setEditKey(agent.key);reload();
            }} />
          </>}
          {!creating && editing && (
            <>
              <SheetHeader className="px-4">
                <SheetTitle className="flex items-center gap-2">
                  {editing.name}
                  <HelpButton compact topic="agents" />
                  <span className="text-muted-foreground font-mono text-xs">{editing.key}</span>
                  {!editing.builtin && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">

                      Custom
                    </Badge>
                  )}
                </SheetTitle>
                <SheetDescription>{editing.description || "Prompt words, configuration, visible resources and tool binding"}</SheetDescription>
              </SheetHeader>
              <AgentEditor key={editing.key} agentKey={editing.key} onSaved={reload} />
              {!editing.builtin && <div className="agent-delete-action shrink-0 border-t px-4 py-2"><DeleteAgentButton labeled agent={editing} onDeleted={()=>{setEditKey(null);reload();}} /></div>}
            </>
          )}
        </SheetContent>
      </Sheet>
    </SettingsPage>
  );
}
