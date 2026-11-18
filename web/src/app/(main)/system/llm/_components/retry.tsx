"use client";
import { HelpButton } from "@/components/user-guide";

// LLM Shared retry configuration: The number of retries for each of the five tiers + Interval」。
//
// Five floors from inside to outside: Jianlian(SDK) → Empty response(SDK) → Same as provider Security window → Polling circuit breaker → Intention to rerun。
// The first three layers follow the endpoints, so each model configuration can override the global default; the last two layers are process-level and only have a global copy.。
//
// All inputs follow the same set of ”leave blank = ”Do not configure” semantics, with backend db.RetryRule Consistent：
//   times empty/0 = Use built-in default | -1 = Close this layer and try again | >0 = Use this number of times
//   Interval empty/0 = Use this layer’s original exponential backoff | >0 = Use this fixed millisecond interval instead

import * as React from "react";

import { Loader2Icon, SaveIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import type { LLMRetryOverride, LLMRetryPolicy, LLMRetryRule } from "@/lib/types";

export const ZERO_RULE: LLMRetryRule = { attempts: 0, interval_ms: 0 };
export const ZERO_OVERRIDE: LLMRetryOverride = {
  connect: ZERO_RULE,
  empty: ZERO_RULE,
  stream: ZERO_RULE,
};
const ZERO_POLICY: LLMRetryPolicy = {
  ...ZERO_OVERRIDE,
  breaker: ZERO_RULE,
  intent: ZERO_RULE,
};

type LayerMeta = { title: string; attemptsLabel: string; defAttempts: number };
export const RETRY_LAYERS = {
  connect: { title: "Retry establishing connection", attemptsLabel: "Number of retries", defAttempts: 3 },
  empty: { title: "Empty response retry", attemptsLabel: "Number of retries", defAttempts: 2 },
  stream: { title: "Streaming safe window retry", attemptsLabel: "Number of retries", defAttempts: 2 },
  breaker: { title: "Polling circuit breaker", attemptsLabel: "Continuous Failure Threshold", defAttempts: 3 },
  intent: { title: "Intention to rerun", attemptsLabel: "Number of reruns", defAttempts: 2 },
} satisfies Record<string, LayerMeta>;

type LayerKey = keyof typeof RETRY_LAYERS;

/** Millisecond human words are only used to echo next to the input box to avoid counting zeros。 */
function humanMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(2))}s`;
  return `${Number((ms / 60_000).toFixed(2))}min`;
}

/** Controlled digital input: empty string ↔ 0，Intermediate state（"-"、"1e"）Leave it local as is without disturbing the parent。 */
function NumField({
  id,
  value,
  onChange,
  placeholder,
  min,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  placeholder: string;
  min: number;
}) {
  const [text, setText] = React.useState(value === 0 ? "" : String(value));
  // Keep up when the parent changes a complete set of values (read policies, switch configurations); you will not get here when typing by yourself，
  // Because at that time value Already equal to local text parse The result after。
  React.useEffect(() => {
    const incoming = value === 0 ? "" : String(value);
    setText((cur) => (Number(cur || 0) === value ? cur : incoming));
  }, [value]);
  return (
    <Input
      id={id}
      type="number"
      min={min}
      className="w-28 shrink-0"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onChange(e.target.value.trim() === "" || !Number.isFinite(n) ? 0 : Math.trunc(n));
      }}
    />
  );
}

/** Two knobs for one level retry。idPrefix Used to save when the same page appears multiple times label of htmlFor。 */
export function RetryRuleFields({
  layer,
  idPrefix,
  value,
  onChange,
  compact,
}: {
  layer: LayerKey;
  idPrefix: string;
  value: LLMRetryRule;
  onChange: (r: LLMRetryRule) => void;
  /** true = Compact version of the configuration drawer: omit the expansion description, leaving only the sentence ”What error will reach this level” */
  compact?: boolean;
}) {
  const meta = RETRY_LAYERS[layer];
  const human = humanMs(value.interval_ms);
  return (
    <div className={compact ? "settings-retry-row grid gap-2" : "settings-retry-row grid gap-3"}>
      <div className="grid gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <Label className="text-sm">{meta.title}</Label>
          <HelpButton compact topic="llm-retry" section={layer === "connect" ? "Retry establishing connection" : layer === "empty" ? "Empty response retry" : layer === "stream" ? "Streaming Security Window" : layer === "breaker" ? "Fusing and cooling" : "Intention to rerun"} label={meta.title + "Description"} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-n`} className="text-muted-foreground text-xs">
            {meta.attemptsLabel}
          </Label>
          <NumField
            id={`${idPrefix}-${layer}-n`}
            min={-1}
            value={value.attempts}
            placeholder={`Default ${meta.defAttempts}`}
            onChange={(n) => onChange({ ...value, attempts: n })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${layer}-ms`} className="text-muted-foreground text-xs">

            Interval ms
          </Label>
          <NumField
            id={`${idPrefix}-${layer}-ms`}
            min={0}
            value={value.interval_ms}
            placeholder="Default backoff"
            onChange={(n) => onChange({ ...value, interval_ms: n })}
          />
          {human && <span className="text-muted-foreground text-xs">{human}</span>}
        </div>
      </div>

    </div>
  );
}

/** The three layers of coverage in the model configuration drawer (the three layers that follow the endpoints）。 */
export function ProfileRetryFields({
  value,
  onChange,
}: {
  value: LLMRetryOverride;
  onChange: (o: LLMRetryOverride) => void;
}) {
  return (
    <div className="settings-editor-section grid gap-3">
      <div className="grid gap-0.5">
        <Label className="text-sm">Retry override</Label>

      </div>
      {(["connect", "empty", "stream"] as const).map((k) => (
        <div key={k} className="border-t pt-3 first:border-t-0 first:pt-0">
          <RetryRuleFields
            compact
            layer={k}
            idPrefix="pf"
            value={value[k]}
            onChange={(r) => onChange({ ...value, [k]: r })}
          />
        </div>
      ))}
    </div>
  );
}

/** 「Retry and Backoff」tab：Global default values for layer five。 */
export function RetryPolicyPanel() {
  const [policy, setPolicy] = React.useState<LLMRetryPolicy>(ZERO_POLICY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.llmRetryPolicy();
      setPolicy({ ...ZERO_POLICY, ...p });
    } catch (e) {
      toast.error(`Read retry policy failed:${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // The backend will clamp the out-of-bounds value back into the interval and return it, and directly refresh it with the returned value. What you see is what is stored.。
      const saved = await api.saveLLMRetryPolicy(policy);
      setPolicy({ ...ZERO_POLICY, ...saved });
      toast.success("Saved, effective immediately (the current round of calls still uses the old parameters)");
    } catch (e) {
      toast.error(`Saving failed:${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const set = (k: LayerKey) => (r: LLMRetryRule) => setPolicy((p) => ({ ...p, [k]: r }));

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-10 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />  Read retry policy…
      </div>
    );
  }

  return (
    <div className="grid gap-4">


      <div className="settings-retry-list">
        {(Object.keys(RETRY_LAYERS) as LayerKey[]).map((k) => (
          <RetryRuleFields key={k} layer={k} idPrefix="gl" value={policy[k]} onChange={set(k)} />
        ))}
      </div>

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}

          Save
        </Button>
        <Button variant="outline" onClick={() => setPolicy(ZERO_POLICY)} disabled={saving}>

          Restore all to default
        </Button>
      </div>
    </div>
  );
}
