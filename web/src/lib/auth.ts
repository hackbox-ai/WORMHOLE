import {WORMHOLE_TOKEN_KEY as TOKEN_KEY} from "./browser-storage";
export const AUTH_CHANGED_EVENT="wormhole-auth-changed";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days (seconds）

export interface CurrentUser {
  id: string;
  name: string;
  username: string;
  email: string;
  avatar: string;
  role: string;
}

export const auth = {
  getToken(): string | null {
    if (typeof window === "undefined") return null;
    // Mock demo：No real login, return a false token Let the routing guard pass and enter the main interface directly.。
    return localStorage.getItem(TOKEN_KEY) ?? (process.env.NEXT_PUBLIC_MOCK === "1" ? "mock-demo" : null);
  },

  getRememberedUsername():string {
    if(typeof window==="undefined")return "WORMHOLE";
    try{return localStorage.getItem("wormhole_last_username")||"WORMHOLE";}catch{return "WORMHOLE";}
  },

  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    // Synchronous write cookie，Supply Next.js middleware Server read
    document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
    const username=this.getCurrentUser()?.username;
    if(username)try{localStorage.setItem("wormhole_last_username",username);}catch{}
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  },

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  },

  // From JWT payload of sub The field parses the current user. It is only used for display and does not perform signature verification.。
  getCurrentUser(): CurrentUser | null {
    const token = this.getToken();
    if (!token) return null;
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      // base64url → base64
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),c=>c.charCodeAt(0))));
      const rawUsername: string = payload.sub ?? "WORMHOLE";
      const username = rawUsername;
      return { id: "1", name: username, username, email: "", avatar: "", role: "operator" };
    } catch {
      return null;
    }
  },
};
