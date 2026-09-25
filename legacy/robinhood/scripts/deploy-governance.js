import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const confirmation = 'DEPLOY_AFTERHOURS_GOVERNANCE';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, { allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = required(name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} is out of range`);
  }
  return value;
}

function artifact(relativePath) {
  const parsed = JSON.parse(readFileSync(resolve(relativePath), 'utf8'));
  if (!parsed.abi || !parsed.bytecode?.object || parsed.bytecode.object === '0x') {
    throw new Error(`Missing deployable artifact: ${relativePath}. Run npm run contracts:build first.`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function waitForSuccess(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}

async function main() {
  if (process.env.DEPLOY_GOVERNANCE_CONFIRM !== confirmation) {
    throw new Error(`Set DEPLOY_GOVERNANCE_CONFIRM=${confirmation} to allow a broadcast`);
  }

  const rpcUrl = required('RPC_URL');
  const expectedChainId = Number(process.env.GOVERNANCE_EXPECTED_CHAIN_ID || '4663');
  const tokenAddress = getAddress(process.env.GOVERNANCE_TOKEN_ADDRESS || required('PONS_TOKEN_ADDRESS'));
  const votingDelay = positiveInteger('GOVERNANCE_VOTING_DELAY_SECONDS', { allowZero: true, maximum: 2 ** 48 - 1 });
  const votingPeriod = positiveInteger('GOVERNANCE_VOTING_PERIOD_SECONDS', { maximum: 2 ** 32 - 1 });
  const timelockDelay = positiveInteger('GOVERNANCE_TIMELOCK_DELAY_SECONDS', { maximum: 2 ** 48 - 1 });
  const quorumPercent = positiveInteger('GOVERNANCE_QUORUM_PERCENT', { maximum: 100 });
  const thresholdTokens = required('GOVERNANCE_PROPOSAL_THRESHOLD_TOKENS');
  const rawPrivateKey = required('GOVERNANCE_DEPLOYER_PRIVATE_KEY');
  const privateKey = rawPrivateKey.startsWith('0x') ? rawPrivateKey : `0x${rawPrivateKey}`;
  const account = privateKeyToAccount(privateKey);

  const chain = {
    id: expectedChainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== expectedChainId) {
    throw new Error(`RPC chain ${connectedChainId} does not match expected chain ${expectedChainId}`);
  }

  const tokenCode = await publicClient.getBytecode({ address: tokenAddress });
  if (!tokenCode || tokenCode === '0x') throw new Error(`No token contract at ${tokenAddress}`);
  const tokenDecimals = await publicClient.readContract({
    address: tokenAddress,
    abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }],
    functionName: 'decimals',
  });
  const proposalThreshold = parseUnits(thresholdTokens, tokenDecimals);

  const votesArtifact = artifact('contracts/out/AfterhoursVotes.sol/AfterhoursVotes.json');
  const timelockArtifact = artifact('contracts/out/TimelockController.sol/TimelockController.json');
  const governorArtifact = artifact('contracts/out/AfterhoursGovernor.sol/AfterhoursGovernor.json');
  const transactions = {};

  transactions.deployVotes = await walletClient.deployContract({
    ...votesArtifact,
    args: [tokenAddress],
  });
  const votesReceipt = await waitForSuccess(publicClient, transactions.deployVotes, 'AfterhoursVotes deployment');
  const votesAddress = getAddress(votesReceipt.contractAddress);

  transactions.deployTimelock = await walletClient.deployContract({
    ...timelockArtifact,
    args: [BigInt(timelockDelay), [], [], account.address],
  });
  const timelockReceipt = await waitForSuccess(publicClient, transactions.deployTimelock, 'Timelock deployment');
  const timelockAddress = getAddress(timelockReceipt.contractAddress);

  transactions.deployGovernor = await walletClient.deployContract({
    ...governorArtifact,
    args: [
      votesAddress,
      timelockAddress,
      votingDelay,
      votingPeriod,
      proposalThreshold,
      BigInt(quorumPercent),
    ],
  });
  const governorReceipt = await waitForSuccess(publicClient, transactions.deployGovernor, 'Governor deployment');
  const governorAddress = getAddress(governorReceipt.contractAddress);

  const readRole = (functionName) => publicClient.readContract({
    address: timelockAddress,
    abi: timelockArtifact.abi,
    functionName,
  });
  const [proposerRole, cancellerRole, executorRole, adminRole] = await Promise.all([
    readRole('PROPOSER_ROLE'),
    readRole('CANCELLER_ROLE'),
    readRole('EXECUTOR_ROLE'),
    readRole('DEFAULT_ADMIN_ROLE'),
  ]);

  async function writeTimelock(functionName, args, label) {
    const hash = await walletClient.writeContract({
      address: timelockAddress,
      abi: timelockArtifact.abi,
      functionName,
      args,
    });
    await waitForSuccess(publicClient, hash, label);
    return hash;
  }

  transactions.grantProposer = await writeTimelock('grantRole', [proposerRole, governorAddress], 'grant proposer');
  transactions.grantCanceller = await writeTimelock('grantRole', [cancellerRole, governorAddress], 'grant canceller');
  transactions.openExecutor = await writeTimelock('grantRole', [executorRole, zeroAddress], 'open executor');

  const requiredRolesPresent = await Promise.all([
    publicClient.readContract({
      address: timelockAddress,
      abi: timelockArtifact.abi,
      functionName: 'hasRole',
      args: [proposerRole, governorAddress],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: timelockArtifact.abi,
      functionName: 'hasRole',
      args: [cancellerRole, governorAddress],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: timelockArtifact.abi,
      functionName: 'hasRole',
      args: [executorRole, zeroAddress],
    }),
  ]);
  if (requiredRolesPresent.some((present) => !present)) {
    throw new Error('Refusing to remove deployer admin: governance roles are incomplete');
  }

  transactions.renounceAdmin = await writeTimelock(
    'renounceRole',
    [adminRole, account.address],
    'renounce deployer admin',
  );
  const deployerStillAdmin = await publicClient.readContract({
    address: timelockAddress,
    abi: timelockArtifact.abi,
    functionName: 'hasRole',
    args: [adminRole, account.address],
  });
  if (deployerStillAdmin) throw new Error('Deployer unexpectedly retains Timelock administration');

  const deployment = {
    chainId: connectedChainId,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    underlyingToken: tokenAddress,
    votes: votesAddress,
    timelock: timelockAddress,
    governor: governorAddress,
    parameters: {
      votingDelaySeconds: votingDelay,
      votingPeriodSeconds: votingPeriod,
      timelockDelaySeconds: timelockDelay,
      quorumPercent,
      proposalThresholdTokens: thresholdTokens,
    },
    transactions,
  };
  const deploymentOutput = resolve(process.env.GOVERNANCE_DEPLOYMENT_OUTPUT || '.runtime/governance-deployment.json');
  mkdirSync(resolve(deploymentOutput, '..'), { recursive: true });
  writeFileSync(
    deploymentOutput,
    `${JSON.stringify(deployment, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`,
    { flag: 'wx' },
  );
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
