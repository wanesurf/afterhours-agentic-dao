import type { IncomingMessage, ServerResponse } from 'node:http';

export function normalizeXHandle(input: string): string {
  let handle = input.trim();
  if (/^https?:\/\//i.test(handle)) {
    const url = new URL(handle);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/[a-z0-9_]{1,15}\/?$/i.test(url.pathname)) throw new Error('Enter an X handle or profile URL.');
    handle = url.pathname.replace(/^\/|\/$/g, '');
  }
  handle = handle.replace(/^@/, '');
  if (!/^[a-z0-9_]{1,15}$/i.test(handle)) throw new Error('Enter an X handle or profile URL.');
  return handle.toLowerCase();
}

type Avatar = { bytes: Buffer; contentType: string; expires: number };
class AvatarError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CACHE_BYTES = 12 * 1024 * 1024;
export function createPfpRoutes({ fetchImpl = fetch, apiKey = process.env.UNAVATAR_API_KEY, now = Date.now }: { fetchImpl?: typeof fetch; apiKey?: string; now?: () => number } = {}) {
  const cache = new Map<string, Avatar>(), pending = new Map<string, Promise<Avatar>>();
  let cacheBytes = 0, windowStart = now(), requests = 0, dailyStart = now(), dailyRequests = 0;
  async function lookup(handle: string): Promise<Avatar> {
    const entry = cache.get(handle);
    if (entry && entry.expires > now()) return entry;
    if (entry) { cacheBytes -= entry.bytes.length; cache.delete(handle); }
    const existing = pending.get(handle); if (existing) return existing;
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    if (now() - dailyStart >= 86_400_000) { dailyStart = now(); dailyRequests = 0; }
    if (requests >= 10 || pending.size >= 4 || dailyRequests >= (apiKey ? 500 : 25)) throw new AvatarError(429, 'X lookup has reached its current limit. Upload your picture instead, or try again later.');
    requests++; dailyRequests++;
    const job = (async () => {
      const headers: Record<string, string> = { accept: 'image/png,image/jpeg,image/webp' };
      if (apiKey) headers['x-api-key'] = apiKey;
      // The user can supply only a validated handle, never a URL to fetch.
      // Reject redirects so neither an upstream redirect nor a credential can reach another host.
      const response = await fetchImpl(`https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`, { headers, redirect: 'error', signal: AbortSignal.timeout(12_000) });
      if (response.status === 404) throw new AvatarError(404, 'No public picture was found for that handle. Check the spelling or upload your picture.');
      if (response.status === 429) throw new AvatarError(429, 'X lookup is busy or has reached its limit. Upload your picture instead.');
      if (!response.ok) throw new AvatarError(502, 'X lookup is unavailable right now. You can still upload your picture.');
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!contentType || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new AvatarError(502, 'The avatar service did not return a supported picture. Please upload it instead.');
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new AvatarError(502, 'That picture is too large to fetch. Please upload a smaller version.');
      const reader = response.body?.getReader(); if (!reader) throw new AvatarError(502, 'The avatar service returned an empty picture.');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new AvatarError(502, 'That picture is too large to fetch. Please upload a smaller version.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      const valid = contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : contentType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new AvatarError(502, 'The avatar service returned an invalid picture. Please upload it instead.');
      while (cache.size && (cacheBytes + bytes.length > CACHE_BYTES || cache.size >= 100)) {
        const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.bytes.length; cache.delete(key);
      }
      const avatar = { bytes, contentType, expires: now() + 3_600_000 };
      cache.set(handle, avatar); cacheBytes += bytes.length;
      return avatar;
    })();
    pending.set(handle, job);
    try { return await job; } finally { pending.delete(handle); }
  }
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (pathname !== '/api/pfp/avatar') return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return true; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return true; }
    try {
      const input = new URL(req.url || '/', 'http://localhost').searchParams.get('handle') || '';
      let handle: string;
      try { handle = normalizeXHandle(input); } catch { throw new AvatarError(400, 'Enter a valid X handle or profile URL.'); }
      const result = await lookup(handle);
      res.writeHead(200, { 'content-type': result.contentType, 'content-length': result.bytes.length, 'cache-control': 'private, max-age=600', 'x-avatar-handle': handle });
      res.end(result.bytes);
    } catch (error) {
      const status = error instanceof AvatarError ? error.status : 502;
      const message = error instanceof AvatarError ? error.message : 'X lookup is unavailable right now. You can still upload your picture.';
      if (status === 429) res.setHeader('retry-after', '60');
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    }
    return true;
  };
}
