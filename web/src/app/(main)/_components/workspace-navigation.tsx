"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

const WORKBENCH_KEY = "wormhole.navigation.workbench";
const SETTINGS_KEY = "wormhole.navigation.settings";

function validRoute(value: string | null, settings: boolean): value is string {
  if (!value?.startsWith("/") || value.startsWith("//")) return false;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    return settings
      ? url.pathname.startsWith("/system/")
      : /^\/(?:chat|dashboard|function\/[^/]+)(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function remember(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Storage may be unavailable. */
  }
}

function restore(key: string, settings: boolean, fallback: string) {
  try {
    const value = sessionStorage.getItem(key);
    if (validRoute(value, settings)) return value;
  } catch {
    /* The in-memory fallback still allows navigation. */
  }
  return fallback;
}

type Navigation = {
  inSettings: boolean;
  openSettings: () => void;
  returnToWorkbench: () => void;
};
const NavigationContext = createContext<Navigation | null>(null);

export function WorkspaceNavigationProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const inSettings = pathname.startsWith("/system/");
  const lastWorkbench = useRef("/chat/");
  const lastSettings = useRef("/system/appearance/");

  useEffect(() => {
    if (pathname.startsWith("/help")) return;
    const href = pathname + window.location.search + window.location.hash;
    if (inSettings) {
      lastSettings.current = href;
      remember(SETTINGS_KEY, href);
    } else {
      lastWorkbench.current = href;
      remember(WORKBENCH_KEY, href);
    }
  }, [pathname, inSettings]);

  function openSettings() {
    if (inSettings) return;
    // Chat selection uses replaceState without changing pathname. Read the URL
    // at click time to preserve the selected conversation and task tab.
    const href = window.location.pathname + window.location.search + window.location.hash;
    lastWorkbench.current = href;
    remember(WORKBENCH_KEY, href);
    router.push(restore(SETTINGS_KEY, true, lastSettings.current));
  }

  function returnToWorkbench() {
    const href = window.location.pathname + window.location.search + window.location.hash;
    lastSettings.current = href;
    remember(SETTINGS_KEY, href);
    router.push(restore(WORKBENCH_KEY, false, lastWorkbench.current));
  }

  return (
    <NavigationContext.Provider value={{ inSettings, openSettings, returnToWorkbench }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useWorkspaceNavigation() {
  const context = useContext(NavigationContext);
  if (!context) throw new Error("Workspace navigation requires its provider.");
  return context;
}
