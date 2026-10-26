#!/usr/bin/env node
/**
 * Fills the prompt UI with one of each kind of ask so you can click around.
 *
 *   npm run build && npm run demo
 *
 * Leaves the asks pending for an hour. Answer them in the browser and the
 * replies print here, exactly as a model would receive them.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = process.env.MEATSACK_PORT ?? '7777';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'index.js')],
  env: { ...process.env, MEATSACK_PORT: PORT, MEATSACK_OPEN: process.env.MEATSACK_OPEN ?? '0' },
  stderr: 'inherit',
  cwd: ROOT,
});

const client = new Client({ name: 'meatsack-demo', version: '0.1.0' });
await client.connect(transport);

const asks = [
  {
    action: 'answer',
    prompt: 'Which environment is the checkout bug on?',
    detail: 'The stack trace mentions a feature flag that is only on in one of these.',
    choices: ['production', 'staging', 'both'],
    placeholder: 'Anything else I should know?',
    urgency: 'normal',
    timeoutSeconds: 3600,
  },
  {
    action: 'do',
    prompt: 'Approve the release PR so I can carry on',
    detail: 'Everything is green. I cannot click approve on my own pull request.',
    steps: ['Open the PR', 'Skim the diff', 'Hit Approve'],
    urgency: 'high',
    timeoutSeconds: 3600,
  },
  {
    action: 'physical',
    prompt: 'Unplug the blue cable from switch port 4',
    detail: 'Port 4 is flapping and I cannot reach it over the network.',
    location: 'server cupboard, second rack from the door',
    steps: ['Find the blue cable in port 4', 'Pull it out', 'Wait 10 seconds'],
    hazard: 'medium',
    requireProof: true,
    timeoutSeconds: 3600,
  },
];

console.log(`\n🧍 meatsack demo — open http://127.0.0.1:${PORT}\n`);

await Promise.all(
  asks.map(async (args) => {
    const result = await client.callTool({ name: 'meatsack', arguments: args }, undefined, {
      timeout: 3_600_000,
    });
    console.log(`\n── reply to "${args.prompt}" ──`);
    for (const block of result.content) {
      console.log(block.type === 'text' ? block.text : `[${block.type}: ${block.mimeType}]`);
    }
    console.log(JSON.stringify(result.structuredContent, null, 2));
  }),
);

console.log('\nAll answered. Bye.\n');
await client.close();
process.exit(0);
