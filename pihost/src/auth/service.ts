/**
 * Authentication：
 * - JWT key：Printable characters in the file（≥32），Generate if insufficient 43 bit base64url（ASCII，UTF-8 Round trip lossless），0600。
 * - signJWT：HS256，sub=Current administrator username，iat=now，exp=now+7d；verify Verify signature and validity period。
 * - token Extraction order：Authorization: Bearer → cookie `wormhole_token` → ?token=（SSE Use）。
 * - POST /api/auth/change-password {old_password,new_password}：Required token + Current password。
 * Difference（ADR）：Password Hash scrypt instead bcrypt（Internal implementation，API Behavioral Equivalence）。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const PASS_KEY = "auth.admin_pass_hash";
const USER_KEY = "auth.admin_username";
function normalizeUsername(value:string){return value.trim().normalize("NFC");}
function validUsername(value:string){return /^[\p{L}\p{N}_.@-]{2,48}$/u.test(value);}
export const WORMHOLE_USERNAME = "WORMHOLE";
export const TOKEN_TTL_SECONDS = 7 * 24 * 3600;
const MIN_PASSWORD_LEN = 8;

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(pw, salt, 32).toString("hex");
  return timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
}

export class AuthService {
  private jwtKey: Buffer | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly keyPath: string,
  ) {}

  /** Control loadJWTKey：Read file（trim After ≥32 Printable characters); otherwise generate and write to disk（0600）。 */
  private async key(): Promise<Buffer> {
    if (this.jwtKey) return this.jwtKey;
    let stored = "";
    try {
      stored = (await readFile(this.keyPath, "utf8")).trim();
    } catch {
      // does not exist → Generate
    }
    if (stored.length >= 32) {
      this.jwtKey = Buffer.from(stored, "utf8");
      return this.jwtKey;
    }
    const generated = randomBytes(32).toString("base64url"); // 43 bit ASCII，Round trip lossless
    await writeFile(this.keyPath, generated, { mode: 0o600 });
    this.jwtKey = Buffer.from(generated, "utf8");
    return this.jwtKey;
  }

  async username():Promise<string>{
    const r=await this.pool.query("SELECT value FROM app_settings WHERE key=$1",[USER_KEY]);
    return String(r.rows[0]?.value??"").trim()||WORMHOLE_USERNAME;
  }

  async initialized(): Promise<boolean> {
    const r = await this.pool.query("SELECT value FROM app_settings WHERE key=$1", [PASS_KEY]);
    return (r.rowCount ?? 0) > 0 && String(r.rows[0]?.value ?? "") !== "";
  }

  async init(password: string,username:string=WORMHOLE_USERNAME): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
    username=normalizeUsername(username);
    if(!validUsername(username))return {ok:false,status:400,error:"The username needs to be 2-48 characters, and can be Chinese, letters, numbers and . _ @ -"};
    if (password.length < MIN_PASSWORD_LEN) {
      return { ok: false, status: 400, error: `Password is at least ${MIN_PASSWORD_LEN} bit` };
    }
    const r = await this.pool.query(
      `WITH first_password AS (
        INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING RETURNING key
       ), account AS (
        INSERT INTO app_settings(key,value) SELECT $3,$4 FROM first_password
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING key
       ) SELECT key FROM first_password`,
      [PASS_KEY, hashPassword(password),USER_KEY,username],
    );
    if ((r.rowCount ?? 0) === 0) return { ok: false, status: 403, error: "Password has been set" };
    return { ok: true, token: await this.signToken() };
  }

  async login(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
    username=normalizeUsername(username);
    const current=await this.username();
    if(username!==current)return {ok:false,status:401,error:"Wrong username or password"};
    const r = await this.pool.query("SELECT value FROM app_settings WHERE key=$1", [PASS_KEY]);
    const stored = String(r.rows[0]?.value ?? "");
    if (!stored) return { ok: false, status: 403, error: "The password is not initialized, please set the password first" };
    if (!verifyPassword(password, stored)) return { ok: false, status: 401, error: "Wrong username or password" };
    return { ok: true, token: await this.signToken() };
  }

  async changeUsername(username:string,password:string):Promise<{ok:true;username:string;token:string}|{ok:false;status:number;error:string}>{
    username=normalizeUsername(username);
    if(!validUsername(username))return {ok:false,status:400,error:"The username needs to be 2-48 characters, and can be Chinese, letters, numbers and . _ @ -"};
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("SELECT value FROM app_settings WHERE key=$1 FOR UPDATE",[PASS_KEY]);
      const stored=String(r.rows[0]?.value??"");
      if(!stored){await c.query("ROLLBACK");return {ok:false,status:403,error:"Account has not been initialized yet"};}
      if(!verifyPassword(password,stored)){await c.query("ROLLBACK");return {ok:false,status:400,error:"Current password is wrong"};}
      await c.query("INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[USER_KEY,username]);
      await c.query("COMMIT");
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
    return {ok:true,username,token:await this.signToken(TOKEN_TTL_SECONDS,username)};
  }

  /** Control authChangePassword：Required token（Enter after verification by routing layer）+ The current password is correct */
  async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
    if (newPassword === "") return { ok: false, status: 400, error: "New password cannot be empty" };
    if (newPassword.length < MIN_PASSWORD_LEN) {
      return { ok: false, status: 400, error: `Password is at least ${MIN_PASSWORD_LEN} bit` };
    }
    const r = await this.pool.query("SELECT value FROM app_settings WHERE key=$1", [PASS_KEY]);
    const stored = String(r.rows[0]?.value ?? "");
    if (!stored) return { ok: false, status: 403, error: "The password is not initialized, please set the password first" };
    if (!verifyPassword(oldPassword, stored)) return { ok: false, status: 401, error: "Current password is wrong" };
    await this.pool.query(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
      [PASS_KEY, hashPassword(newPassword)],
    );
    return { ok: true, token: await this.signToken() };
  }

  private async signToken(ttlSeconds: number = TOKEN_TTL_SECONDS,subject?:string): Promise<string> {
    const key = await this.key();
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: subject??await this.username(), iat: now, exp: now + ttlSeconds })).toString("base64url");
    const sig = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
  }

  /** true=Valid and not expired (cf. verifyJWT） */
  async verifyToken(token: string): Promise<boolean> {
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return false;
    const expect = createHmac("sha256", await this.key()).update(`${header}.${payload}`).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
      return typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  /** Test hook: Issue expired token（Negative ttl） */
  async signTokenForTest(ttlSeconds: number): Promise<string> {
    return this.signToken(ttlSeconds);
  }
}

/** Control extractToken：Bearer Head → wormhole_token cookie → ?token= */
export function extractToken(headers: { authorization?: string; cookie?: string }, queryToken: string | null): string {
  const h = headers.authorization ?? "";
  if (h.startsWith("Bearer ")) return h.slice("Bearer ".length);
  const cookies = Object.fromEntries(
    (headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return i === -1 ? [c, ""] : [c.slice(0, i), c.slice(i + 1)];
      }),
  );
  if (cookies["wormhole_token"]) return cookies["wormhole_token"];
  return queryToken ?? "";
}

export function authKeyPath(dataDir: string): string {
  return path.join(dataDir, "jwt.key");
}
