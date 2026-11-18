/** DeepSeek Search / Fetch Client: bounded reception, error classification, limited retries。 */

export type FetchFailure = 'policy_blocked' | 'not_extractable' | 'rate_limited' |
  'upstream_error' | 'timeout' | 'too_large' | 'no_substantive_content' | 'invalid_url' |
  'auth_failed' | 'insufficient_balance';

export interface SearchHit {
  url: string; title?: string; snippet?: string; summary?: string;
  site_name?: string; date?: string; authority?: number; rerank_score?: number;
}

export interface FetchResult {
  ok: boolean;
  title?: string;
  content?: string;
  failure?: FetchFailure;
  httpStatus?: number;
  bytes?: number;
  truncated?: boolean;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  maxApiResponseBytes: number;
  fetchTimeoutMs: number;
}

export class HuntClient {
  constructor(private readonly options: ClientOptions) {}

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<{status: number; text: string; tooLarge: boolean}> {
    // Task canceled、run The union of deadline and single timeout: any trigger terminates the real request
    const timeout = AbortSignal.timeout(this.options.fetchTimeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const response = await fetch(this.options.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`},
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.body) return {status: response.status, text: '', tooLarge: false};
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooLarge = false;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > this.options.maxApiResponseBytes) { tooLarge = true; await reader.cancel().catch(() => {}); break; }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return {status: response.status, text: new TextDecoder().decode(merged), tooLarge};
  }

  async search(query: string, count: number, signal: AbortSignal, oriQuestion?: string): Promise<{hits: SearchHit[]; failure?: FetchFailure}> {
    const body: Record<string, unknown> = {query, count, need_content: false};
    if (oriQuestion) body.ori_question = oriQuestion;
    const {status, text, tooLarge} = await this.post('/v1/tools/search', body, signal);
    if (tooLarge) return {hits: [], failure: 'too_large'};
    if (status === 401) return {hits: [], failure: 'auth_failed'};
    if (status === 402) return {hits: [], failure: 'insufficient_balance'};
    if (status === 429) return {hits: [], failure: 'rate_limited'};
    if (status === 403) return {hits: [], failure: 'policy_blocked'};
    if (status >= 500) return {hits: [], failure: 'upstream_error'};
    if (status !== 200) return {hits: [], failure: 'invalid_url'};
    try {
      const parsed = JSON.parse(text) as {results?: SearchHit[]};
      return {hits: Array.isArray(parsed.results) ? parsed.results : []};
    } catch { return {hits: [], failure: 'upstream_error'}; }
  }

  async fetchPage(url: string, signal: AbortSignal): Promise<FetchResult> {
    const {status, text, tooLarge} = await this.post('/v1/tools/fetch', {url}, signal);
    if (tooLarge) return {ok: false, failure: 'too_large', httpStatus: status};
    if (status === 403) return {ok: false, failure: 'policy_blocked', httpStatus: status};
    if (status === 404) return {ok: false, failure: 'not_extractable', httpStatus: status};
    if (status === 401) return {ok: false, failure: 'auth_failed', httpStatus: status};
    if (status === 402) return {ok: false, failure: 'insufficient_balance', httpStatus: status};
    if (status === 429) return {ok: false, failure: 'rate_limited', httpStatus: status};
    if (status === 408) return {ok: false, failure: 'timeout', httpStatus: status};
    if (status >= 500) return {ok: false, failure: 'upstream_error', httpStatus: status};
    if (status !== 200) return {ok: false, failure: 'invalid_url', httpStatus: status};
    try {
      const parsed = JSON.parse(text) as {title?: string; content?: string};
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      if (!content.trim()) return {ok: false, failure: 'no_substantive_content', httpStatus: status};
      return {ok: true, title: parsed.title, content, httpStatus: status};
    } catch {
      return {ok: false, failure: 'upstream_error', httpStatus: status};
    }
  }
}
