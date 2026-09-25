export const AFTERHOURS_DAO = {
  cluster: "mainnet-beta",
  realm: "HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK",
  governance: "Haf7oXbQ1JREia8gWk9yv3ebtv9BXMiL1jgzo5LSVkhD",
  governanceProgram: "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
  communityMint: "A9FBHUz352WGYC3GUpPdQe1bKUCLojvLMsa5uxatuYwn",
  councilMint: "7CKWChq1pW6NLbK7X4r2SyuKbECfxtefga3f74UT4hic",
  token2022Program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  realmsUrl: "https://v2.realms.today/dao/HLbzfAQP4b5oFBh8CeQ6DQSX1zr8kjjejxuywU2yYeCK",
} as const;

export interface DaoAccountCheck {
  name: "realm" | "governance" | "communityMint" | "councilMint";
  address: string;
  owner: string | null;
  expectedOwner: string;
  valid: boolean;
}

export interface DaoStatus {
  cluster: "mainnet-beta";
  realm: string;
  governance: string;
  communityMint: string;
  councilMint: string;
  realmsUrl: string;
  finalizedSlot: number;
  verified: boolean;
  accounts: DaoAccountCheck[];
}

interface RpcAccount {
  owner: unknown;
  executable: unknown;
  data: unknown;
}

/** Verify public account identities only; this does not decode voting rules. */
export async function readDaoStatus(
  rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  fetcher: typeof fetch = fetch,
): Promise<DaoStatus> {
  const addresses = [AFTERHOURS_DAO.realm, AFTERHOURS_DAO.governance,
    AFTERHOURS_DAO.communityMint, AFTERHOURS_DAO.councilMint];
  const expectedOwners = [AFTERHOURS_DAO.governanceProgram, AFTERHOURS_DAO.governanceProgram,
    AFTERHOURS_DAO.token2022Program, AFTERHOURS_DAO.splTokenProgram];
  const names = ["realm", "governance", "communityMint", "councilMint"] as const;
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "finalized" }] }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("result" in payload)) throw new Error("Invalid Solana RPC response");
  const result = (payload as { result: unknown }).result;
  if (!result || typeof result !== "object") throw new Error("Invalid Solana RPC result");
  const { context, value } = result as { context?: { slot?: unknown }; value?: unknown };
  if (!Number.isSafeInteger(context?.slot) || !Array.isArray(value) || value.length !== addresses.length) {
    throw new Error("Invalid Solana RPC account response");
  }
  const accounts: DaoAccountCheck[] = value.map((raw: RpcAccount | null, index: number) => {
    const data = raw?.data;
    const hasData = Array.isArray(data) && data.length === 2 && typeof data[0] === "string" &&
      data[0].length > 0 && data[1] === "base64";
    const owner = typeof raw?.owner === "string" ? raw.owner : null;
    return { name: names[index]!, address: addresses[index]!, owner,
      expectedOwner: expectedOwners[index]!,
      valid: owner === expectedOwners[index] && raw?.executable === false && hasData };
  });
  return {
    cluster: AFTERHOURS_DAO.cluster,
    realm: AFTERHOURS_DAO.realm,
    governance: AFTERHOURS_DAO.governance,
    communityMint: AFTERHOURS_DAO.communityMint,
    councilMint: AFTERHOURS_DAO.councilMint,
    realmsUrl: AFTERHOURS_DAO.realmsUrl,
    finalizedSlot: context!.slot as number,
    verified: accounts.every(account => account.valid),
    accounts,
  };
}
