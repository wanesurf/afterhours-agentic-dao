import { startStatusServer } from '../src/status.js';

const port = process.env.PORT || '8766';
const server = await startStatusServer(port);

async function stop() {
  await new Promise(resolve => server.close(resolve));
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await new Promise(() => {});
