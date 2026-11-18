/** White box product HTTP Client. Only for internal use of the platform, the model will never see these calls.。 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export interface WhiteboxFinding {
  key?: string; title?: string; severity?: string; category?: string; cwe?: string;
  file?: string; lines?: string; description?: string; impact?: string;
  evidence?: string; poc?: string; remediation?: string;
  task_id?: string; repo_id?: string;
}
export interface WhiteboxMatch {path?: string; line?: number; text?: string; decompiled?: boolean}
export interface WhiteboxTree {dirs?: {name: string; path: string}[]; files?: {name: string; path: string; size?: number}[]; total?: number; truncated?: boolean}

const TIMEOUT = {health: 5_000, import: 1_800_000, git: 600_000, audit: 60_000, query: 60_000};
/** The upper limit of paging vulnerability library: per page 100 items, at most 40 page（4000 ) to prevent infinite page turning。 */
const FINDINGS_PAGE_SIZE = 100;
const FINDINGS_MAX_PAGES = 40;

async function blobOf(file: string): Promise<Blob> {
  const g = globalThis as unknown as {openAsBlob?: (p: string) => Promise<Blob>; Blob: typeof Blob};
  const fs = await import('node:fs');
  const openAsBlob = (fs as unknown as {openAsBlob?: (p: string) => Promise<Blob>}).openAsBlob;
  if (typeof openAsBlob === 'function') return openAsBlob(file);
  return new g.Blob([await readFile(file)]);
}

export class WhiteboxClient {
  constructor(readonly base: string,private readonly token?:string) {}

  private endpoint(p: string): string { return this.base.replace(/\/+$/, '') + p; }

  /** signal Let task cancellation immediately interrupt an import in progress/Query instead of waiting for full timeout。 */
  private async call<T>(pathname: string, timeoutMs: number, init?: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.endpoint(pathname), {...init,headers:{...(this.token?{Authorization:'Bearer '+this.token}:{}),...Object.fromEntries(new Headers(init?.headers).entries())}, signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    const text = await res.text();
    if (!res.ok) throw new Error(`White box ${pathname} Return ${res.status}: ${text.slice(0, 300)}`);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  async healthy(): Promise<boolean> {
    try { return (await this.call<{ok?: boolean}>('/api/health', TIMEOUT.health)).ok === true; } catch { return false; }
  }

  async importZip(file: string, name: string, appid?: string, signal?: AbortSignal): Promise<{repoId: string; source: string}> {
    const form = new FormData();
    form.append('file', await blobOf(file), path.basename(file));
    form.append('name', name);
    if (appid) form.append('wxapkg_appid', appid);
    const r = await this.call<{repo?: {id?: string; source?: string}}>('/api/repos/zip', TIMEOUT.import, {method: 'POST', body: form}, signal);
    if (!r.repo?.id) throw new Error("White box import does not return repo_id");
    return {repoId: String(r.repo.id), source: String(r.repo.source ?? '')};
  }

  async importGit(url: string, signal?: AbortSignal): Promise<{repoId: string}> {
    const r = await this.call<{repo?: {id?: string}}>('/api/repos/git', TIMEOUT.git, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({url, shallow: true}),
    }, signal);
    if (!r.repo?.id) throw new Error("White box git import does not return repo_id");
    return {repoId: String(r.repo.id)};
  }

  async submitAudit(repoId: string, focus: string, maxIterations = 20, signal?: AbortSignal): Promise<{taskId: string}> {
    const r = await this.call<{tasks?: {id?: string}[]}>('/api/tasks', TIMEOUT.audit, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        repo_ids: [repoId],
        prompt: "Conduct a directional white-box audit of the imported code, focusing only on externally accessible request processing paths, authentication and data access.",
        focus, max_iterations: maxIterations, rounds: 1, lsp: false,
      }),
    }, signal);
    const id = r.tasks?.[0]?.id;
    if (!id) throw new Error("White box audit task does not return task_id");
    return {taskId: String(id)};
  }

  async auditStatus(taskId: string, signal?: AbortSignal): Promise<{status: string; error: string; findings: number; counts: Record<string, number>}> {
    const r = await this.call<{task?: {status?: string; error?: string; stop_reason?: string; findings?: unknown[]; finding_counts?: Record<string, number>}}>(
      '/api/tasks/' + encodeURIComponent(taskId), TIMEOUT.query, undefined, signal);
    const task = r.task ?? {};
    return {
      status: String(task.status ?? ''),
      error: String(task.error || task.stop_reason || ''),
      findings: Array.isArray(task.findings) ? task.findings.length : 0,
      counts: task.finding_counts ?? {},
    };
  }

  /**
   * Get the vulnerability of a certain audit task. Give priority to using the endpoint of query by task, and only return the results this time.；
   * If it cannot be obtained, return the vulnerability database and turn the page to get the full amount, and then the caller presses task_id Filter。
   */
  async findings(repoId: string, severity = '', size = FINDINGS_PAGE_SIZE, signal?: AbortSignal, auditTaskId = ''): Promise<WhiteboxFinding[]> {
    if (auditTaskId) {
      try {
        const r = await this.call<{findings?: WhiteboxFinding[]}>(
          `/api/tasks/${encodeURIComponent(auditTaskId)}/findings`, TIMEOUT.query, undefined, signal);
        if (Array.isArray(r.findings)) return r.findings;
      } catch { /* If the endpoint is unavailable, go to the vulnerability library below */ }
    }
    const out: WhiteboxFinding[] = [];
    const filter = severity ? `&severity=${encodeURIComponent(severity)}` : '';
    for (let page = 1; page <= FINDINGS_MAX_PAGES; page++) {
      const r = await this.call<{findings?: WhiteboxFinding[]; total?: number}>(
        `/api/findings/library?repo_id=${encodeURIComponent(repoId)}&size=${size}&page=${page}${filter}`, TIMEOUT.query, undefined, signal);
      const batch = Array.isArray(r.findings) ? r.findings : [];
      out.push(...batch);
      const total = Number(r.total ?? 0);
      if (batch.length < size || (total && out.length >= total)) break;
    }
    return out;
  }

  /** Stop the audit task that has been submitted on the white box side. Do not throw on failure: stopping the process should not be blocked by it。 */
  async cancelAudit(taskId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      // Must be stop：DELETE Task records, reports, tracks and generated findings
      await this.call<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/stop`, TIMEOUT.query, {method: 'POST'}, signal);
      return true;
    } catch { return false; }
  }

  async search(repoId: string, pattern: string, limit: number, signal?: AbortSignal): Promise<{matches: WhiteboxMatch[]; scanned: number; truncated: boolean}> {
    const r = await this.call<{matches?: WhiteboxMatch[]; scanned?: number; truncated?: boolean}>(
      `/api/repos/${encodeURIComponent(repoId)}/search?q=${encodeURIComponent(pattern)}&limit=${limit}`, TIMEOUT.query, undefined, signal);
    return {matches: Array.isArray(r.matches) ? r.matches : [], scanned: Number(r.scanned ?? 0), truncated: !!r.truncated};
  }

  async readFile(repoId: string, filePath: string, signal?: AbortSignal): Promise<{content: string; decompiled?: string; lang?: string; truncated: boolean; lines: number}> {
    const r = await this.call<{content?: string; decompiled?: string; lang?: string; truncated?: boolean; lines?: number}>(
      `/api/repos/${encodeURIComponent(repoId)}/file?path=${encodeURIComponent(filePath)}`, TIMEOUT.query, undefined, signal);
    return {content: String(r.content ?? ''), decompiled: r.decompiled, lang: r.lang, truncated: !!r.truncated, lines: Number(r.lines ?? 0)};
  }

  async tree(repoId: string, dir = '', flat = true, signal?: AbortSignal): Promise<WhiteboxTree> {
    return this.call<WhiteboxTree>(
      `/api/repos/${encodeURIComponent(repoId)}/tree?path=${encodeURIComponent(dir)}&flat=${flat ? 1 : 0}`, TIMEOUT.query, undefined, signal);
  }
}
