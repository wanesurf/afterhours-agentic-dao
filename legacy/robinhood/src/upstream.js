import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAddressEqual } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config.js';

const upstream = resolve('.runtime/after-hours-dip-agent');
function installed() {
  if (!existsSync(resolve(upstream, 'node_modules')) || !existsSync(resolve(upstream, 'mcp/server.js'))) {
    throw new Error('Run npm run setup:upstream to install the pinned After-Hours Dip Agent MCP server');
  }
}

export async function mcpWalletStatus(expectedAddress) {
  installed();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(upstream, 'mcp/server.js')],
    cwd: upstream,
    // The upstream MCP process needs the agent wallet for its status tool, but
    // must not inherit unrelated X, OpenAI, Railway, or deployment secrets.
    env: {
      NODE_ENV: 'production',
      AGENT_PRIVATE_KEY: config.privateKey,
      ORACLE_URL: config.oracleUrl,
      TREASURY_ADDRESS: config.oraclePayTo,
      RPC_URL: config.rpcUrl,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pons-fee-scout', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(t => t.name === 'get_wallet_status')) throw new Error('Expected MCP wallet status tool missing');
    const response = await client.callTool({ name: 'get_wallet_status', arguments: {} });
    if (response.isError) throw new Error(`MCP wallet status failed: ${response.content?.[0]?.text}`);
    const message = response.content?.find(c => c.type === 'text')?.text || '';
    const status = JSON.parse(message.slice(message.indexOf('\n\n') + 2));
    if (!status.agent?.address || !isAddressEqual(status.agent.address, expectedAddress)) {
      throw new Error('MCP agent wallet differs from the configured agent wallet');
    }
    return status.agent;
  } finally {
    await client.close();
  }
}
