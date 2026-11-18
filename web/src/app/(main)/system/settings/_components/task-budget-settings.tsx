"use client";

import * as React from "react";
import {toast} from "sonner";
import {SettingsRow, SettingsSection} from "@/components/settings-layout";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {api} from "@/lib/api";
import type {TaskEfficiencySettings} from "@/lib/types";

const fields = [
  ["maxActiveSeconds", "Task running time", "minutes", 60],
  ["maxModelCalls", "Number of model calls", "times", 1],
  ["maxTotalTokens", "Total Tokens", "Token", 1],
  ["maxOutputTokens", "Output Token", "Token", 1],
  ["plannerRunSeconds", "Single planning duration", "minutes", 60],
  ["plannerMaxTurns", "Number of single planning rounds", "Wheel", 1],
  ["reviewSeconds", "Progress check interval", "minutes", 60],
  ["idleSeconds", "No progress waiting time", "minutes", 60],
  ["emptyRounds", "Number of consecutive rounds with no progress", "Wheel", 1],
] as const;

export function TaskBudgetSettings({value, onSaved}: {value?: TaskEfficiencySettings; onSaved: (value: TaskEfficiencySettings) => void}) {
  const [inputs, setInputs] = React.useState<Record<string, string>>({});
  const [enabled, setEnabled] = React.useState(true);
  const [batchTimeout,setBatchTimeout]=React.useState("30");
  React.useEffect(()=>{api.settings().then(v=>setBatchTimeout(String((v.batch_task_timeout_seconds??1800)/60))).catch(()=>{});},[]);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (!value) return;
    setEnabled(value.enabled);
    setInputs(Object.fromEntries(fields.map(([key,,, scale]) => [key, String(value[key] / scale)])));
  }, [value]);
  if (!value) return null;
  const save = async () => {
    const next = {...value, enabled};
    for (const [key, title,, scale] of fields) {
      const raw = inputs[key] ?? "", n = Number(raw) * scale;
      if (!raw.trim() || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n)) || Math.abs(n - Math.round(n)) > 0.000001) {
        toast.error(`${title}Please enter a non-negative number. The time is accurate to seconds. Use integers for times and tokens.`); return;
      }
      next[key] = Math.round(n);
    }
    const batchSeconds=Number(batchTimeout)*60;
    if(!Number.isSafeInteger(batchSeconds)||batchSeconds<60||batchSeconds>86400){toast.error("The default timeout for batch tasks is 1–1440 minutes, accurate to the second");return;}
    setSaving(true);
    try {
      const result = await api.setSettings({task_efficiency: next,batch_task_timeout_seconds:batchSeconds});
      if (result.task_efficiency) onSaved(result.task_efficiency);
      toast.success("Saved. Task budgets take effect on the next check, and planning limits take effect on the next run.");
    } catch (e) { toast.error("Saving failed:" + (e as Error).message); }
    finally { setSaving(false); }
  };
  return <SettingsSection title="Task Budget and Progress">

    <SettingsRow title="Batch task default timeout" htmlFor="batch-default-timeout" ><Input id="batch-default-timeout" type="number" min={1} max={1440} step="any" className="w-36" value={batchTimeout} disabled={saving} onChange={e=>setBatchTimeout(e.target.value)}/><span className="text-muted-foreground text-sm">minutes</span></SettingsRow>
    {fields.map(([key, title, unit]) => <SettingsRow key={key} title={title} htmlFor={`budget-${key}`} description={
      key === "maxActiveSeconds" ? "Accumulated active time, excluding waiting for approval." :
      key === "maxTotalTokens" ? "Total input, output and cache Token; measured by completed calls." :
      key === "plannerRunSeconds" || key === "plannerMaxTurns" ? "Only a single planning is limited, and the total number of task rounds is not limited." :
      key === "reviewSeconds" ? "Save progress checkpoints and continue execution; they will not be paused just for reaching the point." :
      key === "idleSeconds" || key === "emptyRounds" ? "When there is no work to be executed, the check will be paused only if both items are met at the same time; 0 turns off the check." : undefined}>
      <Input id={`budget-${key}`} type="number" min={0} step={unit === "minutes" ? "any" : 1} className="w-36" value={inputs[key] ?? ""} disabled={saving} onChange={e => setInputs(v => ({...v, [key]: e.target.value}))}/>
      <span className="text-muted-foreground text-sm">{unit}</span>
    </SettingsRow>)}
    <SettingsRow title="Automatic stagnation protection" htmlFor="budget-enabled" >
      <Switch id="budget-enabled" checked={enabled} disabled={saving} onCheckedChange={setEnabled}/>
    </SettingsRow>
    <SettingsRow title="Save budget" >
      <Button size="sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
    </SettingsRow>
  </SettingsSection>;
}
