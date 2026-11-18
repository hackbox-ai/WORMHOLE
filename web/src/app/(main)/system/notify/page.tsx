"use client";

import { FindingAlertPreferences } from "@/components/finding-alert-preferences";
import { SettingsPage, SettingsSection, SettingsRow, SettingsResourceRow } from "@/components/settings-layout";

import * as React from "react";

import { BellIcon, PlusIcon, SendIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { NotificationChannel, NotificationFilter, NotificationMeta } from "@/lib/types";

import {
  CHANNEL_FIELDS,
  type ChannelForm,
  emptyForm,
  KIND_LABEL,
  parseIDs,
  parseKeywords,
  parseKV,
  SEVERITY_OPTIONS,
} from "./_components/channel-fields";
import { ConfigField, FilterSummary } from "./_components/channel-form";
import { DeliveryList } from "./_components/delivery-list";
import { formatBacklog, StatTile } from "./_components/stat-tile";

// This page is only responsible for layout: loading data, maintaining form status, and calling interfaces。
// Field definition and parsing in _components/channel-fields.ts，Control and filter summary in
// _components/channel-form.tsx，Delivery recorded in _components/delivery-list.tsx——
// Split because each of them can be read separately, but when squeezed into one file, this page is close to 1100 OK。
export default function NotifyPage() {
  const [meta, setMeta] = React.useState<NotificationMeta | null>(null);
  const [channels, setChannels] = React.useState<NotificationChannel[]>([]);
  const [tab, setTab] = React.useState<"channels" | "deliveries">("channels");

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NotificationChannel | null>(null);
  const [form, setForm] = React.useState<ChannelForm>(emptyForm("dingtalk"));
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  const [globalSaving, setGlobalSaving] = React.useState(false);
  const [baseURL, setBaseURL] = React.useState("");
  const [digestMin, setDigestMin] = React.useState("");

  const load = React.useCallback(() => {
    api
      .notifyMeta()
      .then((m) => {
        setMeta(m);
        setBaseURL(m.public_base_url);
        setDigestMin(m.digest_interval_min);
      })
      .catch((e) => toast.error("Failed to read push configuration:" + (e as Error).message));
    // Failure to load the channel list should be reported: Silent failure will be displayed as ”Not a single channel」，
    // Users will think that the configuration is lost, which is more confusing than reporting an error directly.。
    api
      .notifyChannels()
      .then(setChannels)
      .catch((e) => toast.error("Failed to read channel list:" + (e as Error).message));
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  function setF(patch: Partial<ChannelForm>) {
    setForm((f) => ({ ...f, ...patch }));
  }
  function setCfg(key: string, value: unknown) {
    setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));
  }

  function openAdd() {
    setEditing(null);
    setForm(emptyForm(meta?.kinds[0]?.kind ?? "dingtalk"));
    setOpen(true);
  }

  function openEdit(ch: NotificationChannel) {
    setEditing(ch);
    // filter On the backend is Go Structure, always serialized into objects (will not be null），So there is no need to tell the truth。
    const f = ch.filter;
    setForm({
      name: ch.name,
      kind: ch.kind,
      mode: ch.mode,
      enabled: ch.enabled,
      ratePerMin: String(ch.rate_per_min),
      // The backend echoes config The credentials here are mask values; put them into the form as they are and send them back as they are when submitting.，
      // The backend retains the original value in the library accordingly。
      config: { ...ch.config },
      minSeverity: f.min_severity ?? "",
      includeText: (f.vulnclass_include ?? []).join("\n"),
      excludeText: (f.vulnclass_exclude ?? []).join("\n"),
      taskIDsText: (f.task_ids ?? []).join(","),
      assetIDsText: (f.asset_ids ?? []).join(","),
      onStatusChange: f.on_status_change ?? false,
    });
    setOpen(true);
  }

  // buildConfig Convert form status to channel config。
  //
  // Unique rule, two types of values：
  //   - Mask value（"__masked__..."）Send it back as is → The backend interprets it as ”This field has not been changed, and the original value in the library is retained.”」
  //   - The rest will be submitted according to user input. An empty string means ”Clear this field.”」
  //
  // The reason why we do not take special care of the credential field (for example, ”leave the credential blank to skip it”) is because that will make the user**Unable to clear**
  // A misconfigured key - there is no action on the interface that says ”I want to delete it”. Under current rules，
  // Clearing the input box is equivalent to clearing the field. The semantics are unique and user-controllable.。
  // Mask value does not appear in the input box (see ConfigField），So ”there are words in the box” is always equal to
  // 「Filled in by the user actively」。
  function buildConfig(): Record<string, unknown> {
    const defs = CHANNEL_FIELDS[form.kind] ?? [];
    const out: Record<string, unknown> = {};
    for (const d of defs) {
      const raw = form.config[d.key];
      if (d.kind === "switch") {
        out[d.key] = raw === true;
        continue;
      }
      if (typeof raw === "string" && raw.startsWith("__masked__")) {
        out[d.key] = raw;
        continue;
      }
      if (d.kind === "number") {
        const n = Number(raw);
        out[d.key] = Number.isFinite(n) && n > 0 ? n : 0;
        continue;
      }
      if (d.kind === "kv") {
        out[d.key] = parseKV(String(raw ?? ""));
        continue;
      }
      if (d.kind === "list") {
        out[d.key] = String(raw ?? "")
          .split(/[\s,，]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }
      out[d.key] = String(raw ?? "").trim();
    }
    return out;
  }

  function buildFilter(): NotificationFilter {
    return {
      min_severity: form.minSeverity || undefined,
      vulnclass_include: parseKeywords(form.includeText),
      vulnclass_exclude: parseKeywords(form.excludeText),
      task_ids: parseIDs(form.taskIDsText),
      asset_ids: parseIDs(form.assetIDsText),
      on_status_change: form.onStatusChange,
    };
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error("Please fill in the channel name");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        kind: form.kind,
        mode: form.mode,
        enabled: form.enabled,
        config: buildConfig(),
        filter: buildFilter(),
        rate_per_min: form.ratePerMin.trim() === "" ? undefined : Number(form.ratePerMin),
      };
      if (editing) {
        await api.notifyUpdateChannel(editing.id, payload);
        toast.success("Saved");
        setOpen(false);
      } else {
        await api.notifyCreateChannel(payload);
        toast.success("Channel added");
        setOpen(false);
      }
      load();
    } catch (e) {
      toast.error("Saving failed:" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function testChannel() {
    if (!editing) return;
    setTesting(true);
    try {
      const r = await api.notifyTestChannel(editing.id);
      toast.success(`Test message issued (${r.latency_ms} ms), please confirm in the group`);
    } catch (e) {
      // The backend returns the original error returned by the channel truthfully. This is the only clue to troubleshoot the configuration. Display it as it is.。
      toast.error("Test failed:" + (e as Error).message, { duration: 12000 });
    } finally {
      setTesting(false);
    }
  }

  async function removeChannel(ch: NotificationChannel) {
    try {
      await api.notifyDeleteChannel(ch.id);
      toast.success(`Deleted:${ch.name}`);
      setOpen(false);
      load();
    } catch (e) {
      toast.error("Delete failed:" + (e as Error).message);
    }
  }

  async function toggleEnabled(ch: NotificationChannel) {
    try {
      await api.notifyUpdateChannel(ch.id, { enabled: !ch.enabled });
      load();
    } catch (e) {
      toast.error("Operation failed:" + (e as Error).message);
    }
  }

  async function toggleGlobal(on: boolean) {
    setGlobalSaving(true);
    try {
      await api.setSettings({ notify_enabled: on });
      setMeta((m) => (m ? { ...m, enabled: on } : m));
      toast.success(on ? "Push is enabled" : "Push has been paused");
    } catch (e) {
      toast.error("Operation failed:" + (e as Error).message);
    } finally {
      setGlobalSaving(false);
    }
  }

  async function saveGlobal() {
    setGlobalSaving(true);
    try {
      const patch: Record<string, unknown> = { notify_public_base_url: baseURL.trim() };
      const n = Number(digestMin);
      if (Number.isFinite(n) && n > 0) patch.notify_digest_interval_min = n;
      await api.setSettings(patch);
      toast.success("Saved");
      load();
    } catch (e) {
      toast.error("Saving failed:" + (e as Error).message);
    } finally {
      setGlobalSaving(false);
    }
  }

  const fields = CHANNEL_FIELDS[form.kind] ?? [];
  const secretKeys = new Set(meta?.kinds.find((k) => k.kind === form.kind)?.secret_keys ?? []);
  const defaultRate = meta?.kinds.find((k) => k.kind === form.kind)?.default_rate_per_min ?? 0;

  return (
    <SettingsPage title="Notice" actions={<><Button size="sm" onClick={openAdd}><PlusIcon />Add channel</Button></>}>
      {meta && (
        <div className="settings-metrics">
          <StatTile label="Channel" value={`${meta.stats.channels_on} / ${meta.stats.channels}`} hint="Enable/Total" />
          <StatTile label="Delivered today" value={String(meta.stats.sent_today)} />
          <StatTile label="To be sent" value={String(meta.stats.pending)} />
          <StatTile label="Failure" value={String(meta.stats.failed)} tone={meta.stats.failed > 0 ? "red" : undefined} />
          <StatTile
            label="Longest backlog"
            value={formatBacklog(meta.stats.backlog_age_ms)}
            // Backlog age is much more useful than backlog number: Backlog 3 Articles can be from 3 Seconds up 3 hours。
            hint={meta.stats.backlog_age_ms > 5 * 60_000 ? "Push may be stuck" : undefined}
            tone={meta.stats.backlog_age_ms > 5 * 60_000 ? "red" : undefined}
          />
        </div>
      )}

      <FindingAlertPreferences />
      <SettingsSection title="Send settings">
        {meta && <SettingsRow title="Notification push" ><Switch checked={meta.enabled} disabled={globalSaving} onCheckedChange={toggleGlobal} aria-label="Push master switch" /></SettingsRow>}
        <SettingsRow title="Return link address" htmlFor="n-base" ><Input id="n-base" placeholder="https://wormhole.example.com" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} /></SettingsRow>
        <SettingsRow title="Summary cycle" htmlFor="n-digest" ><Input id="n-digest" type="number" min={1} max={1440} value={digestMin} onChange={(e) => setDigestMin(e.target.value)} /></SettingsRow>
        <div className="settings-section-actions"><Button size="sm" onClick={saveGlobal} disabled={globalSaving}>Save sending settings</Button></div>
      </SettingsSection>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "channels" | "deliveries")} className="settings-tabs flex flex-col gap-4">
        <TabsList className="settings-detail-tabs">
          <TabsTrigger value="channels">Channel</TabsTrigger>
          <TabsTrigger value="deliveries">Delivery record</TabsTrigger>
        </TabsList>

        <TabsContent value="channels">
          <div className="settings-list-toolbar"><span>{channels.length}  channels</span><span>Channel type · Push scope · Enabled status</span></div>
          <div className="settings-resource-list" aria-label="Notification channel list">
            {channels.map((ch) => <SettingsResourceRow key={ch.id} title={ch.name} description={<FilterSummary filter={ch.filter} />} icon={<BellIcon />} kind={KIND_LABEL[ch.kind] ?? ch.kind} meta={ch.mode === "digest" ? "Summary" : "Real time"} onOpen={() => openEdit(ch)}
              actions={<><Switch checked={ch.enabled} onCheckedChange={() => toggleEnabled(ch)} aria-label={`Enable ${ch.name}`} /><Button size="icon-sm" variant="ghost" aria-label={`Delete ${ch.name}`} onClick={() => void removeChannel(ch)}><Trash2Icon className="size-3.5" /></Button></>} />)}
            {!channels.length && <div className="settings-empty">No notification channel yet</div>}
          </div>
        </TabsContent>

        <TabsContent value="deliveries">
          <DeliveryList channels={channels} />
        </TabsContent>
      </Tabs>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="settings-detail-sheet data-[side=right]:w-full data-[side=right]:sm:max-w-2xl w-full">
          <SheetHeader>
            <SheetTitle>{editing ? editing.name : "Add notification channel"}</SheetTitle>
            <SheetDescription>
              {KIND_LABEL[form.kind] ?? form.kind}
              {defaultRate > 0 ? ` · Default current limit ${defaultRate} items/minute` : " · No current limit"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Channel Type</Label>
                <Select
                  value={form.kind}
                  onValueChange={(v) => {
                    // Changing the type is equivalent to changing a set of credential fields, and the old configuration cannot be merged.。
                    setF({ kind: v, config: {} });
                  }}
                  disabled={!!editing}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(meta?.kinds ?? []).map((k) => (
                      <SelectItem key={k.kind} value={k.kind}>
                        {KIND_LABEL[k.kind] ?? k.kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editing && (
                  null
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="n-name">Channel name</Label>
                <Input
                  id="n-name"
                  placeholder="Emergency response group/Daily reporting group"
                  value={form.name}
                  onChange={(e) => setF({ name: e.target.value })}
                />
              </div>

              {fields.length === 0 ? (
                <p className="text-muted-foreground text-sm">

                  The form of this channel has not been defined (the front-end is missing the CHANNEL_FIELDS entry), please complete it and try again.
                </p>
              ) : (
                fields.map((d) => (
                  <ConfigField
                    key={d.key}
                    def={d}
                    value={form.config[d.key]}
                    isSecret={secretKeys.has(d.key)}
                    onChange={(v) => setCfg(d.key, v)}
                  />
                ))
              )}

              <div className="grid gap-2">
                <Label>Push timing</Label>
                <Select value={form.mode} onValueChange={(v) => setF({ mode: v as "realtime" | "digest" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="realtime">Real-time · Each vulnerability is sent separately</SelectItem>
                    <SelectItem value="digest">Summary · Combined into one by period</SelectItem>
                  </SelectContent>
                </Select>

              </div>

              <div className="grid gap-2">
                <Label htmlFor="n-rate">Current limit (bar/minute)</Label>
                <Input
                  id="n-rate"
                  type="number"
                  min={0}
                  placeholder={defaultRate > 0 ? String(defaultRate) : "0 = No limit"}
                  value={form.ratePerMin}
                  onChange={(e) => setF({ ratePerMin: e.target.value })}
                />

              </div>

              <div className="border-t pt-4">
                <p className="mb-3 text-sm font-medium">Filter rules (leave blank to not filter)</p>
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label>Lowest level</Label>
                    <Select
                      value={form.minSeverity || "all"}
                      onValueChange={(v) => setF({ minSeverity: v === "all" ? "" : v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SEVERITY_OPTIONS.map((o) => (
                          <SelectItem key={o.value || "all"} value={o.value || "all"}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="n-inc">Only push these vulnerability types</Label>
                    <Textarea
                      id="n-inc"
                      placeholder={"SQL injection\nCommand execution"}
                      value={form.includeText}
                      onChange={(e) => setF({ includeText: e.target.value })}
                    />

                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="n-exc">Exclude these vulnerability types</Label>
                    <Textarea
                      id="n-exc"
                      placeholder={"Information leakage"}
                      value={form.excludeText}
                      onChange={(e) => setF({ excludeText: e.target.value })}
                    />

                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="n-tasks">Qualified task ID</Label>
                    <Input
                      id="n-tasks"
                      placeholder="1, 2, 3"
                      value={form.taskIDsText}
                      onChange={(e) => setF({ taskIDsText: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="n-assets">Qualified Asset ID</Label>
                    <Input
                      id="n-assets"
                      placeholder="10, 11"
                      value={form.assetIDsText}
                      onChange={(e) => setF({ assetIDsText: e.target.value })}
                    />

                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={form.onStatusChange}
                      onCheckedChange={(v) => setF({ onStatusChange: v })}
                      aria-label="Receive status change"
                    />

                    Also pushed when vulnerability disposal status changes (only in real-time mode)
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm">
                <Switch checked={form.enabled} onCheckedChange={(v) => setF({ enabled: v })} aria-label="Enabled" />

                Enable this channel
              </div>
            </div>

          </div>
            <div className="settings-detail-footer">
              <Button onClick={saveForm} disabled={saving}>
                {editing ? "Save" : "Add"}
              </Button>
              {editing && (
                <Button variant="outline" onClick={testChannel} disabled={testing}>
                  <SendIcon />  Send test message
                </Button>
              )}
            </div>
        </SheetContent>
      </Sheet>
    </SettingsPage>
  );
}
