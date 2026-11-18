/** NVD / OSV / GitHub Read-only query: None key can also be used, just say one sentence about speed limit and failure。 */
import type {Pool} from 'pg';
import {setDefaultResultOrder} from 'node:dns';

export interface Fail {
  ok: false;
  reason: 'rate_limited' | 'token_required' | 'not_found' | 'unavailable' | 'invalid_response' | 'invalid_input';
  hint: string;
  retry_after_s?: number;
}

interface CpeCondition {
  criteria: string; part: string; vendor: string; product: string; version: string;
  vulnerable: boolean;
  /** Contained in configuration negate：Unable to safely evaluate, only candidates can be retained */
  unsafe?: boolean;
  /** Same node Multiple conditions within OR：Any hit is a hit; but it cannot be ruled out based on this */
  orGroup?: boolean;
  startIncluding?: string; startExcluding?: string; endIncluding?: string; endExcluding?: string;
}

const short = (text: string, max = 120): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

class Bucket {
  private stamps: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  take(): number | null {
    const now = Date.now();
    this.stamps = this.stamps.filter(t => now - t < this.windowMs);
    if (this.stamps.length >= this.limit) {
      return Math.max(1, Math.ceil((this.windowMs - (now - this.stamps[0]!)) / 1000));
    }
    this.stamps.push(now);
    return 0;
  }
}

function cmp(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const versionLike = (v: string): boolean => /^\d+(\.\d+)*$/.test(v);
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const invalidResponse = (hint: string): Fail => ({ok: false, reason: 'invalid_response', hint});

/** Only compare the affected conditions of the target product itself; if it cannot be judged, then unknown，Don’t guess。 */
export function versionMatch(conditions: CpeCondition[], target: {part?: string; vendor?: string; product?: string; version?: string}): 'matched' | 'excluded' | 'unknown' {
  if (!target.version || !versionLike(target.version)) return 'unknown';
  const applicable = conditions.filter(c => {
    if (c.vulnerable === false) return false;
    if (target.part && c.part && target.part !== c.part) return false;
    if (target.vendor && c.vendor.toLowerCase() !== target.vendor.toLowerCase()) return false;
    if (target.product && c.product.toLowerCase() !== target.product.toLowerCase()) return false;
    return true;
  });
  if (!applicable.length) return 'unknown';
  let sawUnsafe = false, sawUnrestricted = false, sawUnknown = false, sawConstraint = false, sawOr = false;
  for (const c of applicable) {
    if (c.unsafe) { sawUnsafe = true; continue; }
    if (c.orGroup) sawOr = true;
    if (c.version && c.version !== '*' && c.version !== '-') {
      if (!versionLike(c.version)) { sawUnknown = true; continue; }
      sawConstraint = true;
      if (c.version === target.version) return 'matched';
      continue;
    }
    const bounds = [c.startIncluding, c.startExcluding, c.endIncluding, c.endExcluding].filter(Boolean) as string[];
    // No range limit = This condition does not exclude any version
    if (!bounds.length) { sawUnrestricted = true; continue; }
    if (bounds.some(bound => !versionLike(bound))) { sawUnknown = true; continue; }
    sawConstraint = true;
    const afterStart = c.startIncluding ? cmp(target.version, c.startIncluding) >= 0
      : c.startExcluding ? cmp(target.version, c.startExcluding) > 0 : true;
    const beforeEnd = c.endIncluding ? cmp(target.version, c.endIncluding) <= 0
      : c.endExcluding ? cmp(target.version, c.endExcluding) < 0 : true;
    if (afterStart && beforeEnd) return 'matched';
  }
  // OR When the group does not hit any item, it cannot be excluded based on this
  if (sawUnsafe || sawOr || sawUnrestricted || sawUnknown) return 'unknown';
  return sawConstraint ? 'excluded' : 'unknown';
}

export class IntelClient {
  private readonly nvd = new Bucket(5, 30_000);
  private readonly githubSearch = new Bucket(8, 60_000);
  private readonly githubCore = new Bucket(50, 3_600_000);

  constructor(private readonly pool: Pool,
              private readonly options: {githubToken?: string; timeoutMs?: number} = {}) {
    setDefaultResultOrder('ipv4first');   // Go to these sites domestically IPv6 Constant timeout
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T | Fail>): Promise<T | Fail> {
    const row = (await this.pool.query('SELECT payload FROM intel_cache WHERE key=$1 AND expires_at>now()', [key])).rows[0];
    if (row) return row.payload as T;
    const value = await load();
    if ((value as Fail)?.ok === false) return value;       // Failure is not cached, avoid"Speed limit 12 hours"
    await this.pool.query(
      `INSERT INTO intel_cache(key,payload,fetched_at,expires_at) VALUES($1,$2,now(),now()+($3::int * interval '1 millisecond'))
       ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now(),expires_at=EXCLUDED.expires_at`,
      [key, JSON.stringify(value), ttlMs]).catch(() => {});
    return value;
  }

  private async json(url: string, signal: AbortSignal | undefined, init?: RequestInit):
    Promise<{status: number; body: unknown; invalid: boolean; headers: Headers}> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 12_000);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const request = {...init, signal: merged,
      headers: {'user-agent': 'wormhole-intel/1.0', accept: 'application/json', ...(init?.headers ?? {})}} as RequestInit;
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
      try { response = await fetch(url, request); }
      catch (error) {
        if (merged.aborted) break;
        await sleep(300 * (attempt + 1));
      }
    }
    if (!response) return {status: -1, body: null, invalid: false, headers: new Headers()};
    const text = await response.text();
    if (!text) return {status: response.status, body: null, invalid: false, headers: response.headers};
    try { return {status: response.status, body: JSON.parse(text), invalid: false, headers: response.headers}; }
    catch { return {status: response.status, body: null, invalid: true, headers: response.headers}; }
  }

  /** Bounded reading of plain text (source code/Markdown），Do not pass JSON Analysis。 */
  private async text(url: string, signal: AbortSignal | undefined, maxBytes: number):
    Promise<{status: number; text: string; truncated: boolean}> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 12_000);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {signal: merged, headers: {'user-agent': 'wormhole-intel/1.0'}});
    } catch { return {status: -1, text: '', truncated: false}; }
    if (!response.body) return {status: response.status, text: '', truncated: false};
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, truncated = false;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      size += value.byteLength;
      chunks.push(value);
    }
    const merged2 = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { merged2.set(chunk, offset); offset += chunk.byteLength; }
    return {status: response.status, text: new TextDecoder().decode(merged2), truncated};
  }

  private nvdWait(): Fail | null {
    const wait = this.nvd.take();
    return wait ? {ok: false, reason: 'rate_limited', retry_after_s: wait,
      hint: `NVD free quota 5 times/30 seconds,${wait} Try again in seconds; you can also use OSV or GitHub first`} : null;
  }

  // ---------------- NVD ----------------
  async nvdCve(cveId: string, signal?: AbortSignal): Promise<Record<string, unknown> | Fail> {
    return this.cached(`nvd:cve:${cveId}`, 7 * 24 * 3600_000, async () => {
      const wait = this.nvdWait(); if (wait) return wait;
      const {status, body, invalid} = await this.json(
        `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`, signal);
      if (invalid) return {ok: false, reason: 'invalid_response', hint: "NVD returns not JSON"};
      if (status < 0) return {ok: false, reason: 'unavailable', hint: "NVD cannot connect, try again later"};
      if (status === 403 || status === 429) return {ok: false, reason: 'rate_limited', retry_after_s: 30, hint: "NVD speed limit, try again later"};
      if (status !== 200) return {ok: false, reason: 'unavailable', hint: `NVD Return ${status}`};
      const vulns = (body as {vulnerabilities?: unknown[]})?.vulnerabilities ?? [];
      const cve = (vulns[0] as Record<string, any> | undefined)?.cve;
      if (!isObject(cve)) return {ok: false, reason: 'not_found', hint: `NVD None ${cveId}`};
      try { return {ok: true, ...normalizeNvd(cve)}; }
      catch { return invalidResponse("NVD vulnerability field structure abnormality"); }
    });
  }

  async nvdByProduct(product: string, version?: string, signal?: AbortSignal,
                     options?: {offset?: number; startIndex?: number}): Promise<Record<string, unknown> | Fail> {
    const startFrom = Math.max(0, Number(options?.startIndex ?? 0));
    const key = `nvd:prod:${product.toLowerCase()}:${version ?? ''}:${startFrom}`;
    const result = await this.cached(key, 12 * 3600_000, async () => {
      const resolved = await this.resolveCpe(product, signal);
      if ('ok' in resolved) return resolved;
      const match = `cpe:2.3:${resolved.part}:${resolved.vendor}:${resolved.product}`;
      const items: Record<string, unknown>[] = [];
      const consumedRaw: number[] = [];
      let startIndex = startFrom, total = 0, pages = 0, partial = false;
      const CACHE_LIMIT = 1000;
      // Stop continuing upstream when the cache limit is reached, ensuring"Cache content"and"Return cursor"Consistent
      while (pages < 5 && items.length < CACHE_LIMIT) {
        const wait = this.nvdWait();
        if (wait) {
          // Didn’t get the first page: cannot be regarded as"No vulnerability"，Cannot be cached
          if (pages === 0) return wait;
          partial = true; break;
        }
        const {status, body, invalid} = await this.json(
          `https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=${encodeURIComponent(match)}&resultsPerPage=200&startIndex=${startIndex}`, signal);
        if (invalid) return {ok: false, reason: 'invalid_response', hint: "NVD returns not JSON"};
        if (status < 0) return {ok: false, reason: 'unavailable', hint: "NVD cannot connect, try again later"};
        if (status === 403 || status === 429) {
          if (pages === 0) return {ok: false, reason: 'rate_limited', retry_after_s: 30, hint: "NVD speed limit, try again later"};
          partial = true; break;
        }
        if (status !== 200) return {ok: false, reason: 'unavailable', hint: `NVD Return ${status}`};
        if (!isObject(body) || !Array.isArray(body.vulnerabilities) || typeof body.totalResults !== 'number'
            || body.vulnerabilities.some((v: any) => !isObject(v?.cve))) {
          return invalidResponse("NVD return structure exception");
        }
        const page = body as {totalResults?: number; vulnerabilities?: unknown[]};
        total = Number(page.totalResults ?? 0);
        const vulns = (page.vulnerabilities ?? []) as Record<string, any>[];
        for (let index = 0; index < vulns.length; index++) {
          const v = vulns[index]!;
          let normalized: Record<string, any>;
          try { normalized = normalizeNvd(v.cve); }
          catch { return invalidResponse("NVD vulnerability member structure abnormality"); }
          const conditions = normalized.conditions as CpeCondition[];
          const verdict = versionMatch(conditions, {part: resolved.part, vendor: resolved.vendor,
            product: resolved.product, version});
          if (version && verdict === 'excluded') continue;
          items.push({...normalized, version_match: version ? verdict : 'unknown'});
          // The original position of the bar upstream to give the correct recovery cursor when truncating
          consumedRaw.push(startIndex + index);
        }
        pages++;
        startIndex += vulns.length;
        if (!vulns.length || startIndex >= total) break;
      }
      return {ok: true, cpe: match, total, scanned: startIndex,
        upstream_more: startIndex < total || items.length > 1000, partial,
        // The cursor is advanced according to the upstream original position, and the number of items after version filtering cannot be used
        resume_start_index: items.length > 1000 ? (consumedRaw[1000] ?? startIndex) : startIndex,
        // When a keyword hits multiple products, the candidates are given together to facilitate the use of explicit cpe
        ...(resolved.candidates.length > 1 ? {cpe_candidates: resolved.candidates} : {}),
        items: items.slice(0, 1000), cached_truncated: items.length > 1000};
    });
    if ((result as Fail).ok === false) return result as Fail;
    return pageOf(result as Record<string, any>, options?.offset, 30,
      (result as Record<string, any>).upstream_more === true);
  }

  /** Explicitly given CPE Use it directly, no more guessing about products。 */
  async nvdByCpe(cpe: string, version?: string, signal?: AbortSignal,
                 options?: {offset?: number; startIndex?: number}): Promise<Record<string, unknown> | Fail> {
    if (!/^cpe:2\.3:[aoh]:/.test(cpe)) return {ok: false, reason: 'invalid_input', hint: "CPE looks like cpe:2.3:a:vendor:product"};
    const parts = cpe.split(':');
    const startFrom = Math.max(0, Number(options?.startIndex ?? 0));
    const key = `nvd:cpe:${cpe}:${version ?? ''}:${startFrom}`;
    const result = await this.cached(key, 12 * 3600_000, async () => {
      const wait = this.nvdWait(); if (wait) return wait;
      const {status, body, invalid} = await this.json(
        `https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=${encodeURIComponent(cpe)}&resultsPerPage=200&startIndex=${startFrom}`, signal);
      if (invalid) return {ok: false, reason: 'invalid_response', hint: "NVD returns not JSON"};
      if (status < 0) return {ok: false, reason: 'unavailable', hint: "NVD cannot connect, try again later"};
      if (status === 403 || status === 429) return {ok: false, reason: 'rate_limited', retry_after_s: 30, hint: "NVD speed limit, try again later"};
      if (status !== 200) return {ok: false, reason: 'unavailable', hint: `NVD Return ${status}`};
      if (!isObject(body) || !Array.isArray(body.vulnerabilities) || typeof body.totalResults !== 'number'
          || body.vulnerabilities.some((v: any) => !isObject(v?.cve))) {
        return invalidResponse("NVD return structure exception");
      }
      const page = body as {totalResults?: number; vulnerabilities?: unknown[]};
      const items: Record<string, unknown>[] = [];
      const raw = (page.vulnerabilities ?? []) as Record<string, any>[];
      for (const v of raw) {
        let normalized: Record<string, any>;
        try { normalized = normalizeNvd(v.cve); }
        catch { return invalidResponse("NVD vulnerability member structure abnormality"); }
        const verdict = versionMatch(normalized.conditions as CpeCondition[],
          {part: parts[2], vendor: parts[3], product: parts[4], version});
        if (version && verdict === 'excluded') continue;
        items.push({...normalized, version_match: version ? verdict : 'unknown'});
      }
      return {ok: true, cpe, total: Number(page.totalResults ?? items.length),
        upstream_more: Number(page.totalResults ?? 0) > startFrom + (page.vulnerabilities ?? []).length,
        resume_start_index: startFrom + raw.length,
        items: items.slice(0, 1000), cached_truncated: items.length > 1000};
    });
    if ((result as Fail).ok === false) return result as Fail;
    return pageOf(result as Record<string, any>, options?.offset, 30,
      (result as Record<string, any>).upstream_more === true);
  }

  private async resolveCpe(product: string, signal?: AbortSignal):
    Promise<{part: string; vendor: string; product: string; candidates: string[]} | Fail> {
    const wait = this.nvdWait(); if (wait) return wait;
    const {status, body, invalid} = await this.json(
      `https://services.nvd.nist.gov/rest/json/cpes/2.0?keywordSearch=${encodeURIComponent(product)}&resultsPerPage=20`, signal);
    if (invalid) return {ok: false, reason: 'invalid_response', hint: "NVD CPE dictionary returns not JSON"};
    if (status < 0) return {ok: false, reason: 'unavailable', hint: "NVD cannot connect, try again later"};
    if (status !== 200) return {ok: false, reason: 'unavailable', hint: `NVD CPE dictionary returned ${status}`};
    const names = (((body as {products?: unknown[]})?.products ?? []) as Record<string, any>[])
      .map(p => String(p?.cpe?.cpeName ?? '')).filter(Boolean);
    if (!names.length) return {ok: false, reason: 'not_found', hint: `Not found"${product}"Corresponding CPE`};
    // Priority application category（a），Otherwise press NVD Return order; reserved part，Don’t treat the operating system as an application
    const chosen = names.find(n => n.split(':')[2] === 'a') ?? names[0]!;
    const parts = chosen.split(':');
    if (!parts[3] || !parts[4]) return {ok: false, reason: 'not_found', hint: `CPE parsing failed: ${chosen}`};
    return {part: parts[2] ?? 'a', vendor: parts[3], product: parts[4], candidates: names.slice(0, 5)};
  }

  // ---------------- OSV ----------------
  async osv(name: string, version: string | undefined, ecosystem: string | undefined,
            signal?: AbortSignal, offset = 0, pageToken?: string): Promise<Record<string, unknown> | Fail> {
    if (!ecosystem) return {ok: false, reason: 'invalid_input',
      hint: "osv_lookup requires ecosystem (npm/PyPI/Go/Maven/NuGet/RubyGems/Packagist/crates.io/Alpine/Debian/Ubuntu)"};
    const key = `osv:${ecosystem}:${name}:${version ?? ''}:${pageToken ?? ''}`;
    const result = await this.cached(key, 12 * 3600_000, async () => {
      const collected: Record<string, any>[] = [];
      let token: string | undefined = pageToken, pages = 0, truncated = false;
      const CACHE_LIMIT = 1000;
      while (pages < 3 && collected.length < CACHE_LIMIT) {
        const {status, body, invalid} = await this.json('https://api.osv.dev/v1/query', signal, {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({package: {name, ecosystem}, ...(version ? {version} : {}),
            ...(token ? {page_token: token} : {})}),
        });
        if (invalid) return {ok: false, reason: 'invalid_response', hint: "OSV returns not JSON"};
        if (status < 0) return {ok: false, reason: 'unavailable', hint: "OSV cannot connect, try again later"};
        if (status === 429) return {ok: false, reason: 'rate_limited', retry_after_s: 30, hint: "OSV speed limit, try again later"};
        if (status !== 200) return {ok: false, reason: 'unavailable', hint: `OSV return ${status}`};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return {ok: false, reason: 'invalid_response', hint: "OSV return structure exception"};
        }
        const page = body as {vulns?: unknown[]; next_page_token?: string};
        if (page.vulns !== undefined && (!Array.isArray(page.vulns)
            || page.vulns.some(item => !isObject(item)
              || (item.affected !== undefined && (!Array.isArray(item.affected)
                || item.affected.some((a: any) => !isObject(a)
                  || (a.ranges !== undefined && (!Array.isArray(a.ranges)
                    || a.ranges.some((r: any) => !isObject(r)
                      || (r.events !== undefined && (!Array.isArray(r.events)
                        || r.events.some((e: any) => !isObject(e))))))))))))) {
          return invalidResponse("OSV vulns structure abnormality");
        }
        if (page.next_page_token !== undefined && typeof page.next_page_token !== 'string') {
          return invalidResponse("OSV paging token is not a string");
        }
        collected.push(...((page.vulns ?? []) as Record<string, any>[]));
        token = page.next_page_token;
        pages++;
        if (!token) break;
        if (pages >= 3) truncated = true;
      }
      let items: Record<string, unknown>[];
      try { items = collected.map(v => normalizeOsv(v, name, ecosystem)); }
      catch { return invalidResponse("OSV announcement field structure abnormality"); }
      // As long as the next page remains token，There is still unread content in the upstream (whether it is caused by the page limit or the cache limit)）
      return {ok: true, upstream_more: truncated || Boolean(token), next_page_token: token ?? null,
        items, cached_truncated: false};
    });
    const full = result as Record<string, any>;
    return pageOf(full, offset, 20, full.upstream_more === true);
  }

  // ---------------- GitHub ----------------
  private ghHeaders(): Record<string, string> {
    const token = this.options.githubToken;
    return {accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      ...(token ? {authorization: `Bearer ${token}`} : {})};
  }

  private ghFail(status: number, headers: Headers, what: string): Fail {
    const reset = Number(headers.get('x-ratelimit-reset') ?? 0);
    const waitS = reset ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
    if (status === 403 || status === 429) return {ok: false, reason: 'rate_limited', retry_after_s: waitS, hint: `GitHub quota exhausted,${waitS} Try again in seconds`};
    if (status === 401) return {ok: false, reason: 'token_required', hint: "GitHub requires a valid token"};
    if (status === 404) return {ok: false, reason: 'not_found', hint: `${what} does not exist`};
    return {ok: false, reason: 'unavailable', hint: `GitHub Return ${status}`};
  }

  async githubRepos(query: string, signal?: AbortSignal): Promise<Record<string, unknown> | Fail> {
    return this.cached(`gh:repo:${query.toLowerCase()}`, 30 * 60_000, async () => {
      const wait = this.githubSearch.take();
      if (wait) return {ok: false, reason: 'rate_limited', retry_after_s: wait, hint: `GitHub search speed limit,${wait} Try again in seconds`};
      const {status, body, invalid, headers} = await this.json(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`, signal,
        {headers: this.ghHeaders()});
      if (invalid) return {ok: false, reason: 'invalid_response', hint: "GitHub returns something other than JSON"};
      if (status < 0) return {ok: false, reason: 'unavailable', hint: "GitHub cannot connect, try again later"};
      if (status !== 200) return this.ghFail(status, headers, "Query");
      const items = ((body as {items?: unknown[]})?.items ?? []) as Record<string, any>[];
      return {ok: true, count: Number((body as {total_count?: number}).total_count ?? items.length),
        items: items.slice(0, 10).map(r => ({repo: r.full_name, description: short(String(r.description ?? '')),
          stars: r.stargazers_count, updated: r.pushed_at, url: r.html_url}))};
    });
  }

  async githubCode(query: string, signal?: AbortSignal): Promise<Record<string, unknown> | Fail> {
    if (!this.options.githubToken) return {ok: false, reason: 'token_required',
      hint: "Code search requires token; you can use repo to search first, and then read the specific file"};
    return this.cached(`gh:code:${query.toLowerCase()}`, 30 * 60_000, async () => {
      const wait = this.githubSearch.take();
      if (wait) return {ok: false, reason: 'rate_limited', retry_after_s: wait, hint: `GitHub search speed limit,${wait} Try again in seconds`};
      const {status, body, invalid, headers} = await this.json(
        `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=10`, signal, {headers: this.ghHeaders()});
      if (invalid) return {ok: false, reason: 'invalid_response', hint: "GitHub returns something other than JSON"};
      if (status < 0) return {ok: false, reason: 'unavailable', hint: "GitHub cannot connect, try again later"};
      if (status !== 200) return this.ghFail(status, headers, "Query");
      const items = ((body as {items?: unknown[]})?.items ?? []) as Record<string, any>[];
      return {ok: true, count: items.length, items: items.slice(0, 10).map(i => ({
        repo: i.repository?.full_name, path: i.path, url: i.html_url}))};
    });
  }

  async githubContents(repo: string, path: string, signal?: AbortSignal): Promise<Record<string, unknown> | Fail> {
    const wait = this.githubCore.take();
    if (wait) return {ok: false, reason: 'rate_limited', retry_after_s: wait, hint: `GitHub quotas are tight,${wait} Try again in seconds`};
    const {status, body, invalid, headers} = await this.json(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, signal, {headers: this.ghHeaders()});
    if (invalid) return {ok: false, reason: 'invalid_response', hint: "GitHub returns something other than JSON"};
    if (status < 0) return {ok: false, reason: 'unavailable', hint: "GitHub cannot connect, try again later"};
    if (status !== 200) return this.ghFail(status, headers, `${repo}/${path}`);
    if (Array.isArray(body)) {
      return {ok: true, repo, path, kind: 'directory', count: body.length,
        items: body.slice(0, 100).map((e: Record<string, any>) => ({name: e.name, type: e.type, size: e.size, path: e.path}))};
    }
    const file = body as {content?: string; encoding?: string; size?: number; download_url?: string};
    if (file.encoding === 'base64' && file.content) {
      const text = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
      return {ok: true, repo, path, kind: 'file', size: file.size ?? text.length,
        content: text.slice(0, 60_000), truncated: (file.size ?? text.length) > 60_000};
    }
    // Large file or binary contents Without text: go raw Bounded text read (without JSON Analysis）
    if (file.download_url) {
      const raw = await this.text(file.download_url, signal, 60_000);
      if (raw.status < 0) return {ok: false, reason: 'unavailable', hint: "The raw link cannot be connected, try again later."};
      if (raw.status !== 200) return {ok: false, reason: 'unavailable', hint: `raw return ${raw.status}`};
      return {ok: true, repo, path, kind: 'file', size: file.size ?? 0,
        content: raw.text, truncated: raw.truncated};
    }
    return {ok: false, reason: 'unavailable', hint: "Did not get the file text (may be too large or non-text)"};
  }
}

/** Press the full number of entries in the cache offset Cut a page and differentiate"There are also"and"Locally available"。 */
function pageOf(result: Record<string, any>, offsetRaw: number | undefined, size: number,
                upstreamMore = false): Record<string, unknown> {
  const all = (result.items ?? []) as unknown[];
  const offset = Math.max(0, Number(offsetRaw ?? 0));
  const page = all.slice(offset, offset + size);
  return {...result, count: page.length, matched_total: all.length, offset,
    has_more: offset + page.length < all.length || upstreamMore,
    upstream_more: upstreamMore, items: page};
}

function normalizeNvd(cve: Record<string, any>): Record<string, unknown> {
  const description = String((cve.descriptions ?? []).find((d: any) => d.lang === 'en')?.value ?? '');
  const metrics = cve.metrics?.cvssMetricV31?.[0] ?? cve.metrics?.cvssMetricV30?.[0] ?? cve.metrics?.cvssMetricV2?.[0];
  const conditions: CpeCondition[] = [];
  for (const config of cve.configurations ?? []) {
    const configUnsafe = config.negate === true || config.operator === 'OR';
    for (const node of config.nodes ?? []) {
      const nodeUnsafe = node.negate === true;
      const nodeOr = node.operator === 'OR' && (node.cpeMatch ?? []).length > 1;
      for (const match of node.cpeMatch ?? []) {
        const parts = String(match.criteria ?? '').split(':');
        if (parts.length < 6) continue;
        conditions.push({criteria: match.criteria, part: parts[2] ?? '', vendor: parts[3] ?? '',
          product: parts[4] ?? '', version: parts[5] ?? '*', vulnerable: match.vulnerable !== false,
          ...(configUnsafe || nodeUnsafe ? {unsafe: true} : {}),
          ...(nodeOr ? {orGroup: true} : {}),
          ...(match.versionStartIncluding ? {startIncluding: match.versionStartIncluding} : {}),
          ...(match.versionStartExcluding ? {startExcluding: match.versionStartExcluding} : {}),
          ...(match.versionEndIncluding ? {endIncluding: match.versionEndIncluding} : {}),
          ...(match.versionEndExcluding ? {endExcluding: match.versionEndExcluding} : {})});
        if (conditions.length >= 200) break;
      }
    }
  }
  return {
    cve_id: cve.id, published: cve.published, modified: cve.lastModified,
    severity: metrics?.cvssData?.baseSeverity ?? '', cvss: metrics?.cvssData?.baseScore ?? null,
    description: description.slice(0, 4000), description_truncated: description.length > 4000,
    conditions,
    references: (cve.references ?? []).slice(0, 8).map((r: any) => r.url),
  };
}

/** Standardize package names according to ecology：PyPI Lowercase and -/_/. Gui Yicheng -；npm Lowercase only; otherwise leave as is。 */
function normalizeName(name: string, ecosystem: string): string {
  const eco = ecosystem.toLowerCase();
  if (eco === 'pypi') return name.toLowerCase().replace(/[-_.]+/g, '-');
  if (eco === 'npm' || eco === 'nuget') return name.toLowerCase();
  // crates.io：is not case sensitive, and - and _ Equivalent
  if (eco === 'crates.io') return name.toLowerCase().replace(/_/g, '-');
  return name;
}

function normalizeOsv(v: Record<string, any>, name: string, ecosystem: string): Record<string, unknown> {
  if (!v || typeof v !== 'object') return {id: '', aliases: [], summary: '', details: '', ranges: [], fixed: [], references: []};
  const details = String(v.details ?? '');
  const affected = (v.affected ?? []) as Record<string, any>[];
  // Only take the one belonging to the query package affected
  const mine = affected.filter(a => {
    const pkg = a.package ?? {};
    const eco = String(pkg.ecosystem ?? '');
    if (eco && ecosystem && eco.toLowerCase() !== ecosystem.toLowerCase()) return false;
    if (normalizeName(String(pkg.name ?? ''), ecosystem) === normalizeName(name, ecosystem)) return true;
    const purl = String(pkg.purl ?? '');
    const parsed = /^pkg:([^/]+)\/(.+)$/.exec(purl);
    if (!parsed) return false;
    const purlName = decodeURIComponent(parsed[2] ?? '');
    const purlEco = (parsed[1] ?? '').toLowerCase();
    return normalizeName(purlName, purlEco) === normalizeName(name, ecosystem)
      && (!ecosystem || purlEco === ecosystem.toLowerCase());
  });
  const ranges = mine.flatMap(a => (a.ranges ?? []).map((r: Record<string, any>) => ({
    type: r.type,
    events: (r.events ?? []).map((e: Record<string, string>) => ({...e})),
  })));
  const fixed = [...new Set(ranges.flatMap(r => r.events.map((e: Record<string, string>) => e.fixed).filter(Boolean)))] as string[];
  return {
    id: v.id, aliases: v.aliases ?? [], summary: short(String(v.summary ?? ''), 400),
    severity: v.database_specific?.severity ?? v.severity?.[0]?.score ?? '',
    ecosystem, package: name,
    details: details.slice(0, 4000), details_truncated: details.length > 4000,
    ranges, fixed,
    references: (v.references ?? []).slice(0, 5).map((r: Record<string, string>) => r.url),
  };
}
