import { parseAbi, isAddress, formatEther, formatUnits } from 'viem';
import { publicClient, signer } from './chain.js';
import { PONS_FACTORY, USDG, CHAIN_ID } from './config.js';

const factoryAbi = parseAbi([
  'function canLaunch(address) view returns (bool)',
  'function approvedPairTokens(address) view returns (bool)',
  'function pairTokenEconomics(address) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  'function launchFee() view returns (uint256)',
]);

try {
  const launcher = process.env.PONS_LAUNCHER_ADDRESS || signer().account.address;
  if (!isAddress(launcher)) throw new Error('Set a valid PONS_LAUNCHER_ADDRESS');
  const [id, allowed, approved, economics, fee] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'canLaunch', args: [launcher] }),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'approvedPairTokens', args: [USDG] }),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'pairTokenEconomics', args: [USDG] }),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: 'launchFee' }),
  ]);
  if (id !== CHAIN_ID) throw new Error(`Wrong network ${id}; expected ${CHAIN_ID}`);
  console.log(`Pons launcher: ${launcher}`);
  console.log(`Can launch: ${allowed}; USDG pair approved: ${approved}`);
  console.log(`Pons launch fee: ${formatEther(fee)} ETH`);
  console.log(`USDG phantom quote: ${formatUnits(economics[0], economics[2])}; graduation threshold: ${formatUnits(economics[1], economics[2])}`);
  if (!allowed || !approved || economics[2] !== 6) process.exitCode = 1;
} catch (e) { console.error(`Pons preflight failed: ${e.message}`); process.exitCode = 1; }
