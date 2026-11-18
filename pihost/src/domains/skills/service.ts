import {skillAvailable} from '../extensions/availability.ts';
/**
 * F14 Skill File Management、ZIP Installation, call statistics and missing list。
 * Directory name=Skill Name；SKILL.md frontmatter（name/description）is the source of meta information；
 * Path safety: All file operations deny traversal and absolute paths。ZIP Unpacking rejected `..` with absolute path members。
 */
import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {goTrim} from "../assets/asset-match.ts";
import type { Pool } from "pg";
import { appendEvent } from "../../events/ledger.ts";
import {parse as parseYaml,stringify as stringifyYaml} from 'yaml';

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_KEY_RE = /^[a-z][a-z0-9_-]*$/i;
export function validSourceSkillName(name:string):boolean{
 const chars=Array.from(name),letter=(c:string)=>/^[a-z]$/.test(c)||c.codePointAt(0)!>127&&/^\p{L}$/u.test(c);
 return chars.length>0&&chars.length<=64&&letter(chars[0]!)&&!name.endsWith('-')&&!name.includes('--')&&chars.every(c=>letter(c)||/^[0-9-]$/.test(c)||c.codePointAt(0)!>127&&/^\p{Nd}$/u.test(c));
}
export function sourceSkillRelPath(raw:string):string{
 if(!raw||Buffer.byteLength(raw)>512)throw new Error("Illegal path: invalid path: empty or too long");
 for(const c of raw)if(/[\\%#?*:"<>|]/.test(c)||c.codePointAt(0)!<32||c==='\u007f'||c==='\ufffd'||/[\p{Cf}\p{Co}\p{Cs}]/u.test(c)||(c!==' '&&goTrim(c)==='')){
  const point=c.codePointAt(0)!,escapes:Record<number,string>={7:'\\a',8:'\\b',9:'\\t',10:'\\n',11:'\\v',12:'\\f',13:'\\r'};
  const escaped=escapes[point]??(c==='\\'?'\\\\':c==="'"?"\\'":point<32||point===127?'\\x'+point.toString(16).padStart(2,'0'):/[\p{Cf}\p{Co}\p{Cs}]/u.test(c)||(c!==' '&&goTrim(c)==='')?'\\'+(point<=65535?'u'+point.toString(16).padStart(4,'0'):'U'+point.toString(16).padStart(8,'0')):c);
  const rune="'"+escaped+"'";
  throw new Error("invalid path: illegal character "+rune);
 }
 if(raw.includes('..'))throw new Error("invalid path: invalid path: '..' not allowed");
 if(raw.startsWith('/')||raw.includes('//'))throw new Error("invalid path: invalid path: must be relative with no empty segments");
 const clean=path.posix.normalize(raw).replace(/\/$/,'');if(clean==='.'||path.posix.isAbsolute(clean)||clean.startsWith('..'))throw new Error("Illegal path: invalid path");return clean;
}

export interface SkillMetadata {name?:string;description?:string;mcps?:string[];[key:string]:unknown}
function parseFrontmatter(text: string): SkillMetadata {
  const m = FRONT_RE.exec(text);
  if (!m) return {};
  const value=parseYaml(m[1]!);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}

function buildFrontmatter(name: string, description: string): string {
  return `---\n${stringifyYaml({name,description})}---\n\n`;
}

/** Path safety: must still be present after parsing base Inside */
function safeJoin(base: string, rel: string): string {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) throw new Error("Illegal path");
  return resolved;
}

export class SkillsService {
  constructor(
    private readonly pool: Pool,
    private readonly dlqPath: string,
    private readonly root: string,
  ) {}

  private skillDir(name: string): string {
    if (!SKILL_KEY_RE.test(name)&&!validSourceSkillName(name)) throw new Error("Illegal Skill name");
    return safeJoin(this.root, name);
  }

  async list(): Promise<Record<string, unknown>[]> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let meta: SkillMetadata = {};
      try {
        meta = parseFrontmatter(await readFile(path.join(this.root, e.name, "SKILL.md"), "utf8"));
      } catch {
        /* None SKILL.md：Missing */
      }
      const usage = await this.pool.query("SELECT count(*)::int AS n FROM skill_usage WHERE skill=$1", [e.name]);
      out.push({
        name: e.name,
        display_name: meta.name ?? e.name,
        description: meta.description ?? "",
        ...(meta.license?{license:meta.license}:{}),
        ...(meta.compatibility?{compatibility:meta.compatibility}:{}),
        ...(Array.isArray(meta.mcps)&&meta.mcps.length?{mcps:meta.mcps}:{}),
        missing: !meta.name,
        uses: (usage.rows[0] as { n: number }).n,
      });
    }
    return out;
  }

  async missing(): Promise<string[]> {
    const vis = await this.pool.query("SELECT DISTINCT resource_id FROM agent_visibility WHERE resource_kind='skill'");
    const onDisk = new Set((await this.list()).map((s) => s.name));
    return (vis.rows as { resource_id: string }[]).map((r) => r.resource_id).filter((n) => !onDisk.has(n));
  }

  async create(name: string, description: string): Promise<{ ok: boolean; status: number; error?: string }> {
    if (!SKILL_KEY_RE.test(name)) return { ok: false, status: 400, error: "Illegal Skill name" };
    const dir = this.skillDir(name);
    try {
      await stat(dir);
      return { ok: false, status: 400, error: "Skill already exists" };
    } catch {
      /* does not exist → Create */
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), buildFrontmatter(name, description));
    await this.audit("skill_created", { name });
    return { ok: true, status: 200 };
  }

  async createForAgent(name:string,description:string,instructions:string):Promise<string>{
    if(!validSourceSkillName(name))throw new Error("The skill name is illegal (begins with a lowercase letter, only letters/numbers/hyphens, ≤64)");
    if(!goTrim(description))throw new Error("description required");
    const dir=safeJoin(this.root,name);try{await stat(dir);throw new Error("Skill already exists: "+name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await mkdir(dir,{recursive:true});
    const text=`---\nname: ${name}\ndescription: ${description}\n---\n`+(goTrim(instructions)?instructions:`## ${name}\n\n1. \n2. \n3. \n`);
    try{await writeFile(path.join(dir,'SKILL.md'),text,{mode:0o644});}catch(error){await rm(dir,{recursive:true,force:true});throw error;}
    return 'skill created: '+name;
  }
  async writeForAgent(name:string,file:string,content:string):Promise<string>{
    if(!validSourceSkillName(name))throw new Error("The skill name is illegal");
    const dir=safeJoin(this.root,name);try{await stat(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error("skill does not exist: "+name);throw error;}
    const clean=sourceSkillRelPath(goTrim(file)||'SKILL.md'),full=safeJoin(dir,clean);await mkdir(path.dirname(full),{recursive:true});await writeFile(full,content,{mode:0o644});return 'skill file written: '+name+'/'+clean;
  }

  async updateMeta(name: string, meta: { name?: string; description?: string }): Promise<{ ok: boolean; status: number; error?: string }> {
    const dir = this.skillDir(name);
    const file = path.join(dir, "SKILL.md");
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      return { ok: false, status: 404, error: "Skill does not exist" };
    }
    const cur = parseFrontmatter(text);
    const body = text.replace(FRONT_RE, "");
    await writeFile(file, `---\n${stringifyYaml({...cur,name:meta.name??cur.name??name,description:meta.description??cur.description??''})}---\n${body}`);
    await this.audit("skill_meta_updated", { name });
    return { ok: true, status: 200 };
  }

  async remove(name: string): Promise<boolean> {
    try {
      await rm(this.skillDir(name), { recursive: true, force: true });
      await this.audit("skill_deleted", { name });
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(name: string): Promise<Record<string, unknown>[] | null> {
    const dir = this.skillDir(name);
    const out: Record<string, unknown>[] = [];
    const walk = async (rel: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(safeJoin(this.root, path.join(name, rel)), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p);
        else out.push({ path: p });
      }
    };
    try {
      await walk("");
      return out.length >= 0 ? out : null;
    } catch {
      return null;
    }
  }

  async readFile(name: string, file: string): Promise<string | null> {
    try {
      return await readFile(safeJoin(this.skillDir(name), file), "utf8");
    } catch {
      return null;
    }
  }

  async writeFile(name: string, file: string, content: string): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const target = safeJoin(this.skillDir(name), file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      return { ok: true, status: 200 };
    } catch (err) {
      return { ok: false, status: String(err).includes("Illegal path") ? 400 : 404, error: String(err) };
    }
  }

  async deleteFile(name: string, file: string): Promise<boolean> {
    try {
      await rm(safeJoin(this.skillDir(name), file), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async makeDir(name: string, dir: string): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      await mkdir(safeJoin(this.skillDir(name), dir), { recursive: true });
      return { ok: true, status: 200 };
    } catch (err) {
      return { ok: false, status: 400, error: String(err) };
    }
  }

  /** ZIP Unpack（fflate）：Reject absolute paths with .. Members */
  async uploadZip(name: string, zipBytes: Uint8Array): Promise<{ ok: boolean; status: number; files?: number; error?: string }> {
    const { unzipSync } = await import("fflate");
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zipBytes);
    } catch (err) {
      return { ok: false, status: 400, error: `ZIP parsing failed: ${err}` };
    }
    const dir = this.skillDir(name);
    // Preflight every entry before the first filesystem mutation. A bad member
    // at the end of an archive must not publish the earlier files.
    for(const member of Object.keys(files)){
      if(path.posix.isAbsolute(member)||path.win32.isAbsolute(member)||member.split(/[\\/]/).includes('..'))return {ok:false,status:400,error:`Illegal ZIP member path: ${member}`};
      safeJoin(dir,member);
    }
    await mkdir(dir, { recursive: true });
    let n = 0;
    for (const [p, data] of Object.entries(files)) {
      if (p.startsWith("/") || p.split("/").includes("..")) {
        return { ok: false, status: 400, error: `Illegal ZIP member path: ${p}` };
      }
      const target = safeJoin(dir, p);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      n++;
    }
    await this.audit("skill_uploaded", { name, files: n });
    return { ok: true, status: 200, files: n };
  }

  async usage(name: string): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(
      "SELECT id, agent_key, business_kind, business_id, ts FROM skill_usage WHERE skill=$1 ORDER BY id DESC LIMIT 100",
      [name],
    );
    return r.rows;
  }

  /** Directory ids own visibility; display names never grant access. */
  async visible(agentKey:string):Promise<{key:string;dir:string;metadata:SkillMetadata;text:string;instructions:string}[]>{
    const rows=await this.pool.query("SELECT resource_id FROM agent_visibility WHERE agent_key=$1 AND resource_kind='skill' ORDER BY resource_id",[agentKey]);
    const out=[];
    for(const row of rows.rows){if(!await skillAvailable(row.resource_id))continue;const text=await this.readFile(row.resource_id,'SKILL.md');if(text!==null){const metadata=parseFrontmatter(text);out.push({key:row.resource_id,dir:this.skillDir(row.resource_id),metadata,text,instructions:text.replace(FRONT_RE,'')});}}
    return out;
  }

  async recordUsage(name: string, agentKey: string, kind: string, id: string): Promise<void> {
    await this.pool.query("INSERT INTO skill_usage (skill, agent_key, business_kind, business_id) VALUES ($1,$2,$3,$4)", [name, agentKey, kind, id]);
  }

  private async audit(event: string, payload: Record<string, unknown>): Promise<void> {
    await appendEvent(this.pool, this.dlqPath, { business_kind: "skills", business_id: "global", event_type: event, payload });
  }
}
