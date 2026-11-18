"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SettingsPage, SettingsPanel } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { http } from "@/lib/api";
type Extension = { key: string; state: string; detail: string; settings: string };
const names: Record<string, string> = {
  pocs: "PoC Knowledge Base",
  fingerprints: "Fingerprint engine and rules",
  whitebox: "White box code analysis",
  rea: "REA reverse analysis",
  protocol: "Protocol Analysis",
  scopesentry: "ScopeSentry",
};
const states: Record<string, string> = {
  available: "Available",
  not_installed: "Not installed",
  not_configured: "Not configured",
  disabled: "Disabled",
  empty: "Data has not been imported yet",
  unreachable: "Connection abnormality",
};
export default function ExtensionsPage() {
  const [items, setItems] = useState<Extension[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load(refresh = false) {
    setBusy(true);
    setError("");
    try {
      setItems((await http<{ extensions: Extension[] }>("/extensions" + (refresh ? "?refresh=1" : ""))).extensions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <SettingsPage title="Optional extensions">
      <p className="text-sm text-muted-foreground">

        The core platform can run independently. Install tools, connect services, or import data as needed, and then authorize the Agent.
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => void load(true)} disabled={busy}>
          {busy ? "Detecting..." : "Retest"}
        </Button>
        <Button variant="outline" asChild>
          <Link href="/help?topic=extensions">Installation and Access Instructions</Link>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {items.map((item) => (
        <SettingsPanel key={item.key} className="p-5">
          <h2 className="mb-3 font-semibold">{names[item.key] ?? item.key}</h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className={item.state === "available" ? "text-green-600" : "text-muted-foreground"}>
                {states[item.state] ?? item.state}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
            </div>
            <Button variant="outline" asChild>
              <Link href={item.settings}>Configuration</Link>
            </Button>
          </div>
        </SettingsPanel>
      ))}
    </SettingsPage>
  );
}
