"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Download, FileUp, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsPage, SettingsRow } from "@/components/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { http } from "@/lib/api";

const families = [
  ["ehole", "EHole"],
  ["goby", "Goby"],
  ["wappalyzer", "Wappalyzer"],
  ["fingers", "Fingers"],
  ["fingerprinthub", "FingerPrintHub"],
  ["arl", "ARL"],
] as const;
type Family = (typeof families)[number][0];
type Rule = {
  id: string;
  family: Family;
  name: string;
  raw: Record<string, unknown>;
  enabled: boolean;
  builtin: boolean;
  compile_status: string;
  compile_reason: string;
};
type Library = {
  family: Family;
  rules: number;
  products: number;
  enabled: number;
  ready: number;
  partial: number;
  unsupported: number;
};
type SampleResult = {
  matches?: { rule_id: string; product: string; locations: string[] }[];
  diagnostics?: { id: string; status: string; reason?: string }[];
};
const statusName: Record<string, string> = {
  pending: "To be verified",
  ready: "Recognizable",
  partial: "Partially supported",
  unsupported: "Not supported yet",
};
const initialRule: Record<Family, object> = {
  ehole: { cms: "Custom products", method: "keyword", location: "body", keyword: ["Feature content"] },
  goby: { name: "Custom products", logic: "a", rule: [{ label: "a", feature: "Feature content", is_equal: true }] },
  wappalyzer: { html: ["Feature content"] },
  fingers: { name: "Custom products", rule: [{ regexps: { body: ["Feature content"] } }] },
  fingerprinthub: {
    id: "custom-product",
    info: { name: "Custom products" },
    http: [{ method: "GET", path: ["{{BaseURL}}/"], matchers: [{ type: "word", words: ["Feature content"] }] }],
  },
  arl: { name: "Custom products", rule: "body=\"Feature content\"" },
};
function documentFor(family: Family, name: string, raw: unknown) {
  if (family === "ehole") return { fingerprint: [raw] };
  if (family === "wappalyzer") return { apps: { [name]: raw } };
  return [raw];
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export default function FingerprintsPage() {
  const [family, setFamily] = useState<Family>("ehole"),
    [libraries, setLibraries] = useState<Library[]>([]),
    [enabled, setEnabled] = useState(true),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [offset, setOffset] = useState(0),
    [rules, setRules] = useState<Rule[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<Rule | null | undefined>(undefined),
    [raw, setRaw] = useState(""),
    [name, setName] = useState("Custom products"),
    [sampleBody, setSampleBody] = useState(""),
    [sampleHeaders, setSampleHeaders] = useState("Content-Type: text/html"),
    [sampleURL, setSampleURL] = useState("https://sample.invalid/"),
    [sampleMethod, setSampleMethod] = useState("GET"),
    [sampleResult, setSampleResult] = useState<SampleResult | null>(null);
  const [sampleRaw, setSampleRaw] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const refreshLibraries = useCallback(async () => {
    const data = await http<{ enabled: boolean; libraries: Library[] }>("/fingerprints");
    setLibraries(data.libraries);
    setEnabled(data.enabled);
  }, []);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const data = await http<{ rules: Rule[]; total: number }>(
          `/fingerprints/rules?family=${family}&q=${encodeURIComponent(query)}&status=${status}&offset=${offset}`,
          { signal },
        );
        if (!signal?.aborted) {
          setRules(data.rules);
          setTotal(data.total);
          setError("");
        }
      } catch (e) {
        if (!signal?.aborted) setError(message(e));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [family, query, status, offset],
  );
  useEffect(() => {
    void refreshLibraries().catch((e) => setError(message(e)));
  }, [refreshLibraries]);
  useEffect(() => {
    const ctl = new AbortController(),
      timer = setTimeout(() => void load(ctl.signal), 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [load]);
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await Promise.all([load(), refreshLibraries()]);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (rule: Rule | null) => {
    setEditing(rule);
    setRaw(JSON.stringify(rule ? rule.raw : initialRule[family], null, 2));
    setName(rule ? rule.name : "Custom products");
    setSampleResult(null);
    setSampleRaw(false);
  };
  const exportFile = async () => {
    try {
      const data = await http<unknown>(`/fingerprints/export?family=${family}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${family}.wormhole-fingerprints.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(message(e));
    }
  };
  const current = libraries.find((l) => l.family === family);
  return (
    <SettingsPage
      title="Fingerprint management"
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void mutate(() => http("/fingerprints/compile", { method: "POST" }), "Rule has been revalidated")}
          >
            <RefreshCw className="size-4" />

            Verification rules
          </Button>
          <Button size="sm" onClick={() => open(null)}>
            <Plus className="size-4" />

            Add new rule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <SettingsRow title="Automatic task recognition" >
          <Switch
            aria-label="Automatic task recognition"
            checked={enabled}
            disabled={busy}
            onCheckedChange={(value) =>
              void mutate(
                () => http("/fingerprints/settings", { method: "PUT", body: JSON.stringify({ enabled: value }) }),
                value ? "Automatic recognition is turned on" : "Automatic recognition is turned off",
              )
            }
          />
        </SettingsRow>
        <Tabs
          value={family}
          onValueChange={(id) => {
            setFamily(id as Family);
            setOffset(0);
            setQuery("");
            setStatus("");
          }}
        >
          <TabsList className="settings-detail-tabs" aria-label="Fingerprint database">
            {families.map(([id, label]) => {
              const lib = libraries.find((l) => l.family === id);
              return (
                <TabsTrigger key={id} value={id}>
                  {label}
                  <span className="ml-1 text-muted-foreground text-xs">{lib?.rules ?? 0}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-4 text-muted-foreground text-xs">
          <span>{current?.products ?? 0}  products</span>
          <span>Enabled {current?.enabled ?? 0}</span>
          <span>Recognizable {current?.ready ?? 0}</span>
          <span>Partially supported {current?.partial ?? 0}</span>
          <span>Not supported {current?.unsupported ?? 0}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 max-w-sm flex-1">
            <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Search fingerprint name"
              className="pl-9"
              placeholder="Search product or fingerprint name"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <select
            aria-label="Identify support status"
            className="rounded-md border bg-background px-3 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All status</option>
            {Object.entries(statusName).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <Button variant="outline" disabled={busy} onClick={() => upload.current?.click()}>
            <FileUp className="size-4" />

            Import
          </Button>
          <Button variant="outline" onClick={() => void exportFile()}>
            <Download className="size-4" />

            Export
          </Button>
          <input
            ref={upload}
            type="file"
            accept=".json,.yaml,.yml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void mutate(async () => {
                  if (file.size > 10 * 1024 * 1024) throw new Error("File cannot exceed 10 MB");
                  return http("/fingerprints/import", {
                    method: "POST",
                    body: JSON.stringify({ family, document: await file.text() }),
                  });
                }, "Fingerprints have been imported");
              e.target.value = "";
            }}
          />
        </div>
        {error && (
          <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-destructive text-sm">
            {error}
          </div>
        )}
        <div className="overflow-x-auto border-t">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Source</th>
                <th className="p-3">Identification status</th>
                <th className="p-3">Enabled</th>
                <th className="p-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b hover:bg-muted/40">
                  <td className="max-w-80 p-3">
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => open(rule)}>
                      {rule.name}
                    </button>
                  </td>
                  <td className="p-3">{rule.builtin ? "Built-in" : "Custom"}</td>
                  <td className="max-w-80 p-3">
                    <Badge variant={rule.compile_status === "unsupported" ? "destructive" : "secondary"}>
                      {statusName[rule.compile_status] ?? rule.compile_status}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Switch
                      aria-label={`Enable ${rule.name}`}
                      checked={rule.enabled}
                      disabled={busy}
                      onCheckedChange={(value) =>
                        void mutate(
                          () =>
                            http(`/fingerprints/rules/${rule.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ enabled: value }),
                            }),
                          "Rule updated",
                        )
                      }
                    />
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      aria-label={`Delete ${rule.name}`}
                      onClick={() => {
                        if (window.confirm(`Delete fingerprint"${rule.name}"? Rule snapshots of existing tasks will be retained.`))
                          void mutate(() => http(`/fingerprints/rules/${rule.id}`, { method: "DELETE" }), "Rule deleted");
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rules.length && (
            <div className="p-10 text-center text-muted-foreground text-sm">
              {loading ? "Loading fingerprints..." : "No matching rules"}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">

            Total {total}  rules{loading ? " · Loading" : ""}
          </span>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!offset || loading}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >

              Previous page
            </Button>
            <span>{Math.floor(offset / 50) + 1}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + 50 >= total || loading}
              onClick={() => setOffset(offset + 50)}
            >

              Next page
            </Button>
          </div>
        </div>
      </div>
      <Sheet
        open={editing !== undefined}
        onOpenChange={(value) => {
          if (!value) setEditing(undefined);
        }}
      >
        <SheetContent className="settings-detail-sheet overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit fingerprint" : "Add fingerprint"}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 p-4">
            <Tabs key={editing?.id ?? "new"} defaultValue="rule">
              <TabsList className="settings-detail-tabs">
                <TabsTrigger value="rule">Rules</TabsTrigger>
                <TabsTrigger value="sample">Sample test</TabsTrigger>
              </TabsList>
              <TabsContent value="rule" className="space-y-4 pt-3">
                {family === "wappalyzer" && (
                  <div className="space-y-2">
                    <Label htmlFor="fingerprint-name">Product name</Label>
                    <Input
                      id="fingerprint-name"
                      value={name}
                      disabled={!!editing}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="fingerprint-rule">Original rules JSON</Label>
                  <Textarea
                    id="fingerprint-rule"
                    className="min-h-72 font-mono text-xs"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                  />
                </div>
                {editing?.compile_reason && <p className="text-muted-foreground text-sm">{editing.compile_reason}</p>}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      const parsed = JSON.parse(raw);
                      if (editing)
                        return http(`/fingerprints/rules/${editing.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ raw: parsed }),
                        });
                      return http("/fingerprints/import", {
                        method: "POST",
                        body: JSON.stringify({ family, document: documentFor(family, name, parsed) }),
                      });
                    }, "Rule saved")
                  }
                >

                  Save rules
                </Button>
              </TabsContent>
              <TabsContent value="sample" className="space-y-3 pt-3">

                <Input aria-label="Sample URL" value={sampleURL} onChange={(e) => setSampleURL(e.target.value)} />
                <select
                  aria-label="Sample request method"
                  className="rounded-md border bg-background p-2 text-sm"
                  value={sampleMethod}
                  onChange={(e) => setSampleMethod(e.target.value)}
                >
                  <option>GET</option>
                  <option>HEAD</option>
                  <option>POST</option>
                </select>
                <Textarea
                  aria-label="Sample response header"
                  placeholder="Response header"
                  value={sampleHeaders}
                  onChange={(e) => setSampleHeaders(e.target.value)}
                  className="font-mono text-xs"
                />
                <Textarea
                  aria-label="Sample response text"
                  placeholder="Paste response text"
                  value={sampleBody}
                  onChange={(e) => setSampleBody(e.target.value)}
                  className="min-h-32 font-mono text-xs"
                />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setSampleRaw(false);
                      setSampleResult(
                        await http<SampleResult>("/fingerprints/sample", {
                          method: "POST",
                          body: JSON.stringify({
                            family,
                            document: documentFor(family, name, JSON.parse(raw)),
                            url: sampleURL,
                            method: sampleMethod,
                            headers: sampleHeaders,
                            body: sampleBody,
                          }),
                        }),
                      );
                    } catch (e) {
                      toast.error(message(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >

                  Test match
                </Button>
                {sampleResult !== null && (
                  <div className="space-y-3 border-t pt-4" role="status">
                    <p className="text-sm">
                      {sampleResult.matches?.length ? `Hit ${sampleResult.matches.length} rules` : "Miss"}
                    </p>
                    {sampleResult.matches?.map((m) => (
                      <div key={m.rule_id} className="flex items-center justify-between gap-3 text-sm">
                        <span>{m.product}</span>
                        <span className="text-muted-foreground text-xs">{m.locations.join("、")}</span>
                      </div>
                    ))}
                    {sampleResult.diagnostics
                      ?.filter((d) => d.status !== "ready")
                      .map((d) => (
                        <p key={d.id} className="text-muted-foreground text-xs">
                          {statusName[d.status] ?? d.status}
                          {d.reason ? `：${d.reason}` : ""}
                        </p>
                      ))}
                    <Button variant="ghost" size="sm" onClick={() => setSampleRaw((v) => !v)}>
                      {sampleRaw ? "Close original results" : "View original results"}
                    </Button>
                    {sampleRaw && (
                      <pre className="max-h-80 overflow-auto rounded bg-muted p-3 text-xs">
                        {JSON.stringify(sampleResult, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>
    </SettingsPage>
  );
}
