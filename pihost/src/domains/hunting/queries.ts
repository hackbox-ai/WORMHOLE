import {codePoints} from './urls.ts';

export type Goal = 'poc' | 'understand' | 'variant' | 'query';

export interface OutboundPolicy {
  allowProduct: boolean;
  allowVersion: boolean;
  allowCve: boolean;
  allowErrorSignature: boolean;
  allowTargetHost: boolean;
  allowContextHints: boolean;
}

export interface HuntInput {
  product?: string;
  version?: string;
  cve?: string;
  query?: string;
  goal?: Goal;
  since?: string;
  max_fetches?: number;
  force_refresh?: boolean;
}

export interface BuiltQueries {queries: string[]; oriQuestion?: string; dropped: string[]}

const MAX_QUERY_POINTS = 128;

export function defaultPolicy(): OutboundPolicy {
  return {allowProduct: true, allowVersion: true, allowCve: true,
    allowErrorSignature: false, allowTargetHost: false, allowContextHints: false};
}

/** Public information sites: their site: The restriction belongs to normal search syntax and does not count as target information leakage.。 */
const PUBLIC_SITES = ['github.com', 'raw.githubusercontent.com', 'exploit-db.com', 'nvd.nist.gov',
  'packetstormsecurity.com', 'vulners.com', 'ossf.github.io', 'google.github.io', 'cve.org'];
const isPublicHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return PUBLIC_SITES.some(site => h === site || h.endsWith('.' + site));
};

/**
 * External hair desensitization：
 * - All credentials will be erased (regardless of the target domain name switch)）；
 * - site: Only public information sites are retained; the target domain name is only available in allowTargetHost Reserved only when opened；
 * - URL Press the same host Judgment, keep the public site, replace other places with placeholders。
 */
export function sanitize(text: string, policy: OutboundPolicy): string {
  let out = text;
  // Authorization The entire certification value (including Bearer After token）Prioritize processing
  out = out.replace(/\bAuthorization\s*[:=]\s*(?:Bearer|Basic|Token)?\s*("[^"]*"|'[^']*'|[^\s"']+)/gi,
    'Authorization: [redacted]');
  // Other credentials: with quotes/Erase everything without quotation marks; it has nothing to do with the target domain name switch
  out = out.replace(/((?:token|key|secret|passwd|password|cookie)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1[redacted]');
  // site: Only public information sites are retained; the target domain name is required allowTargetHost
  out = out.replace(/\bsite:(\S+)/gi, (whole, host: string) =>
    (policy.allowTargetHost || isPublicHost(host)) ? whole : '');
  // Entire paragraph URL：Based on host judgment, the entire non-public station will be replaced (the path will not be retained)）
  out = out.replace(/https?:\/\/[^\s"'）)]+/gi, (whole: string) => {
    try {
      const host = new URL(whole).hostname;
      return (policy.allowTargetHost || isPublicHost(host)) ? whole : '[url]';
    } catch { return '[url]'; }
  });
  // Target host: independent switch; erases explicit when closed host=/hostname=/domain=
  if (!policy.allowTargetHost) {
    out = out.replace(/\b(host|hostname|domain|fqdn)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1=[host]');
  }
  // Target context: independent switch; erased when closed user=/operator= and other identifiable identity fields
  if (!policy.allowContextHints) {
    out = out.replace(/\b(user|username|operator|email)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1=[context]');
  }
  // Error reporting features: independent switch, common error codes are erased when turned off/Stack fragment
  if (!policy.allowErrorSignature) {
    out = out.replace(/SQLSTATE(?:\[[^\]]*\]|[:\s]*\w+)|\bORA-\d{4,}|Traceback[\s\S]{0,120}|\bat\s+\S+\s*\([^)]*:\d+\)/gi, '[error]');
  }
  out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\b/g, '$1.$2.$3.x');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function fit(query: string, dropped: string[]): string | null {
  const trimmed = query.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (codePoints(trimmed) <= MAX_QUERY_POINTS) return trimmed;
  dropped.push(`Overlong discard: ${trimmed.slice(0, 60)}…`);
  return null;
}

export function buildQueries(input: HuntInput, goal: Goal, policy: OutboundPolicy,
                             maxQueries: number, contextTitle?: string): BuiltQueries {
  const dropped: string[] = [];
  const raw: string[] = [];
  const cve = policy.allowCve ? sanitize((input.cve ?? '').trim().toUpperCase(), policy) : '';
  const product = policy.allowProduct ? sanitize((input.product ?? '').trim(), policy) : '';
  const version = policy.allowVersion ? sanitize((input.version ?? '').trim(), policy) : '';

  if (goal === 'query' || input.query) {
    const original = (input.query ?? '').trim();
    if (original) {
      // The free retrieval method is always too desensitized: the credentials must be erased，site:/URL Retain public data sites by policy
      const explicit = sanitize(original, policy);
      if (!explicit) throw new Error("query is empty after desensitization. Please change it to a search query that does not contain the target domain name/URL.");
      if (codePoints(explicit) > MAX_QUERY_POINTS) {
        throw new Error(`query exceeds ${MAX_QUERY_POINTS} characters (counted in Unicode), please shorten and try again`);
      }
      raw.push(explicit);
    }
  }
  if (goal !== 'query') {
    if (goal === 'poc') {
      if (cve) raw.push(`"${cve}" poc OR exploit site:github.com OR site:exploit-db.com`);
      if (cve) raw.push(`"${cve}" nuclei template`);
      if (product) raw.push(`"${product} ${version}" exploit`.replace(/\s+"/g, '"'));
    } else if (goal === 'variant') {
      if (cve) raw.push(`"${cve}" fix commit OR patch diff site:github.com`);
      if (product) raw.push(`"${product}" security fix changelog`);
      if (product) raw.push(`"${product}" CVE`);
    } else {
      if (cve) raw.push(`"${cve}" analysis OR root cause OR writeup`);
      if (cve) raw.push(`"${cve}"Analysis OR Reproduction OR Principle`);
      if (cve) raw.push(`"${cve}" advisory site:nvd.nist.gov OR site:github.com`);
      if (product) raw.push(`"${product} ${version}" vulnerability analysis`.replace(/\s+"/g, '"'));
    }
  }

  const queries: string[] = [];
  for (const item of raw) {
    const ok = fit(item, dropped);
    if (ok && !queries.includes(ok)) queries.push(ok);
    if (queries.length >= maxQueries) break;
  }
  const oriQuestion = policy.allowContextHints && contextTitle
    ? contextTitle.slice(0, 120) : undefined;
  return {queries, oriQuestion, dropped};
}
