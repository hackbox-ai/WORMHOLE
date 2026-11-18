"use client";
import {NetworkSettingsSection} from "@/components/network-mode";

import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings-layout";

import * as React from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { CHAT_SEND_MODE_OPTIONS, type ChatSendMode, setChatSendMode, useChatSendMode } from "@/lib/chat-send-mode";
import type { Settings } from "@/lib/types";

import { UpdateCard } from "./_components/update-card";
import { EmailAlertSettings } from "./_components/email-alert-settings";
import { TaskBudgetSettings } from "./_components/task-budget-settings";

export default function SystemSettingsPage() {
  const [efficiency, setEfficiency] = React.useState<Settings["task_efficiency"]>();
  const [trafficCapture, setTrafficCapture] = React.useState(false);
  const [agentTrafficBinding, setAgentTrafficBinding] = React.useState(false);
  const [webSearch, setWebSearch] = React.useState(false);
  const [backend, setBackend] = React.useState("ddgs");
  const [braveKeySet, setBraveKeySet] = React.useState(false);
  const [braveKeyInput, setBraveKeyInput] = React.useState("");
  const [tavilyKeySet, setTavilyKeySet] = React.useState(false);
  const [tavilyKeyInput, setTavilyKeyInput] = React.useState("");
  const [savingTavilyKey, setSavingTavilyKey] = React.useState(false);
  const [proxyInput, setProxyInput] = React.useState("");
  const [savingProxy, setSavingProxy] = React.useState(false);
  const [globalProxyInput, setGlobalProxyInput] = React.useState("");
  const [savingGlobalProxy, setSavingGlobalProxy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savingKey, setSavingKey] = React.useState(false);
  const [pyInterp, setPyInterp] = React.useState("");
  const [workers, setWorkers] = React.useState("3");
  const [savingWorkers, setSavingWorkers] = React.useState(false);
  // Operational constraint injection range(Both are enabled by default)。
  const [injectPlanner, setInjectPlanner] = React.useState(true);
  const [injectWorker, setInjectWorker] = React.useState(true);
  // Experimental functions:noa Context compression(Default off)。
  const [noaCompaction, setNoaCompaction] = React.useState(false);
  // Pure front-end preference: Don’t go /api/settings，Direct read and write localStorage。
  const sendMode = useChatSendMode();

  const apply = React.useCallback((s: Settings) => {
    setEfficiency(s.task_efficiency);
    setTrafficCapture(!!s.traffic_capture);
    setAgentTrafficBinding(!!s.agent_traffic_binding);
    setWebSearch(!!s.web_search_enabled);
    setBackend(s.web_search_backend || "ddgs");
    setBraveKeySet(!!s.brave_key_set);
    setTavilyKeySet(!!s.tavily_key_set);
    setProxyInput(s.web_search_proxy ?? "");
    setGlobalProxyInput(s.global_proxy ?? "");
    setPyInterp(s.python_interpreter ?? "");
    setWorkers(String(s.workers ?? 3));
    setInjectPlanner(s.constraints_inject_planner !== false);
    setInjectWorker(s.constraints_inject_worker !== false);
    setNoaCompaction(!!s.noa_compaction);
  }, []);

  const saveWorkers = () => {
    const n = Number(workers);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error("The concurrency number must be an integer greater than 0");
      return;
    }
    setSavingWorkers(true);
    api
      .setSettings({ workers: n })
      .then((s) => {
        apply(s);
        toast.success("The number of concurrent work agents has been saved (effective for tasks started later)");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSavingWorkers(false));
  };

  const savePython = () => {
    setSaving(true);
    api
      .setSettings({ python_interpreter: pyInterp.trim() })
      .then((s) => {
        apply(s);
        toast.success("Python interpreter configuration saved");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSaving(false));
  };
  const detectPython = () => {
    setSaving(true);
    api
      .detectPython()
      .then((r) => setPyInterp(r.python_interpreter))
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  const loadSettings = React.useCallback(() => {
    setLoaded(false);
    setLoadError(false);
    api.settings().then(apply).catch(() => setLoadError(true)).finally(() => setLoaded(true));
  }, [apply]);
  React.useEffect(loadSettings, [loadSettings]);

  const toggleTraffic = (v: boolean) => {
    setTrafficCapture(v); // optimistic
    setSaving(true);
    api
      .setSettings({ traffic_capture: v })
      .then(apply)
      .catch(() => setTrafficCapture(!v)) // revert on failure
      .finally(() => setSaving(false));
  };

  const toggleInjectPlanner = (v: boolean) => {
    setInjectPlanner(v); // optimistic
    api
      .setSettings({ constraints_inject_planner: v })
      .then(apply)
      .catch(() => setInjectPlanner(!v)); // revert on failure
  };

  const toggleAgentTrafficBinding = (v: boolean) => {
    setAgentTrafficBinding(v);
    setSaving(true);
    api
      .setSettings({ agent_traffic_binding: v })
      .then((s) => {
        apply(s);
        toast.success(v ? "Agent automatic binding traffic is enabled" : "Agent automatic binding traffic is turned off");
      })
      .catch((e) => {
        setAgentTrafficBinding(!v);
        toast.error(`Saving failed:${(e as Error).message}`);
      })
      .finally(() => setSaving(false));
  };

  const toggleInjectWorker = (v: boolean) => {
    setInjectWorker(v); // optimistic
    api
      .setSettings({ constraints_inject_worker: v })
      .then(apply)
      .catch(() => setInjectWorker(!v)); // revert on failure
  };

  const toggleNoaCompaction = (v: boolean) => {
    setNoaCompaction(v); // optimistic
    api
      .setSettings({ noa_compaction: v })
      .then((s) => {
        apply(s);
        toast.success(v ? "Context compression is enabled (takes effect next time)" : "Context compression turned off");
      })
      .catch((e) => {
        setNoaCompaction(!v); // revert on failure
        toast.error(`Saving failed:${(e as Error).message}`);
      });
  };

  // Persist a web-search patch (enable and/or backend). Optimistic with refetch.
  const saveWebSearch = (patch: Partial<Settings>) => {
    setSaving(true);
    api
      .setSettings(patch)
      .then((s) => {
        apply(s);
        toast.success("Network search configuration saved");
      })
      .catch((e) => {
        toast.error("Saving failed:" + (e as Error).message);
        api
          .settings()
          .then(apply)
          .catch(() => undefined);
      })
      .finally(() => setSaving(false));
  };

  const saveBraveKey = () => {
    setSavingKey(true);
    api
      .setSettings({ brave_search_api_key: braveKeyInput })
      .then((s) => {
        apply(s);
        setBraveKeyInput("");
        toast.success("Brave API Key saved");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSavingKey(false));
  };

  const saveTavilyKey = () => {
    setSavingTavilyKey(true);
    api
      .setSettings({ tavily_search_api_key: tavilyKeyInput })
      .then((s) => {
        apply(s);
        setTavilyKeyInput("");
        toast.success("Tavily API Key saved");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSavingTavilyKey(false));
  };

  const saveProxy = () => {
    setSavingProxy(true);
    api
      .setSettings({ web_search_proxy: proxyInput.trim() })
      .then((s) => {
        apply(s);
        toast.success(proxyInput.trim() ? "Export agent saved" : "Exit proxy cleared (changed to direct connection)");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSavingProxy(false));
  };

  const saveGlobalProxy = () => {
    setSavingGlobalProxy(true);
    api
      .setSettings({ global_proxy: globalProxyInput.trim() })
      .then((s) => {
        apply(s);
        toast.success(globalProxyInput.trim() ? "Global agent saved" : "Global proxy cleared (changed to direct connection)");
      })
      .catch((e) => toast.error("Saving failed:" + (e as Error).message))
      .finally(() => setSavingGlobalProxy(false));
  };

  // Run a real "test" search ("test") against the CURRENT form values (backend +
  // proxy + entered key), falling back to saved values server-side. Toasts result.
  const runTest = () => {
    setTesting(true);
    api
      .testWebSearch({
        web_search_backend: backend,
        web_search_proxy: proxyInput.trim(),
        brave_search_api_key: braveKeyInput,
        tavily_search_api_key: tavilyKeyInput,
      })
      .then((r) => {
        if (r.ok) toast.success(`Search test successful · ${r.backend} Return ${r.count} results`);
        else toast.error("Search test failed:" + (r.error || "Unknown error"));
      })
      .catch((e) => toast.error("Search test failed:" + (e as Error).message))
      .finally(() => setTesting(false));
  };

  // brave-free selected but no key stored and none being entered → tool stays off.
  const braveNeedsKey = webSearch && backend === "brave-free" && !braveKeySet;

  return (
    <SettingsPage title="System configuration">
      {loadError ? (
        <div className="settings-empty" role="alert">Configuration load failed.<Button variant="outline" size="sm" onClick={loadSettings}>Try again</Button></div>
      ) : !loaded ? (
        <div className="settings-empty" role="status">Loading configuration...</div>
      ) : (
        <>
          <EmailAlertSettings />
          <SettingsSection title="Run">
            <SettingsRow title="Work Concurrency" htmlFor="workers" >
              <Input id="workers" type="number" min={1} className="w-24" value={workers} disabled={savingWorkers} onChange={(e) => setWorkers(e.target.value)} />
              <Button size="sm" onClick={saveWorkers} disabled={savingWorkers}>Save</Button>
            </SettingsRow>
            <SettingsRow title="Context compression" htmlFor="noa-compaction" badge="Experiment"  help={{ topic: "settings", section: "Operations and Task Budgets" }}>
              <Switch id="noa-compaction" checked={noaCompaction} onCheckedChange={toggleNoaCompaction} />
            </SettingsRow>
            <SettingsRow title="Planning Constraints" htmlFor="inject-planner" >
              <Switch id="inject-planner" checked={injectPlanner} onCheckedChange={toggleInjectPlanner} />
            </SettingsRow>
            <SettingsRow title="Execution constraints" htmlFor="inject-worker" >
              <Switch id="inject-worker" checked={injectWorker} onCheckedChange={toggleInjectWorker} />
            </SettingsRow>
            <SettingsRow title="Python interpreter" htmlFor="python-interpreter" >
              <Input id="python-interpreter" placeholder="/usr/bin/python3" value={pyInterp} disabled={saving} onChange={(e) => setPyInterp(e.target.value)} />
              <Button variant="outline" size="sm" onClick={detectPython} disabled={saving}>Detection</Button>
              <Button size="sm" onClick={savePython} disabled={saving}>Save</Button>
            </SettingsRow>
            <SettingsRow title="Message sending method" htmlFor="chat-send-mode" >
              <Select value={sendMode} onValueChange={(v) => setChatSendMode(v as ChatSendMode)}>
                <SelectTrigger id="chat-send-mode"><SelectValue /></SelectTrigger>
                <SelectContent>{CHAT_SEND_MODE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingsRow>
          </SettingsSection>
          <TaskBudgetSettings value={efficiency} onSaved={setEfficiency}/>
          <NetworkSettingsSection/>
          <SettingsSection title="Traffic and Evidence">
            <SettingsRow title="Traffic Capture" htmlFor="traffic-capture"  help={{ topic: "traffic", section: "Enable capture" }}>
              <Switch id="traffic-capture" checked={trafficCapture} disabled={saving} onCheckedChange={toggleTraffic} />
            </SettingsRow>
            <SettingsRow title="Automatically associate traffic" htmlFor="agent-traffic-binding"  help={{ topic: "traffic", section: "Correlation vulnerability evidence" }}>
              <Switch id="agent-traffic-binding" checked={agentTrafficBinding} disabled={saving} onCheckedChange={toggleAgentTrafficBinding} />
            </SettingsRow>
          </SettingsSection>
          <SettingsSection title="Network">
            <SettingsRow title="Regular export agent" htmlFor="global-proxy"  help={{ topic: "settings", section: "Traffic and Proxy" }}>
              <Input id="global-proxy" autoComplete="off" placeholder="http://host:port" value={globalProxyInput} disabled={savingGlobalProxy} onChange={(e) => setGlobalProxyInput(e.target.value)} />
              <Button size="sm" onClick={saveGlobalProxy} disabled={savingGlobalProxy}>Save</Button>
            </SettingsRow>
            <SettingsRow title="Web search" htmlFor="web-search" >
              <Switch id="web-search" checked={webSearch} disabled={saving} onCheckedChange={(v) => { setWebSearch(v); saveWebSearch({ web_search_enabled: v }); }} />
            </SettingsRow>
            {webSearch && (
              <>
                <SettingsRow title="Search source" htmlFor="search-backend">
                  <Select value={backend} disabled={saving} onValueChange={(v) => { setBackend(v); saveWebSearch({ web_search_backend: v }); }}>
                    <SelectTrigger id="search-backend"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ddgs">DuckDuckGo</SelectItem>
                      <SelectItem value="brave-free">Brave</SelectItem>
                      <SelectItem value="tavily">Tavily</SelectItem>
                      <SelectItem value="deepseek">DeepSeek</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsRow>
                {backend === "deepseek" && null}
                {backend === "brave-free" && (
                  <SettingsRow title="Brave API Key" htmlFor="brave-key" description={braveNeedsKey ? "Not configured yet, the search tool is temporarily unavailable." : "Already configured, leave blank to remain unchanged."}>
                    <Input id="brave-key" type="password" autoComplete="off" placeholder={braveKeySet ? "Configured" : "Enter API Key"} value={braveKeyInput} disabled={savingKey} onChange={(e) => setBraveKeyInput(e.target.value)} />
                    <Button size="sm" onClick={saveBraveKey} disabled={savingKey || !braveKeyInput.trim()}>Save</Button>
                  </SettingsRow>
                )}
                {backend === "tavily" && (
                  <SettingsRow title="Tavily API Key" htmlFor="tavily-key" description={tavilyKeySet ? "Already configured, leave blank to remain unchanged." : "Not configured yet, the search tool is temporarily unavailable."}>
                    <Input id="tavily-key" type="password" autoComplete="off" placeholder={tavilyKeySet ? "Configured" : "tvly-…"} value={tavilyKeyInput} disabled={savingTavilyKey} onChange={(e) => setTavilyKeyInput(e.target.value)} />
                    <Button size="sm" onClick={saveTavilyKey} disabled={savingTavilyKey || !tavilyKeyInput.trim()}>Save</Button>
                  </SettingsRow>
                )}
                <SettingsRow title="Search Agent" htmlFor="ws-proxy" >
                  <Input id="ws-proxy" autoComplete="off" placeholder="http://host:portor socks5://host:port" value={proxyInput} disabled={savingProxy} onChange={(e) => setProxyInput(e.target.value)} />
                  <Button size="sm" onClick={saveProxy} disabled={savingProxy}>Save</Button>
                </SettingsRow>
                <SettingsRow title="Test search" >
                  <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>{testing ? "Testing..." : "Test search"}</Button>
                </SettingsRow>
              </>
            )}
          </SettingsSection>
          <UpdateCard />
        </>
      )}
    </SettingsPage>
  );
}
