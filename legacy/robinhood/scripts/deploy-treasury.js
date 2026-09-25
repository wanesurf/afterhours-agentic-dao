import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const confirmation = 'DEPLOY_AFTERHOURS_TREASURY';
const defaultPonsFactory = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const defaultUsdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const factoryAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function feeEscrow() view returns (address)',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function addressSetting(name, fallback) {
  return getAddress(process.env[name]?.trim() || fallback || required(name));
}

function artifact(relativePath) {
  const parsed = JSON.parse(readFileSync(resolve(relativePath), 'utf8'));
  if (!parsed.abi || !parsed.bytecode?.object || parsed.bytecode.object === '0x') {
    throw new Error(`Missing deployable artifact: ${relativePath}. Run npm run contracts:build first.`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function requireCode(publicClient, address, label) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === '0x') throw new Error(`No ${label} contract at ${address}`);
}

async function main() {
  if (process.env.DEPLOY_TREASURY_CONFIRM !== confirmation) {
    throw new Error(`Set DEPLOY_TREASURY_CONFIRM=${confirmation} to allow a broadcast`);
  }

  const rpcUrl = required('RPC_URL');
  const expectedChainId = Number(process.env.GOVERNANCE_EXPECTED_CHAIN_ID || '4663');
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) throw new Error('Invalid expected chain ID');

  const ponsToken = addressSetting('PONS_TOKEN_ADDRESS');
  const ponsFactory = addressSetting('PONS_FACTORY_ADDRESS', defaultPonsFactory);
  const quoteToken = addressSetting('TREASURY_QUOTE_TOKEN_ADDRESS', defaultUsdg);
  const initialAdmin = addressSetting('TREASURY_INITIAL_ADMIN_ADDRESS');
  const migrationSource = addressSetting('TREASURY_MIGRATION_SOURCE_ADDRESS', zeroAddress);
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

  await Promise.all([
    requireCode(publicClient, ponsToken, 'Pons token'),
    requireCode(publicClient, ponsFactory, 'Pons factory'),
    requireCode(publicClient, quoteToken, 'quote token'),
    migrationSource === zeroAddress
      ? Promise.resolve()
      : requireCode(publicClient, migrationSource, 'migration source'),
  ]);

  const [launch, feeEscrow] = await Promise.all([
    publicClient.readContract({
      address: ponsFactory,
      abi: factoryAbi,
      functionName: 'getLaunchedToken',
      args: [ponsToken],
    }),
    publicClient.readContract({ address: ponsFactory, abi: factoryAbi, functionName: 'feeEscrow' }),
  ]);
  if (!launch.exists || !isAddressEqual(launch.token, ponsToken)) {
    throw new Error(`Pons launch is not registered for ${ponsToken}`);
  }
  if (!isAddressEqual(launch.pairToken, quoteToken)) {
    throw new Error(`Pons launch pair ${launch.pairToken} does not match quote token ${quoteToken}`);
  }
  await requireCode(publicClient, getAddress(feeEscrow), 'Pons fee escrow');

  const treasuryArtifact = artifact('contracts/out/AfterhoursTreasury.sol/AfterhoursTreasury.json');
  const deployHash = await walletClient.deployContract({
    ...treasuryArtifact,
    args: [ponsFactory, ponsToken, quoteToken, initialAdmin, migrationSource],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`AfterhoursTreasury deployment failed: ${deployHash}`);
  }
  const treasury = getAddress(receipt.contractAddress);

  const [owner, paused, configuredFactory, configuredEscrow, configuredToken, configuredQuote, configuredSource] =
    await Promise.all([
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'owner' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'paused' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'ponsFactory' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'feeEscrow' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'launchedToken' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'quoteToken' }),
      publicClient.readContract({ address: treasury, abi: treasuryArtifact.abi, functionName: 'migrationSource' }),
    ]);
  const verified = paused
    && isAddressEqual(owner, initialAdmin)
    && isAddressEqual(configuredFactory, ponsFactory)
    && isAddressEqual(configuredEscrow, feeEscrow)
    && isAddressEqual(configuredToken, ponsToken)
    && isAddressEqual(configuredQuote, quoteToken)
    && isAddressEqual(configuredSource, migrationSource);
  if (!verified) throw new Error('Deployed treasury configuration did not verify');

  const deployment = {
    chainId: connectedChainId,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    treasury,
    initialAdmin,
    migrationSource,
    ponsFactory,
    feeEscrow: getAddress(feeEscrow),
    ponsToken,
    quoteToken,
    creatorFeeRecipientAtDeployment: getAddress(launch.creatorFeeRecipient),
    creatorFeeRecipientChanged: false,
    paused: true,
    transaction: deployHash,
  };
  const output = resolve(process.env.TREASURY_DEPLOYMENT_OUTPUT || '.runtime/treasury-deployment.json');
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, `${JSON.stringify(deployment, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
