"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Download, FileUp, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PocDetails } from "@/components/poc-details";
import { SettingsPage, SettingsPanel, SettingsRow } from "@/components/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { http } from "@/lib/api";

type Entry = {
  id: string;
  native_id: string;
  title: string;
  products: string[];
  cves: string[];
  kind: string;
  severity: string;
  enabled: boolean;
  version_range?: string;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const severityName: Record<string, string> = {
  critical: "Serious",
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
  info: "Information",
  unknown: "—",
};
const empty = { type: "nuclei", name: "", product: "", cves: "", description: "", raw: "" };
function EntryLevel({ entry }: { entry: Entry }) {
  if (!entry.enabled) return <Badge variant="outline">Disabled</Badge>;
  if (entry.kind === "unparsed") return <Badge variant="outline">Parsing exception</Badge>;
  return <>{severityName[entry.severity] ?? entry.severity}</>;
}
export default function PocsPage() {
  const [enabled, setEnabled] = useState(true),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]),
    [total, setTotal] = useState(0),
    [detail, setDetail] = useState<string | null>(null);
  const [aliases, setAliases] = useState<{ alias: string; product: string }[]>([]),
    [alias, setAlias] = useState(""),
    [product, setProduct] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [_revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false),
    [form, setForm] = useState(empty);
  const file = useRef<HTMLInputElement>(null),
    sourceFile = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const d = await http<{ enabled: boolean; aliases: typeof aliases }>("/pocs");
    setEnabled(d.enabled);
    setAliases(d.aliases);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(message(e)));
  }, [load]);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void http<{ items: Entry[]; total: number }>(`/pocs/entries?q=${encodeURIComponent(query)}&offset=${offset}`, {
        signal: ctl.signal,
      })
        .then((d) => {
          if (!ctl.signal.aborted) {
            setEntries(d.items);
            setTotal(d.total);
            setError("");
          }
        })
        .catch((e) => {
          if (!ctl.signal.aborted) setError(message(e));
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, offset]);
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      await load();
      setRevision((v) => v + 1);
      toast.success(success);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsPage
      title="PoC Knowledge Base"
      actions={
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => file.current?.click()}>
            <FileUp />

            Import
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setForm(empty);
              setAdding(true);
            }}
          >
            <Plus />

            Added PoC
          </Button>
        </>
      }
    >
      <SettingsRow title="Task knowledge supply" >
        <Switch
          aria-label="Task knowledge supply"
          checked={enabled}
          disabled={busy}
          onCheckedChange={(value) =>
            void mutate(
              () => http("/pocs/settings", { method: "PUT", body: JSON.stringify({ enabled: value }) }),
              "Settings saved",
            )
          }
        />
      </SettingsRow>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Tabs defaultValue="entries" className="settings-tabs">
        <TabsList className="settings-detail-tabs">
          <TabsTrigger value="entries">All PoCs</TabsTrigger>
          <TabsTrigger value="aliases">Product Mapping</TabsTrigger>
        </TabsList>
        <TabsContent value="entries">
          <SettingsPanel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">

                Total {total.toLocaleString()}  Article{loading ? " · Loading" : ""}
              </span>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                  <Input
                    className="settings-search pl-8"
                    aria-label="Search PoC"
                    placeholder="Name, Product, CVE"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      const d = await http("/pocs/library/export");
                      const url = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: "application/json" }));
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "poc-library.json";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }, "Exported")
                  }
                >
                  <Download />

                  Export
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto border-t">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="px-3">Name</th>
                    <th className="px-3">Related products</th>
                    <th className="px-3">Level</th>
                    <th className="px-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b hover:bg-muted/40">
                      <td className="max-w-md px-3">
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          onClick={() => setDetail(e.id)}
                        >
                          {e.title}
                        </button>
                        <p className="mt-1 truncate text-muted-foreground text-xs" title={e.native_id}>
                          {e.cves.join(" · ") || e.native_id}
                        </p>
                      </td>
                      <td className="max-w-48 px-3">
                        <p className="truncate" title={e.products.join("、")}>
                          {e.products.join("、") || "—"}
                        </p>
                        {e.version_range && <p className="mt-1 text-muted-foreground text-xs">{e.version_range}</p>}
                      </td>
                      <td className="whitespace-nowrap px-3">
                        <EntryLevel entry={e} />
                      </td>
                      <td className="px-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setDetail(e.id)}>

                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!entries.length && <div className="settings-empty">{loading ? "Loading…" : "No matching PoC"}</div>}
            </div>
            <div className="flex items-center justify-end gap-3 text-muted-foreground text-xs">
              <Button
                size="sm"
                variant="outline"
                disabled={!offset || loading}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >

                Previous page
              </Button>
              <span>{Math.floor(offset / 50) + 1}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + 50 >= total || loading}
                onClick={() => setOffset(offset + 50)}
              >

                Next page
              </Button>
            </div>
          </SettingsPanel>
        </TabsContent>
        <TabsContent value="aliases">
          <SettingsPanel>

            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                aria-label="Product alias"
                placeholder="Product alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              />
              <Input
                className="max-w-xs"
                aria-label="Unified product name"
                placeholder="Unify product name, such as tomcat"
                value={product}
                onChange={(e) => setProduct(e.target.value)}
              />
              <Button
                disabled={busy || !alias.trim() || !product.trim()}
                onClick={() =>
                  void mutate(async () => {
                    await http("/pocs/aliases", { method: "PUT", body: JSON.stringify({ alias, product }) });
                    setAlias("");
                    setProduct("");
                  }, "Mapping saved")
                }
              >

                Add mapping
              </Button>
            </div>
            <div className="divide-y border-t">
              {aliases.map((a) => (
                <div key={a.alias} className="flex items-center justify-between py-3 text-sm">
                  <span>
                    {a.alias}
                    <span className="mx-3 text-muted-foreground">→</span>
                    {a.product}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`Delete alias ${a.alias}`}
                    onClick={() =>
                      void mutate(
                        () => http(`/pocs/aliases?alias=${encodeURIComponent(a.alias)}`, { method: "DELETE" }),
                        "Mapping deleted",
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </SettingsPanel>
        </TabsContent>
      </Tabs>
      <input
        ref={file}
        type="file"
        accept=".json,.yaml,.yml"
        className="hidden"
        aria-label="Import PoC file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void mutate(async () => {
            if (f.size > 100 * 1024 * 1024) throw new Error("File cannot exceed 100 MiB");
            const text = await f.text();
            if (/\.ya?ml$/i.test(f.name)) {
              await http("/pocs/entries", { method: "POST", body: JSON.stringify({ type: "nuclei", raw: text }) });
            } else {
              const r = await http<{ accepted: number; failed: number }>("/pocs/library/import", {
                method: "POST",
                body: JSON.stringify(JSON.parse(text)),
              });
              if (r.failed) toast.info(`${r.failed} parsing exception, can be viewed in details`);
            }
            setOffset(0);
          }, "Import completed");
        }}
      />
      <Sheet
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setRevision((v) => v + 1);
          }
        }}
      >
        <SheetContent className="settings-detail-sheet overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>PoC details</SheetTitle>
          </SheetHeader>
          <div className="px-5 pb-5">{detail && <PocDetails entryId={detail} />}</div>
        </SheetContent>
      </Sheet>
      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent className="settings-detail-sheet flex flex-col gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>Added PoC</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
            <Tabs value={form.type} onValueChange={(type) => setForm((f) => ({ ...f, type }))}>
              <TabsList className="settings-detail-tabs">
                <TabsTrigger value="nuclei">Nuclei YAML</TabsTrigger>
                <TabsTrigger value="legacy-python">Python</TabsTrigger>
              </TabsList>
            </Tabs>
            {form.type === "legacy-python" && (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="poc-name">Name</Label>
                  <Input
                    id="poc-name"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="poc-product">Related products</Label>
                    <Input
                      id="poc-product"
                      placeholder="Such as tomcat"
                      value={form.product}
                      onChange={(e) => setForm((f) => ({ ...f, product: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="poc-cves">CVE (optional)</Label>
                    <Input
                      id="poc-cves"
                      value={form.cves}
                      onChange={(e) => setForm((f) => ({ ...f, cves: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="poc-description">Description (optional)</Label>
                  <Textarea
                    id="poc-description"
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <Label htmlFor="poc-body">{form.type === "nuclei" ? "Template text" : "Code text"}</Label>
              <Button size="sm" variant="ghost" onClick={() => sourceFile.current?.click()}>
                <FileUp />

                Reading from file
              </Button>
            </div>
            <Textarea
              id="poc-body"
              className="min-h-80 font-mono text-xs"
              placeholder={form.type === "nuclei" ? "Paste full YAML template to automatically read name, product and CVE" : "Paste Python PoC"}
              value={form.raw}
              onChange={(e) => setForm((f) => ({ ...f, raw: e.target.value }))}
            />
            <input
              ref={sourceFile}
              type="file"
              accept={form.type === "nuclei" ? ".yaml,.yml" : ".py"}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f)
                  void f
                    .text()
                    .then((raw) => setForm((v) => ({ ...v, raw })))
                    .catch((e) => toast.error(message(e)));
              }}
            />
          </div>
          <div className="settings-detail-footer justify-end">
            <Button variant="outline" onClick={() => setAdding(false)}>

              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !form.raw.trim() ||
                (form.type === "legacy-python" && (!form.name.trim() || !form.product.trim()))
              }
              onClick={() =>
                void mutate(async () => {
                  const d = await http<{ id: string }>("/pocs/entries", { method: "POST", body: JSON.stringify(form) });
                  setAdding(false);
                  setDetail(d.id);
                }, "PoC added")
              }
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </SettingsPage>
  );
}
