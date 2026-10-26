#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RequestStore, localAsker, type Asker } from './store.js';
import { connectToHub, probeHub, startBackend } from './http.js';
import { createMcpServer } from './mcp.js';
import { createOpener } from './open.js';
import { log } from './log.js';

const PORT = Number(process.env.MEATSACK_PORT ?? 7777);
const HOST = process.env.MEATSACK_HOST ?? '127.0.0.1';
/** MEATSACK_OPEN=0 stops us hijacking the human's browser. */
const AUTO_OPEN = process.env.MEATSACK_OPEN !== '0';
/** --ui-only runs just the backend + UI, handy for poking at it by hand. */
const UI_ONLY = process.argv.includes('--ui-only');

const WANTED_URL = `http://${HOST === '::1' ? '[::1]' : HOST}:${PORT}`;

/**
 * Who we are this run.
 *
 * stdio MCP gives every client its own server process, so the first one to
 * bind the port owns the prompt UI (the hub) and the rest post their asks to
 * it (clients). One window, one port, every session's asks in it.
 */
interface Role {
  kind: 'hub' | 'client';
  url: string;
  asker: Asker;
  close(): Promise<void>;
}

const open = createOpener(AUTO_OPEN);

let role: Role;
let closing = false;
let reelection: Promise<void> | null = null;

/** Stable face for the MCP tool, so a change of hub mid-session is invisible. */
const relay: Asker = {
  async ask(input, signal, onCreated) {
    if (reelection) await reelection;
    return role.asker.ask(input, signal, onCreated);
  },
};

async function beHub(port: number): Promise<Role> {
  const store = new RequestStore();
  const backend = await startBackend({ store, port, host: HOST, onNeedsEyeballs: open });
  return {
    kind: 'hub',
    url: backend.url,
    asker: localAsker(store, () => backend.url),
    close: async () => {
      const leaning = backend.clientCount();
      if (leaning > 0) {
        // We cannot stay: an MCP host kills its server process on disconnect.
        // Best we can do is say goodbye loudly enough for them to re-elect.
        log.warn(`${leaning} other session(s) were using this window; they will take it over`);
      }
      // Unblock any tool call still parked on a human.
      store.cancelAll();
      await backend.close();
    },
  };
}

async function beClient(url: string): Promise<Role> {
  const hub = await connectToHub(url, onHubLost);
  return { kind: 'client', url, asker: hub, close: () => hub.close() };
}

/**
 * Bind the port, or join whoever has it.
 *
 * "Busy but nobody answering" is the interesting case: that is usually a hub
 * that has just died and whose port is a moment from being free, so we wait
 * and try again rather than wandering off to a port of our own.
 */
async function takeRole(): Promise<Role> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await beHub(PORT);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }

    const who = await probeHub(WANTED_URL);
    if (who === 'meatsack') return beClient(WANTED_URL);
    if (who === 'stranger') {
      log.warn(`port ${PORT} belongs to something that is not meatsack, taking a free one`);
      return beHub(0);
    }
    await sleep(100 + Math.random() * 250);
  }

  log.warn(`could not work out who owns port ${PORT}, running alone on a free one`);
  return beHub(0);
}

/** The hub died under us. Try to become it, or join whoever got there first. */
function onHubLost(): void {
  if (closing || reelection) return;
  reelection = (async () => {
    try {
      await role.close().catch(() => {});
      role = await takeRole();
      log.info(
        role.kind === 'hub'
          ? `took over the prompt UI at ${role.url}`
          : `joined a new hub at ${role.url}`,
      );
    } catch (err) {
      log.error('could not find or become a hub', err);
    } finally {
      reelection = null;
    }
  })();
}

async function main(): Promise<void> {
  // --ui-only is for a human poking at the UI by hand, so it never hides
  // behind someone else's hub.
  role = UI_ONLY ? await beHub(PORT).catch(() => beHub(0)) : await takeRole();

  log.info(
    role.kind === 'hub'
      ? `prompt UI at ${role.url}`
      : `sharing the prompt UI at ${role.url} (another session got there first)`,
  );

  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info(`shutting down (${why})`);
    await role.close().catch((err) => log.warn('messy shutdown', err));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (UI_ONLY) {
    log.info('ui-only mode: no MCP server, nothing will ask you anything');
    return;
  }

  const server = createMcpServer(relay);
  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('client disconnected');
  await server.connect(transport);
  log.info('MCP server ready on stdio');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
