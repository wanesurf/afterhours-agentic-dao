import { PublicKey } from '@solana/web3.js';
import { Governance, Proposal, GovernanceAccountParser, ProposalState, VoteThresholdType, getNativeTreasuryAddress } from '@solana/spl-governance';
import bs58 from 'bs58';
import { AFTERHOURS_DAO } from './deployed-dao.js';

type RawAccount = { owner: string; executable: boolean; lamports: number; data: [string, string] };
export interface GovernanceSnapshot {
  source: 'solana-mainnet';
  commitment: 'finalized';
  observedAt: string;
  finalizedSlots: number[];
  governance: string;
  realm: string;
  communityProposalWeightRaw: string;
  councilProposalWeightRaw: string;
  communityVoteThreshold: { type: string; percent: number | null };
  councilVoteThreshold: { type: string; percent: number | null };
  votingSeconds: number;
  holdUpSeconds: number;
  nativeTreasury: { address: string; balanceLamports: string };
  proposals: { address: string; name: string; state: string; governingMint: string; population: string; instructions: number; executedInstructions: number; automationAuthorized: false }[];
  automationAuthorized: false;
}

/** Read-only SDK boundary. Proposal text is display data, never execution authority. */
export async function readGovernanceSnapshot(
  rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  fetcher: typeof fetch = fetch,
): Promise<GovernanceSnapshot> {
  async function rpc(method: string, params: unknown[]) {
    const response = await fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Governance RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || !body.result) throw new Error('Governance RPC failed');
    if (!Number.isSafeInteger(body.result.context?.slot)) throw new Error('Missing finalized slot');
    return body.result;
  }
  function parse(address: string, raw: RawAccount, kind: typeof Governance | typeof Proposal, types: number[]) {
    if (!raw || raw.owner !== AFTERHOURS_DAO.governanceProgram || raw.executable !== false ||
      !Array.isArray(raw.data) || raw.data[1] !== 'base64' || typeof raw.data[0] !== 'string') throw new Error('Invalid governance account');
    const data = Buffer.from(raw.data[0], 'base64');
    if (data.length < 65 || data.length > 100_000 || !types.includes(data[0]!)) throw new Error('Unexpected governance discriminator');
    return GovernanceAccountParser(kind)(new PublicKey(address), { ...raw, data, owner: new PublicKey(raw.owner) }).account;
  }
  const governanceResult = await rpc('getAccountInfo', [AFTERHOURS_DAO.governance, { encoding: 'base64', commitment: 'finalized' }]);
  const governance = parse(AFTERHOURS_DAO.governance, governanceResult.value, Governance, [3, 4, 9, 10, 18, 19, 20, 21]) as Governance;
  if (governance.realm.toBase58() !== AFTERHOURS_DAO.realm) throw new Error('Governance belongs to another Realm');
  const treasury = await getNativeTreasuryAddress(new PublicKey(AFTERHOURS_DAO.governanceProgram), new PublicKey(AFTERHOURS_DAO.governance));
  const [balance, ...proposalResults] = await Promise.all([
    rpc('getBalance', [treasury.toBase58(), { commitment: 'finalized' }]),
    ...[5, 14].map(type => rpc('getProgramAccounts', [AFTERHOURS_DAO.governanceProgram, {
      encoding: 'base64', commitment: 'finalized', withContext: true,
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.of(type)) } }, { memcmp: { offset: 1, bytes: AFTERHOURS_DAO.governance } }],
    }])),
  ]);
  if (!Number.isSafeInteger(balance.value) || balance.value < 0) throw new Error('Invalid treasury balance');
  const proposals: GovernanceSnapshot['proposals'] = [];
  for (const result of proposalResults) {
    if (!Array.isArray(result.value) || result.value.length > 500) throw new Error('Invalid proposal result');
    for (const row of result.value) {
      const proposal = parse(row.pubkey, row.account, Proposal, [5, 14]) as Proposal;
      if (proposal.governance.toBase58() !== AFTERHOURS_DAO.governance || !ProposalState[proposal.state]) throw new Error('Invalid proposal binding');
      const mint = proposal.governingTokenMint.toBase58();
      if (![AFTERHOURS_DAO.communityMint, AFTERHOURS_DAO.councilMint].includes(mint as typeof AFTERHOURS_DAO.communityMint)) throw new Error('Unknown proposal voting mint');
      const options = proposal.options || [];
      proposals.push({ address: row.pubkey, name: proposal.name.slice(0, 200), state: ProposalState[proposal.state]!,
        governingMint: mint, population: mint === AFTERHOURS_DAO.communityMint ? 'community' : 'council',
        instructions: options.length ? options.reduce((sum, option) => sum + option.instructionsCount, 0) : proposal.instructionsCount,
        executedInstructions: options.length ? options.reduce((sum, option) => sum + option.instructionsExecutedCount, 0) : proposal.instructionsExecutedCount,
        automationAuthorized: false });
    }
  }
  const config = governance.config;
  const threshold = (value: typeof config.communityVoteThreshold) => ({ type: VoteThresholdType[value.type] || 'Unknown', percent: value.value ?? null });
  return { source: 'solana-mainnet', commitment: 'finalized', observedAt: new Date().toISOString(),
    finalizedSlots: [governanceResult.context.slot, balance.context.slot, ...proposalResults.map(x => x.context.slot)],
    realm: AFTERHOURS_DAO.realm, governance: AFTERHOURS_DAO.governance,
    communityProposalWeightRaw: config.minCommunityTokensToCreateProposal.toString(),
    councilProposalWeightRaw: config.minCouncilTokensToCreateProposal.toString(),
    communityVoteThreshold: threshold(config.communityVoteThreshold), councilVoteThreshold: threshold(config.councilVoteThreshold),
    votingSeconds: config.baseVotingTime, holdUpSeconds: config.minInstructionHoldUpTime,
    nativeTreasury: { address: treasury.toBase58(), balanceLamports: String(balance.value) },
    proposals: proposals.sort((a, b) => a.address.localeCompare(b.address)), automationAuthorized: false };
}
