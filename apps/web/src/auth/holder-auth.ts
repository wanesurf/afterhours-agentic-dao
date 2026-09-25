import { createPublicKey, randomBytes, verify } from 'node:crypto';
import bs58 from 'bs58';
import { AFTERHOURS_DAO } from '../../../../packages/dao-client/src/deployed-dao.js';

export const HOLDER_MINT = AFTERHOURS_DAO.communityMint;
export const HOLDER_DECIMALS = 6;
export const HOLDER_THRESHOLD_RAW = 1_000_000n; // Strictly greater than one token.
export const SESSION_TTL_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface Session {
  id: string; walletAddress: string; rawBalance: string; expiresAt: number;
  conversationId: string; messages: ChatMessage[]; busy: boolean;
}
interface Challenge { id: string; message: string; walletAddress: string; binding: string; expiresAt: number }
export type BalanceReader = (wallet: string) => Promise<bigint>;
const randomId = () => randomBytes(32).toString('base64url');
export function validWallet(address: unknown): address is string {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  try { return bs58.decode(address).length === 32; } catch { return false; }
}

/** Single-process demo store. Restart invalidates every challenge and session. */
export class HolderAuth {
  private challenges = new Map<string, Challenge>();
  private sessions = new Map<string, Session>();
  constructor(readonly origin: string, private balance: BalanceReader, private now = Date.now) {}
  private prune() {
    for (const [key, value] of this.challenges) if (value.expiresAt <= this.now()) this.challenges.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
  }
  challenge(walletAddress: unknown) {
    this.prune();
    if (!validWallet(walletAddress)) throw new HttpError(400, 'Choose a valid Solana wallet.');
    if (this.challenges.size >= MAX_ENTRIES) throw new HttpError(429, 'Please try again in a few minutes.');
    const id = randomId(), binding = randomId(), nonce = randomId();
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    const message = `${new URL(this.origin).host} wants you to sign in with your Solana account:\n${walletAddress}\n\nSign in to the Afterhours holder conversation. This message does not authorize transactions, transfers, approvals, or trades.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${nonce}\nIssued At: ${new Date(this.now()).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\nRequest ID: ${id}`;
    this.challenges.set(id, { id, binding, message, walletAddress, expiresAt });
    return { id, binding, message, expiresAt };
  }
  async authenticate(id: unknown, signature: unknown, binding: string | undefined): Promise<Session> {
    this.prune();
    const challenge = typeof id === 'string' ? this.challenges.get(id) : undefined;
    if (!challenge || !binding || binding !== challenge.binding) throw new HttpError(401, 'This sign-in request expired. Please connect again.');
    // Consume synchronously before any RPC await so parallel replays cannot succeed.
    this.challenges.delete(challenge.id);
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new HttpError(401, 'The wallet signature could not be verified.');
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bs58.decode(challenge.walletAddress)]),
      format: 'der', type: 'spki',
    });
    if (!verify(null, Buffer.from(challenge.message, 'utf8'), publicKey, Buffer.from(signature, 'base64'))) {
      throw new HttpError(401, 'The wallet signature could not be verified.');
    }
    const rawBalance = await this.balance(challenge.walletAddress);
    if (rawBalance <= HOLDER_THRESHOLD_RAW) throw new HttpError(403, 'This wallet needs more than 1 $AFTERHOUR to enter.');
    if (this.sessions.size >= MAX_ENTRIES) throw new HttpError(429, 'Please try again in a few minutes.');
    const session: Session = { id: randomId(), walletAddress: challenge.walletAddress, rawBalance: String(rawBalance),
      expiresAt: this.now() + SESSION_TTL_MS, conversationId: randomId(), messages: [], busy: false };
    this.sessions.set(session.id, session);
    return session;
  }
  session(id?: string): Session {
    this.prune();
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) throw new HttpError(401, 'Connect your wallet to continue.');
    return session;
  }
  async checkBalance(session: Session) {
    const rawBalance = await this.balance(session.walletAddress);
    if (rawBalance <= HOLDER_THRESHOLD_RAW) {
      this.sessions.delete(session.id);
      throw new HttpError(403, 'Your wallet no longer holds more than 1 $AFTERHOUR.');
    }
    if (!this.sessions.has(session.id) || session.expiresAt <= this.now()) throw new HttpError(401, 'Your session expired. Connect again.');
    session.rawBalance = String(rawBalance);
  }
  logout(id?: string) { if (id) this.sessions.delete(id); }
  reset(session: Session) {
    if (session.busy) throw new HttpError(409, 'Wait for the current reply before starting again.');
    session.messages = []; session.conversationId = randomId();
  }
}

export function createBalanceReader(rpcUrl: string, fetcher: typeof fetch = fetch): BalanceReader {
  return async (wallet) => {
    try {
      const response = await fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
          params: [wallet, { mint: HOLDER_MINT }, { encoding: 'jsonParsed', commitment: 'finalized' }] }),
        signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok) throw new Error('RPC unavailable');
      const payload = await response.json();
      if (payload.error || !Number.isSafeInteger(payload.result?.context?.slot) || !Array.isArray(payload.result?.value)) throw new Error('Invalid RPC result');
      let balance = 0n;
      const seen = new Set<string>();
      for (const row of payload.result.value) {
        const account = row.account, parsed = account?.data?.parsed, info = parsed?.info;
        if (!validWallet(row.pubkey) || seen.has(row.pubkey) || account?.owner !== AFTERHOURS_DAO.token2022Program || account.executable !== false ||
          parsed?.type !== 'account' || info?.owner !== wallet || info.mint !== HOLDER_MINT ||
          !['initialized', 'frozen'].includes(info.state) || info.tokenAmount?.decimals !== HOLDER_DECIMALS ||
          typeof info.tokenAmount.amount !== 'string' || !/^\d{1,20}$/.test(info.tokenAmount.amount)) throw new Error('Unexpected token account');
        seen.add(row.pubkey);
        balance += BigInt(info.tokenAmount.amount);
      }
      return balance;
    } catch { throw new HttpError(503, 'The Solana balance check is unavailable. Please try again.'); }
  };
}
