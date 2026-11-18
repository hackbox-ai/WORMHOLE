"use client";

import * as React from "react";

import { ChevronRight, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPage } from "@/components/settings-layout";
import { api } from "@/lib/api";
import type { Agent, MCPServer, MCPTool } from "@/lib/types";

type Transport = "stdio" | "http" | "sse";
type FormState = {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: string;
  insecure: boolean;
};
const emptyForm: FormState = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  insecure: false,
};

export default function MCPPage() {
  const [servers, setServers] = React.useState<MCPServer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [visibility, setVisibility] = React.useState<Record<number, string[]>>({});

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MCPServer | null>(null); // null = add mode
  const [tab, setTab] = React.useState<"config" | "tools" | "access">("config");
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [saving, setSaving] = React.useState(false);
  const [tools, setTools] = React.useState<MCPTool[]>([]);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(false);
    api
      .agents()
      .then(setAgents)
      .catch(() => {});
    api
      .mcpServers()
      .then((ss) => {
        setServers(ss);
        ss.forEach((s) =>
          api
            .resourceVisibility("mcp", s.id)
            .then((ids) => setVisibility((v) => ({ ...v, [s.id]: ids })))
            .catch(() => toast.error("MCP authorization loading failed, please refresh and try again")),
        );
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  function setF(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        if (key) out[key] = trimmed.slice(idx + 1).trim();
      }
    }
    return out;
  }
  function envToText(env: Record<string, string> | undefined): string {
    return Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setTools([]);
    setTab("config");
    setOpen(true);
  }

  function openEdit(s: MCPServer) {
    setEditing(s);
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command ?? "",
      args: (s.args ?? []).join(" "),
      url: s.url ?? "",
      env: envToText(s.env),
      insecure: s.insecure ?? false,
    });
    setTab("config");
    setOpen(true);
    loadTools(s.id);
  }

  async function loadTools(id: number) {
    setToolsLoading(true);
    try {
      setTools(await api.mcpTools(id));
    } catch {
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error("Please fill in the name");
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      toast.error("Please fill in the command");
      return;
    }
    if (form.transport !== "stdio" && !form.url.trim()) {
      toast.error("Please fill in the remote URL");
      return;
    }
    setSaving(true);
    try {
      const base =
        form.transport !== "stdio"
          ? {
              transport: form.transport,
              url: form.url.trim(),
              command: "",
              args: [] as string[],
              env: parseEnv(form.env), // In remote mode env That is, the request header
              insecure: form.insecure,
            }
          : {
              transport: "stdio" as const,
              command: form.command.trim(),
              args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
              env: parseEnv(form.env),
              insecure: false,
            };
      await api.saveMcpServer({
        ...(editing ? { id: editing.id } : {}),
        name: form.name.trim(),
        enabled: editing ? editing.enabled : true,
        ...base,
      });
      toast.success(editing ? "Saved" : "MCP server added");
      if (!editing) setOpen(false);
      load();
    } catch (e) {
      toast.error("Saving failed:" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function refreshTools() {
    if (!editing) return;
    setRefreshing(true);
    try {
      const t = await api.refreshMcpServer(editing.id);
      setTools(t);
      toast.success(`Discovery ${t.length} tools`);
      load();
    } catch (e) {
      toast.error("Refresh failed:" + (e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function removeServer(s: MCPServer) {
    try {
      await api.deleteMcpServer(s.id);
      toast.success(`Deleted:${s.name}`);
      setOpen(false);
      load();
    } catch (e) {
      toast.error("Delete failed:" + (e as Error).message);
    }
  }

  async function toggleEnabled(s: MCPServer) {
    try {
      await api.saveMcpServer({ ...s, enabled: !s.enabled });
      load();
    } catch (e) {
      toast.error("Operation failed:" + (e as Error).message);
    }
  }

  async function toggleVisibility(serverId: number, agentId: string, agentName: string) {
    const on = (visibility[serverId] ?? []).includes(agentId);
    try {
      await api.toggleVisibility(agentId, "mcp", serverId, !on);
      toast.success(`${on ? "Cancel" : "Granted"}「${agentName}"Authorization`);
      load();
    } catch (e) {
      toast.error("Operation failed:" + (e as Error).message);
    }
  }

  function renderForm() {
    return (
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label>Transmission method</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={form.transport === "stdio" ? "default" : "outline"}
              onClick={() => setF({ transport: "stdio" })}
            >

              stdio (local)
            </Button>
            <Button
              type="button"
              variant={form.transport === "http" ? "default" : "outline"}
              onClick={() => setF({ transport: "http" })}
            >

              http (remote)
            </Button>
            <Button
              type="button"
              variant={form.transport === "sse" ? "default" : "outline"}
              onClick={() => setF({ transport: "sse" })}
            >

              sse (old version)
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="m-name">Name</Label>
          <Input
            id="m-name"
            placeholder="filesystem"
            value={form.name}
            onChange={(e) => setF({ name: e.target.value })}
          />
        </div>
        {form.transport === "stdio" ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="m-cmd">Command</Label>
              <Input
                id="m-cmd"
                className="font-mono"
                placeholder="npx"
                value={form.command}
                onChange={(e) => setF({ command: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-args">Parameters (space separated)</Label>
              <Input
                id="m-args"
                className="font-mono"
                placeholder="-y @modelcontextprotocol/server-filesystem /data"
                value={form.args}
                onChange={(e) => setF({ args: e.target.value })}
              />
            </div>
          </>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="m-url">Remote URL</Label>
            <Input
              id="m-url"
              className="font-mono"
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e) => setF({ url: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.insecure} onCheckedChange={(v) => setF({ insecure: v === true })} />

              Skip TLS certificate verification (self-signed certificate)
            </label>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="m-env">
            {form.transport !== "stdio"
              ? "Request header (KEY=VALUE per line, such as Authorization=Bearer xxx)"
              : "Environment variables (KEY=VALUE per line)"}
          </Label>
          <Textarea
            id="m-env"
            className="font-mono"
            placeholder={form.transport !== "stdio" ? "Authorization=Bearer xxxx" : "API_KEY=xxxx\nFOO=bar"}
            value={form.env}
            onChange={(e) => setF({ env: e.target.value })}
          />
        </div>
      </div>
    );
  }

  function renderTools() {
    return (
      <div className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">{tools.length}  tools</span>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={refreshTools}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />  Refresh
          </Button>
        </div>
        {toolsLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="text-muted-foreground text-sm">The tool has not been found, click Refresh to obtain it again.</p>
        ) : (
          <div className="flex flex-col divide-y">
            {tools.map((t) => (
              <div key={t.name} className="py-2.5">
                <code className="font-mono text-sm">{t.name}</code>
                {t.description && (
                  <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{t.description}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <SettingsPage title="MCP" actions={<Button size="sm" onClick={openAdd}><PlusIcon />Add MCP</Button>}>
      <div className="settings-list-toolbar"><span>{loading ? "Loading…" : `${servers.length} services`}</span><span>Connection · Tool · Agent Authorization</span></div>
      <div className="settings-resource-list" aria-label="MCP Service List">
        {loadError ? <div className="settings-empty" role="alert">Loading failed.<Button variant="outline" size="sm" onClick={load}>Try again</Button></div>
          : loading && !servers.length ? <div className="settings-empty" role="status">Loading MCP…</div>
          : !servers.length ? <div className="settings-empty">There is currently no MCP service. Configure connection and authorization after adding it.</div>
          : servers.map((s) => (
            <div className="settings-resource-row settings-mcp-row" key={s.id}>
              <button type="button" onClick={() => openEdit(s)} className="settings-resource-open" aria-label={`Configuration ${s.name}`}>
                <span className="settings-resource-icon"><ServerIcon aria-hidden="true" /></span>
                <span className="settings-resource-name"><span className="settings-resource-title">{s.name}</span><span className="settings-resource-description">{s.tools?.length ? `${s.tools.length} tools` : "Tool not found yet"}</span></span>
                <span className="settings-resource-kind uppercase">{s.transport}</span>
                <span className="settings-resource-counts">{visibility[s.id] ? `${visibility[s.id].length} Agent authorizations` : "Authorization loading..."}</span>
                <ChevronRight className="settings-resource-chevron" aria-hidden="true" />
              </button>
              <Switch checked={s.enabled} onCheckedChange={() => toggleEnabled(s)} aria-label={`Enable ${s.name}`} />
            </div>
          ))}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="settings-detail-sheet flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{editing ? editing.name : "Add MCP"}</SheetTitle>
            <SheetDescription>{editing ? "Connection configuration and capability authorization" : "Select protocol and fill in connection information"}</SheetDescription>
          </SheetHeader>
          {editing ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "config" | "tools" | "access")} className="flex min-h-0 flex-1 flex-col px-5">
              <TabsList className="settings-detail-tabs">
                <TabsTrigger value="config">Connection</TabsTrigger>
                <TabsTrigger value="tools">Tool{tools.length ? ` · ${tools.length}` : ""}</TabsTrigger>
                <TabsTrigger value="access">Authorization</TabsTrigger>
              </TabsList>
              <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto">{renderForm()}</TabsContent>
              <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto">{renderTools()}</TabsContent>
              <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto py-4">

                {agents.map((a) => (
                  <label key={a.key} className="settings-access-row">
                    <span><span className="text-sm font-medium">{a.name}</span><span className="text-muted-foreground ml-2 font-mono text-xs">{a.key}</span></span>
                    <Checkbox disabled={!visibility[editing.id]} checked={(visibility[editing.id] ?? []).includes(a.key)} onCheckedChange={() => toggleVisibility(editing.id, a.key, a.name)} />
                  </label>
                ))}
              </TabsContent>
            </Tabs>
          ) : <div className="min-h-0 flex-1 overflow-y-auto px-5">{renderForm()}</div>}
          <div className="settings-detail-footer">
            {editing && <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive"><Trash2Icon />Delete service</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>Delete &quot;{editing.name}」？</AlertDialogTitle><AlertDialogDescription>The connection configuration and Agent authorization will be removed and cannot be revoked.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => removeServer(editing)}>Delete</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>}
            <div className="ml-auto flex gap-2"><Button variant="outline" size="sm" onClick={() => setOpen(false)}>Close</Button>{(!editing || tab === "config") && <Button size="sm" onClick={saveForm} disabled={saving}>{saving ? "Saving…" : editing ? "Save" : "Add"}</Button>}</div>
          </div>
        </SheetContent>
      </Sheet>
    </SettingsPage>
  );
}
