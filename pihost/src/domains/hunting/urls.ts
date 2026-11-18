/** URL Normalization and deduplication keys: only processes confirmed valid forms, and the rest are released as they are.。 */

export interface FetchTarget {url: string}

export function toFetchable(raw: string): FetchTarget | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  u.hash = '';
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(path);
    if (m) return {url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`};
  }
  if (host === 'gist.github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/?$/.exec(path);
    if (m) return {url: `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`};
  }
  if (host === 'www.exploit-db.com' || host === 'exploit-db.com') {
    const m = /^\/exploits\/(\d+)\/?$/.exec(path);
    if (m) return {url: `https://www.exploit-db.com/raw/${m[1]}`};
  }
  return {url: u.href};
}

/** Only these parameters are considered tracking parameters; the rest are retained（article/notice/sid and the like may determine the content）。 */
// Only accept parameters that have no resource semantics and are purely used for attribution；ref/source/from Possible decision GitLab File version, etc., reserved
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|msclkid|yclid|spm|share|_ga)$/i;

export function urlKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
    ? ':' + u.port : '';
  const keep = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    if (!TRACKING.test(key)) keep.append(key, value);
  }
  keep.sort();
  return host + port + path + (keep.size ? '?' + keep.toString() : '');
}

/** Press Unicode Code point count (search engine limit is not UTF-16 Length）。 */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
