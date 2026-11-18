import {
  Activity,
  Archive,
  BellRing,
  Bot,
  Binary,
  BookOpen,
  Boxes,
  BrainCircuit,
  Cable,
  ChartNoAxesCombined,
  ClipboardCheck,
  Compass,
  FileClock,
  Fingerprint,
  FolderKanban,
  Gauge,
  type LucideIcon,
  Network,
  Palette,
  UserRound,
  RadioTower,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";

export type NavBadge = "new" | "soon";
export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}
interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}
export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}
export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}
export type NavMainItem = NavMainLinkItem | NavMainParentItem;
export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const workbenchItems: NavGroup[] = [
  {
    id: 1,
    items: [
      { id: "dashboard", title: "Dashboard", url: "/dashboard", icon: Gauge },
      { id: "chat", title: "Chat", url: "/chat", icon: Compass },
      { id: "tasks", title: "Tasks", url: "/function/tasks", icon: FolderKanban },
      { id: "business-models", title: "Business Modeling", url: "/function/business-models", icon: Boxes },
      { id: "findings", title: "Findings", url: "/function/findings", icon: ShieldCheck },
      { id: "traffic", title: "Traffic", url: "/function/traffic", icon: RadioTower },
      { id: "commands", title: "Tool Calls", url: "/function/commands", icon: TerminalSquare },
      { id: "llm-records", title: "LLM Traces", url: "/function/llm-records", icon: Activity },
      { id: "assets", title: "Assets", url: "/function/assets", icon: Network },
      { id: "workspace", title: "Workspace", url: "/function/workspace", icon: Archive },
    ],
  },
];

export const settingsItems: NavGroup[] = [
  {
    id: 2,
    items: [
      { id: "appearance", title: "Appearance", url: "/system/appearance", icon: Palette },
      { id: "account", title: "Account", url: "/system/account", icon: UserRound },
    ],
  },
  {
    id: 3,
    items: [
      { id: "llm", title: "LLM", url: "/system/llm", icon: BrainCircuit },
      { id: "agents", title: "Agents", url: "/system/agents", icon: Bot },
      { id: "mcp", title: "MCP", url: "/system/mcp", icon: Cable },
      { id: "skills", title: "Skills", url: "/system/skills", icon: Sparkles },
      { id: "extensions", title: "Extensions", url: "/system/extensions", icon: Boxes },
      { id: "reverse", title: "Reverse Engineering", url: "/system/reverse", icon: Binary },
      { id: "tools", title: "Tool Configuration", url: "/system/tools", icon: Wrench },
      { id: "pocs", title: "PoC Knowledge Base", url: "/system/pocs", icon: BookOpen },
      { id: "fingerprints", title: "Fingerprints", url: "/system/fingerprints", icon: Fingerprint },
    ],
  },
  {
    id: 4,
    items: [
      { id: "notify", title: "Notifications", url: "/system/notify", icon: BellRing },
      { id: "intercept", title: "Interception Rules", url: "/system/intercept", icon: ChartNoAxesCombined },
      { id: "asset-intercept", title: "Asset Interception", url: "/system/intercept/assets", icon: ShieldCheck },
      { id: "approvals", title: "Approvals", url: "/system/intercept/approvals", icon: ClipboardCheck },
      { id: "logs", title: "Logs", url: "/system/logs", icon: FileClock },
      { id: "settings", title: "System Settings", url: "/system/settings", icon: Settings2 },
    ],
  },
];
