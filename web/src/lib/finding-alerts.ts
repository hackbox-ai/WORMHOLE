export interface FindingNotice {
  id: string;
  finding_id: string;
  task_id: string;
  name: string;
  severity: string;
  task_name: string;
  created_at: string;
  read?: boolean;
}
export interface AlertState {
  cursor?: string;
  items: FindingNotice[];
  seen: string[];
  page: boolean;
  sound: boolean;
  volume: number;
  minSound: string;
}
export const emptyAlerts: AlertState = { items: [], seen: [], page: true, sound: false, volume: 0.35, minSound: "all" };
export const severityRank: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const severityLabel: Record<string, string> = {
  info: "Information",
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Serious",
};
export function loadAlerts(raw: string | null): AlertState {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return { ...emptyAlerts };
    const items = Array.isArray(v.items)
      ? v.items
          .filter(
            (x: FindingNotice) =>
              x && typeof x.finding_id === "string" && typeof x.name === "string" && typeof x.task_id === "string",
          )
          .slice(0, 100)
      : [];
    return {
      cursor: typeof v.cursor === "string" ? v.cursor : undefined,
      items,
      seen: Array.isArray(v.seen)
        ? v.seen.filter((id: unknown) => typeof id === "string").slice(-2000)
        : items.map((i: FindingNotice) => i.finding_id),
      page: v.page !== false,
      sound: v.sound === true,
      volume: typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.max(0, Math.min(1, v.volume)) : 0.35,
      minSound: ["all", "medium", "high", "critical"].includes(v.minSound) ? v.minSound : "all",
    };
  } catch {
    return { ...emptyAlerts };
  }
}
export function mergeAlerts(state: AlertState, items: FindingNotice[], cursor: string) {
  const seen = new Set([...state.seen, ...state.items.map((i) => i.finding_id)]),
    fresh: FindingNotice[] = [];
  for (const item of items) {
    if (!seen.has(item.finding_id)) {
      seen.add(item.finding_id);
      fresh.push({ ...item, read: false });
    }
  }
  return {
    fresh,
    state: {
      ...state,
      cursor,
      items: [...fresh.slice().reverse(), ...state.items].slice(0, 100),
      seen: [...seen].slice(-2000),
    },
  };
}
export function soundMatches(items: FindingNotice[], min: string) {
  return items.some((i) => (severityRank[i.severity] ?? 0) >= (min === "all" ? 0 : (severityRank[min] ?? 0)));
}
