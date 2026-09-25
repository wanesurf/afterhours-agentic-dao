import { randomBytes } from 'node:crypto';
import { HttpError, type ChatMessage } from './auth/holder-auth.js';

export const CHAT_SESSION_TTL_MS = 60 * 60_000;
interface ChatSession {
  id: string;
  expiresAt: number;
  conversationId: string;
  messages: ChatMessage[];
  busy: boolean;
}
const randomId = () => randomBytes(32).toString('base64url');

/** Anonymous browser conversations; these sessions confer no wallet authority. */
export class ChatSessions {
  private sessions = new Map<string, ChatSession>();
  constructor(private now = Date.now) {}
  private prune() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }
  create() {
    this.prune();
    if (this.sessions.size >= 2_000) throw new HttpError(429, 'Please try again in a few minutes.');
    const session: ChatSession = { id: randomId(), expiresAt: this.now() + CHAT_SESSION_TTL_MS,
      conversationId: randomId(), messages: [], busy: false };
    this.sessions.set(session.id, session);
    return session;
  }
  find(id?: string) { this.prune(); return id ? this.sessions.get(id) : undefined; }
  get(id?: string) {
    const session = this.find(id);
    if (!session) throw new HttpError(401, 'Your chat session expired. Start a new conversation.');
    return session;
  }
  reset(session: ChatSession) {
    if (session.busy) throw new HttpError(409, 'Wait for the current reply before starting again.');
    session.messages = [];
    session.conversationId = randomId();
  }
}
