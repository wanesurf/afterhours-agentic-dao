export const HOLDER_CHAT_TOOLSET = "afterhours_holder_chat" as const;

export interface AuthenticatedHolder {
  walletAddress: string;
  tokenMint: string;
  rawBalance: string;
  verifiedAtMs: number;
  balanceCheckedAtMs: number;
}

export interface HolderChatRequest {
  sessionId: string;
  holder: AuthenticatedHolder;
  message: string;
}

export interface HolderChatResponse {
  sessionId: string;
  messageId: string;
  answer: string;
  publicReceiptIds: string[];
}

export function isHolderSessionCurrent(
  holder: AuthenticatedHolder,
  nowMs: number,
  maximumBalanceAgeMs: number,
): boolean {
  return BigInt(holder.rawBalance) > 1_000_000n && nowMs >= holder.balanceCheckedAtMs && nowMs - holder.balanceCheckedAtMs <= maximumBalanceAgeMs;
}
