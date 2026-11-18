"use client";
import "@/components/finding-alerts.css";
import * as React from "react";

import { useRouter } from "next/navigation";

import { ArrowUpRight, X } from "lucide-react";

import { api } from "@/lib/api";
import { auth } from "@/lib/auth";
import {
  type AlertState,
  emptyAlerts,
  type FindingNotice,
  loadAlerts,
  mergeAlerts,
  severityLabel,
  soundMatches,
} from "@/lib/finding-alerts";

type AlertContextValue = {
  state: AlertState;
  ready: boolean;
  soundReady: boolean;
  inboxOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  preferences: (p: Partial<Pick<AlertState, "page" | "sound" | "volume" | "minSound">>) => void;
  enableSound: (on: boolean) => Promise<void>;
  preview: () => Promise<void>;
  open: (item: FindingNotice) => void;
  markAll: () => void;
};
const AlertContext = React.createContext<AlertContextValue | null>(null);
export function useFindingAlerts() {
  const ctx = React.useContext(AlertContext);
  if (!ctx) throw new Error("Finding alerts provider is missing");
  return ctx;
}
export function FindingAlertProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter(),
    [state, setState] = React.useState<AlertState>(emptyAlerts),
    ref = React.useRef(state),
    [ready, setReady] = React.useState(false),
    [soundReady, setSoundReady] = React.useState(false),
    [inboxOpen, setInboxOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<{ latest: FindingNotice; count: number; until: number } | null>(null);
  const owner = React.useRef(""),
    key = React.useRef(""),
    audio = React.useRef<AudioContext | null>(null),
    memory = React.useRef<AlertState>(emptyAlerts);
  const storageUnavailable = React.useRef(false);
  const pollNow = React.useRef<() => void>(() => undefined);
  const takeLead = React.useCallback(() => {
    try {
      localStorage.setItem(`${key.current}:leader`, JSON.stringify({ owner: owner.current, until: Date.now() + 7000 }));
    } catch {
      /* This tab can continue when shared storage is unavailable. */
    }
    pollNow.current();
  }, []);
  const read = React.useCallback(() => {
    if (storageUnavailable.current) return memory.current;
    try {
      return loadAlerts(localStorage.getItem(key.current));
    } catch {
      storageUnavailable.current = true;
      return memory.current;
    }
  }, []);
  const write = React.useCallback((next: AlertState) => {
    memory.current = next;
    ref.current = next;
    setState(next);
    try {
      localStorage.setItem(key.current, JSON.stringify(next));
    } catch {
      storageUnavailable.current = true;
    }
  }, []);
  const unlock = React.useCallback(async () => {
    try {
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
      const ok = audio.current.state === "running";
      setSoundReady(ok);
      return ok;
    } catch {
      setSoundReady(false);
      return false;
    }
  }, []);
  const ring = React.useCallback(async () => {
    if (!(await unlock())) return;
    const context = audio.current;
    if (context?.state !== "running") return;
    const now = context.currentTime,
      volume = ref.current.volume;
    if (volume <= 0) return;
    for (const [offset, freq] of [
      [0, 880],
      [0.13, 1174.66],
    ] as const) {
      const osc = context.createOscillator(),
        gain = context.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(volume * 0.18, now + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.23);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }, [unlock]);
  const preferences = React.useCallback(
    (patch: Partial<AlertState>) => {
      write({ ...read(), ...patch });
      if (patch.page === false) setNotice(null);
    },
    [read, write],
  );
  const enableSound = React.useCallback(
    async (on: boolean) => {
      preferences({ sound: on });
      if (on) {
        await ring();
        takeLead();
      }
    },
    [preferences, ring, takeLead],
  );
  const notify = React.useCallback(
    (fresh: FindingNotice[], leader: boolean) => {
      const current = ref.current;
      const latest = fresh.at(-1);
      if (!latest) return;
      if (current.page)
        setNotice((old) => ({
          latest,
          count: old && old.until > Date.now() ? old.count + fresh.length : fresh.length,
          until: Date.now() + 7500,
        }));
      if (leader && current.sound && soundMatches(fresh, current.minSound)) {
        let last = 0;
        try {
          last = Number(localStorage.getItem(`${key.current}:ring`)) || 0;
        } catch {
          /* Keep notifications available without persistent cooldown. */
        }
        if (Date.now() - last >= 8000) {
          try {
            localStorage.setItem(`${key.current}:ring`, String(Date.now()));
          } catch {
            /* Sound still works for this tab. */
          }
          void ring();
        }
      }
    },
    [ring],
  );
  React.useEffect(() => {
    key.current = `wormhole.finding-alerts.v1:${encodeURIComponent(auth.getCurrentUser()?.username ?? "operator")}`;
    owner.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const initial = read();
    memory.current = initial;
    ref.current = initial;
    setState(initial);
    setReady(!!initial.cursor);
    let disposed = false,
      busy = false;
    const controller = new AbortController();
    const leaseKey = `${key.current}:leader`;
    const leader = () => {
      try {
        const value = JSON.parse(localStorage.getItem(leaseKey) ?? "null");
        return value?.owner === owner.current && value.until > Date.now();
      } catch {
        return true;
      }
    };
    const acquire = async () => {
      try {
        const lease = JSON.parse(localStorage.getItem(leaseKey) ?? "null");
        if (lease && lease.owner !== owner.current && lease.until > Date.now()) return false;
        localStorage.setItem(leaseKey, JSON.stringify({ owner: owner.current, until: Date.now() + 7000 }));
        await new Promise((r) => setTimeout(r, 25));
        return leader();
      } catch {
        return true;
      }
    };
    const poll = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        if (!(await acquire()) || disposed) return;
        for (let page = 0; page < 5 && !disposed && leader(); page++) {
          const latest = read(),
            body = await api.findingAlerts(latest.cursor, controller.signal);
          if (disposed || !leader()) break;
          const live = read(),
            merged = mergeAlerts(live, body.items, body.cursor);
          write(merged.state);
          setReady(true);
          notify(merged.fresh, true);
          if (!body.more) break;
        }
      } catch {
        if (!controller.signal.aborted) setReady(false);
      } finally {
        busy = false;
      }
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== key.current) return;
      const next = read(),
        before = new Set(ref.current.items.map((i) => i.finding_id));
      ref.current = next;
      memory.current = next;
      setState(next);
      setReady(!!next.cursor);
      notify(next.items.filter((i) => !before.has(i.finding_id)).reverse(), false);
    };
    pollNow.current = () => void poll();
    const activate = () => {
      if (ref.current.sound && audio.current?.state !== "running")
        void unlock().then((ok) => {
          if (ok && !disposed) takeLead();
        });
    };
    window.addEventListener("storage", changed);
    window.addEventListener("pointerdown", activate);
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("storage", changed);
      window.removeEventListener("pointerdown", activate);
      try {
        if (leader()) localStorage.removeItem(leaseKey);
      } catch {
        /* Expiration releases the lease if cleanup cannot persist it. */
      }
      void audio.current?.close().catch(() => undefined);
      audio.current = null;
    };
  }, [notify, read, write, unlock, takeLead]);
  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), Math.max(0, notice.until - Date.now()));
    return () => clearTimeout(t);
  }, [notice]);
  const open = React.useCallback(
    (item: FindingNotice) => {
      const s = read();
      write({ ...s, items: s.items.map((i) => (i.finding_id === item.finding_id ? { ...i, read: true } : i)) });
      setNotice(null);
      setInboxOpen(false);
      router.push(`/function/findings/detail/?id=${encodeURIComponent(item.finding_id)}`);
    },
    [read, write, router],
  );
  const markAll = React.useCallback(() => {
    const s = read();
    write({ ...s, items: s.items.map((i) => ({ ...i, read: true })) });
    setNotice(null);
  }, [read, write]);
  const context = {
    state,
    ready,
    soundReady,
    inboxOpen,
    setInboxOpen,
    preferences,
    enableSound,
    preview: ring,
    open,
    markAll,
  };
  return (
    <AlertContext.Provider value={context}>
      {children}
      {notice && (
        <div className="finding-alert-toast" role="status" aria-live="polite" data-count={notice.count}>
          <div className="flex items-center gap-2">
            <span className="finding-alert-dot" data-severity={notice.latest.severity} />
            <span className="font-medium text-[11px] text-muted-foreground">
              {notice.count > 1
                ? `New ${notice.count} Vulnerability`
                : `New${severityLabel[notice.latest.severity] ?? ""}Finding`}
            </span>
            <button
              type="button"
              aria-label="Turn off discovery reminders"
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setNotice(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <p className="mt-1 truncate font-medium text-[13px] leading-5" title={notice.latest.name}>
            {notice.latest.name || "Unnamed discovery"}
          </p>
          <div className="mt-1 flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={notice.latest.task_name}>

              Task #{notice.latest.task_id} · {notice.latest.task_name}
            </span>
            <button
              type="button"
              className="flex shrink-0 items-center gap-0.5 font-medium text-[11px] text-primary hover:underline"
              onClick={() => (notice.count > 1 ? setInboxOpen(true) : open(notice.latest))}
            >
              {notice.count > 1 ? "View reminder" : "View"}
              <ArrowUpRight className="size-3" />
            </button>
          </div>
        </div>
      )}
    </AlertContext.Provider>
  );
}
