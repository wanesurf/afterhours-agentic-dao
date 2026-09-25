import { signer } from './chain.js';
import { EXPLORER } from './config.js';

try {
  const { account } = signer();
  console.log(`Pons V2 creatorFeeRecipient: ${account.address}`);
  console.log(`${EXPLORER}/address/${account.address}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
