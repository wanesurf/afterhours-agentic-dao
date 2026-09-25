export interface WalletAuthChallenge {
  challengeId: string;
  domain: string;
  uri: string;
  walletAddress: string;
  nonce: string;
  statement: string;
  issuedAt: string;
  expiresAt: string;
  cluster: string;
}

export interface HolderSession {
  sessionId: string;
  walletAddress: string;
  tokenMint: string;
  rawBalance: string;
  authenticatedAt: string;
  expiresAt: string;
}
