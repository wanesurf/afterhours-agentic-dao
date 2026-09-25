import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './auth/holder-auth.js';
import { ChatSessions, CHAT_SESSION_TTL_MS } from './chat-sessions.js';
import type { HermesRuntime } from './hermes-runtime.js';

export interface ChatOptions { origin: string; runtime: HermesRuntime; evidence: () => Promise<string> }
const cookieValue = (req: IncomingMessage, name: string) => req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Expected a JSON request.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 10_000) throw new HttpError(413, 'This request is too large.'); chunks.push(Buffer.from(chunk)); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Invalid request.'); }
}
export function createChatRoutes(options: ChatOptions) {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin) throw new Error('WEB_ORIGIN must be an exact origin without a trailing slash.');
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Public chat requires HTTPS.');
  const sessions = new ChatSessions();
  // A separate cookie prevents old wallet-gated histories being reused as public sessions.
  const sessionName = secure ? '__Host-afterhours_chat' : 'afterhours_chat';
  const cookie = (id: string, seconds: number) => `${sessionName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const buckets = new Map<string, { count: number; reset: number }>();
  let concurrentChats = 0;
  function limit(key: string, maximum: number, ms = 60_000) {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.reset <= now) buckets.delete(key);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 10_000) throw new HttpError(429, 'Please wait a moment before trying again.');
      bucket = { count: 0, reset: now + ms }; buckets.set(key, bucket);
    }
    if (++bucket.count > maximum) throw new HttpError(429, 'Please wait a moment before trying again.');
  }
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (!path.startsWith('/api/auth/') && path !== '/api/chat' && !path.startsWith('/api/chat/')) return false;
    try {
      const ip = req.socket.remoteAddress || 'unknown'; // Never trust arbitrary X-Forwarded-For.
      limit(`ip:${ip}`, 120);
      if (path.startsWith('/api/auth/')) throw new HttpError(404, 'Wallet sign-in is no longer required for chat.');
      if (!['/api/chat', '/api/chat/session', '/api/chat/reset'].includes(path)) throw new HttpError(404, 'Not found.');
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, 'Please open chat from the Afterhours website.');
      if (req.method === 'GET' && path === '/api/chat') {
        json(res, 200, { messages: sessions.get(cookieValue(req, sessionName)).messages }); return true;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const input = await body(req);
      if (path === '/api/chat/session') {
        if (Object.keys(input).length) throw new HttpError(400, 'No wallet or credentials are needed to start chat.');
        let session = sessions.find(cookieValue(req, sessionName));
        if (!session) {
          limit(`new-session:${ip}`, 20);
          session = sessions.create();
          res.setHeader('set-cookie', cookie(session.id, CHAT_SESSION_TTL_MS / 1000));
        }
        json(res, 200, { access: 'public', expiresAt: session.expiresAt, agentConfigured: options.runtime.configured, messages: session.messages });
        return true;
      }
      const session = sessions.get(cookieValue(req, sessionName));
      if (path === '/api/chat/reset') {
        if (Object.keys(input).length) throw new HttpError(400, 'Invalid reset request.');
        sessions.reset(session); json(res, 200, { ok: true }); return true;
      }
      if (Object.keys(input).some(key => key !== 'message') || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4_000) throw new HttpError(400, 'Send a message between 1 and 4,000 characters.');
      if (!options.runtime.configured) throw new HttpError(503, 'The agent is not connected yet. Please try again later.');
      if (session.busy) throw new HttpError(409, 'The agent is still answering your last message.');
      if (concurrentChats >= 4) throw new HttpError(429, 'The agent is busy. Please try again shortly.');
      limit(`chat-ip:${ip}`, 20); // New cookies must not bypass the completion limit.
      limit(`chat-session:${session.id}`, 8);
      session.busy = true; concurrentChats++;
      try {
        const message = { role: 'user' as const, content: input.message.trim() };
        let evidence = 'Market data unavailable. Do not supply current prices.';
        try { evidence = await options.evidence(); } catch { /* State unavailability explicitly. */ }
        const answer = await options.runtime.reply([...session.messages, message], session.conversationId, evidence);
        sessions.get(session.id); // Do not retain a reply after expiration.
        session.messages = [...session.messages, message, { role: 'assistant' as const, content: answer }].slice(-12);
        json(res, 200, { answer });
      } finally { session.busy = false; concurrentChats--; }
      return true;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 429) res.setHeader('retry-after', '60');
      if (status === 401) res.setHeader('set-cookie', cookie('', 0));
      json(res, status, { error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
      return true;
    }
  };
}
