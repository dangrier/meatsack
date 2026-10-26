import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RequestStore,
  RespondError,
  type AskSettled,
  type Asker,
  type CreateInput,
  type StoreEvent,
} from './store.js';
import { SERVICE, VERSION, remoteAskSchema, toCreateInput } from './mcp.js';
import { PairError, createPairing, type Pairing, type TokenSource } from './pairing.js';
import {
  MAX_PROOF_BYTES,
  type MeatsackRequest,
  type Outcome,
  type RespondBody,
  type Resolution,
} from './types.js';
import { log } from './log.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Hosts we accept, to block DNS-rebinding from a random web page. */
const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Plenty for an ask; proof only ever travels the other way, in a response. */
const MAX_ASK_BYTES = 64 * 1024;

export interface BackendOptions {
  store: RequestStore;
  port: number;
  host: string;
  /** Called when a new ask arrives and nobody is watching the UI. */
  onNeedsEyeballs?: (url: string) => void;
}

export interface Backend {
  url: string;
  /** Browser tabs watching the UI. */
  viewerCount(): number;
  /** Other meatsack processes leaning on this one as their hub. */
  clientCount(): number;
  /** The LAN door, for phones. */
  pairing: Pairing;
  close(): Promise<void>;
}

/** Everything a request handler needs. */
interface Ctx {
  store: RequestStore;
  /** Browser tabs, desk and phone alike. */
  viewers: Set<http.ServerResponse>;
  /** Other meatsack processes. */
  clients: Set<http.ServerResponse>;
  /** The subset of viewers that came in over the LAN. */
  phones: Set<http.ServerResponse>;
  pairing: Pairing;
}

/** Who we are talking to. */
type Access = 'local' | 'paired';

/**
 * The hub: HTTP + SSE + the prompt UI.
 *
 * Rejects with EADDRINUSE if the port is taken — the caller decides whether to
 * join whoever has it or take another port.
 */
export async function startBackend(opts: BackendOptions): Promise<Backend> {
  const { store } = opts;
  /** Browser tabs. */
  const viewers = new Set<http.ServerResponse>();
  /** Other meatsack processes. They get the same events, but they are not eyeballs. */
  const clients = new Set<http.ServerResponse>();

  /** Browser tabs that arrived over the LAN. Also counted as viewers. */
  const phones = new Set<http.ServerResponse>();

  const ctx = { store, viewers, clients, phones } as Ctx;

  const requestListener: http.RequestListener = (req, res) => {
    handle(req, res, ctx).catch((err) => {
      log.error('request failed', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  };

  const server = http.createServer(requestListener);

  // Keep SSE connections from being reaped mid-wait.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const port = await listen(server, opts.port, opts.host);

  // The same handler, behind a second door we only open on request.
  const pairing = createPairing(requestListener, port);
  ctx.pairing = pairing;
  pairing.onEnd((why) => {
    broadcast([phones], 'unpaired', { reason: why });
    for (const res of phones) res.end();
    phones.clear();
  });
  const url = `http://${opts.host === '::1' ? '[::1]' : opts.host}:${port}`;

  // Push store changes to every open UI and every remote process, and nudge a
  // browser open if nobody is home. A remote meatsack does not count as home.
  store.on('event', (event: StoreEvent) => {
    broadcast([viewers, clients], event.type, event.request);
    if (event.type === 'created' && viewers.size === 0) {
      opts.onNeedsEyeballs?.(`${url}/#${event.request.id}`);
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of [...viewers, ...clients]) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref?.();

  return {
    url,
    viewerCount: () => viewers.size,
    clientCount: () => clients.size,
    pairing,
    close: async () => {
      await pairing.stop('meatsack is shutting down');
      return new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        // Stop accepting first, so a client that hears the goodbye and comes
        // knocking gets a refusal rather than a dying hub.
        server.close(() => resolve());
        broadcast([clients], 'bye', { reason: 'hub shutting down' });
        for (const res of [...viewers, ...clients]) res.end();
        viewers.clear();
        clients.clear();
        phones.clear();
        server.closeAllConnections?.();
      });
    },
  };
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Ctx,
): Promise<void> {
  const { store, viewers, clients, phones, pairing } = ctx;
  const url = new URL(req.url ?? '/', 'http://localhost');

  const door = gate(req, url, pairing);
  if ('status' in door) {
    sendJson(res, door.status, { error: door.error });
    return;
  }
  const access = door.access;

  // The QR link carries the token once. Hand back a cookie so the stylesheet,
  // the script, the event stream and every later reload get in too.
  if (access === 'paired' && door.source !== 'cookie') {
    const cookie = pairing.cookie();
    if (cookie) res.setHeader('Set-Cookie', cookie);
  }

  /** A phone may read the asks and answer them. Nothing else. */
  const deskOnly = (): boolean => {
    if (access === 'local') return false;
    sendJson(res, 403, { error: 'a paired phone cannot do that' });
    return true;
  };

  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/pair') {
    if (deskOnly()) return;
    sendJson(res, 200, pairing.state(phones.size));
    return;
  }

  if (route === 'POST /api/pair') {
    if (deskOnly()) return;
    try {
      const minutes = Number(url.searchParams.get('minutes')) || undefined;
      sendJson(res, 200, await pairing.start(minutes));
    } catch (err) {
      if (err instanceof PairError) sendJson(res, err.statusCode, { error: err.message });
      else throw err;
    }
    return;
  }

  if (route === 'DELETE /api/pair' || route === 'POST /api/pair/stop') {
    if (deskOnly()) return;
    await pairing.stop('you stopped sharing');
    sendJson(res, 200, pairing.state());
    return;
  }

  if (route === 'GET /health') {
    if (deskOnly()) return;
    sendJson(res, 200, {
      service: SERVICE,
      version: VERSION,
      ok: true,
      pid: process.pid,
      pending: store.pendingCount(),
      viewers: viewers.size,
      clients: clients.size,
    });
    return;
  }

  if (route === 'GET /api/requests') {
    sendJson(res, 200, { requests: store.list(), now: Date.now() });
    return;
  }

  // Another meatsack process asking on behalf of its own model.
  if (route === 'POST /api/requests') {
    if (deskOnly()) return;
    let body: unknown;
    try {
      body = await readJson(req, MAX_ASK_BYTES);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    const parsed = remoteAskSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: describeIssues(parsed.error) });
      return;
    }
    const request = store.create(toCreateInput(parsed.data));
    log.info(`remote ask from ${request.asker ?? 'someone'}: ${request.prompt}`);
    sendJson(res, 201, { request });
    return;
  }

  if (route === 'GET /api/events') {
    const asClient = access === 'local' && url.searchParams.get('role') === 'client';
    streamEvents(req, res, store, asClient ? clients : viewers);
    // Phones are viewers too, but we need to find them again when pairing ends.
    if (access === 'paired') {
      phones.add(res);
      req.on('close', () => phones.delete(res));
    }
    return;
  }

  const respondMatch = url.pathname.match(/^\/api\/requests\/([\w-]+)\/respond$/);
  if (respondMatch && req.method === 'POST') {
    const id = respondMatch[1]!;
    let body: RespondBody;
    try {
      body = (await readJson(req, MAX_PROOF_BYTES + 64 * 1024)) as RespondBody;
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    try {
      const updated = store.respond(id, body);
      sendJson(res, 200, { request: updated });
    } catch (err) {
      if (err instanceof RespondError) sendJson(res, err.statusCode, { error: err.message });
      else throw err;
    }
    return;
  }

  // A remote process withdrawing its own ask (its model aborted the call).
  const cancelMatch = url.pathname.match(/^\/api\/requests\/([\w-]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    if (deskOnly()) return;
    const id = cancelMatch[1]!;
    const request = store.get(id);
    if (!request) {
      sendJson(res, 404, { error: 'No such request.' });
      return;
    }
    store.cancel(id);
    sendJson(res, 200, { request });
    return;
  }

  if (req.method === 'GET') {
    await sendStatic(url.pathname, res);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: RequestStore,
  audience: Set<http.ServerResponse>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: sync\ndata: ${JSON.stringify({ requests: store.list(), now: Date.now() })}\n\n`);
  audience.add(res);

  const drop = () => {
    audience.delete(res);
  };
  req.on('close', drop);
  req.on('error', drop);
}

function broadcast(audiences: Set<http.ServerResponse>[], type: string, payload: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const audience of audiences) {
    for (const res of audience) {
      try {
        res.write(frame);
      } catch {
        audience.delete(res);
      }
    }
  }
}

async function sendStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // No climbing out of public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'nope' });
    return;
  }
  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

function readJson(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('that attachment is too big (8MB max)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('expected an object');
        resolve(parsed);
      } catch (err) {
        reject(new Error(`bad JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

/**
 * Who is knocking.
 *
 * Loopback is trusted, exactly as before. Anything else has to come through
 * the pairing door: the right address, during an open pairing, with the token.
 */
function gate(
  req: http.IncomingMessage,
  url: URL,
  pairing: Pairing,
): { access: Access; source?: TokenSource } | { status: number; error: string } {
  if (isLoopback(req.socket.remoteAddress)) {
    if (!hostIsLocal(req.headers.host)) {
      return { status: 403, error: 'meatsack only talks to localhost' };
    }
    return { access: 'local' };
  }

  if (!pairing.isOpen()) {
    return { status: 403, error: 'meatsack is not sharing on the network right now' };
  }
  // The LAN equivalent of the localhost Host check.
  if (!pairing.knowsHost(req.headers.host)) {
    return { status: 403, error: 'wrong address' };
  }
  const source = pairing.tokenFrom(req, url);
  if (!source) {
    return { status: 401, error: 'that link is no good — scan a fresh code' };
  }
  return { access: 'paired', source };
}

function isLoopback(remote?: string): boolean {
  if (!remote) return false;
  const addr = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  return addr === '::1' || addr.startsWith('127.');
}

function hostIsLocal(host?: string): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return SAFE_HOSTS.has(name);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

// --------------------------------------------------------------- hub client

export type HubProbe = 'meatsack' | 'stranger' | 'unreachable';

/** Is whoever holds the port one of us? */
export async function probeHub(url: string, timeoutMs = 400): Promise<HubProbe> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'stranger';
    const body = (await res.json()) as { service?: string };
    return body?.service === SERVICE ? 'meatsack' : 'stranger';
  } catch {
    return 'unreachable';
  }
}

export interface HubAsker extends Asker {
  close(): Promise<void>;
}

/** An ask we posted to the hub and are now parked on. */
interface Outstanding {
  createdAt: number;
  settle(resolution: Resolution): void;
  timer: NodeJS.Timeout;
}

/**
 * The asker for a process that lost the race for the port.
 *
 * Asks go to the hub over HTTP and come back over its SSE stream. Every ask
 * also carries a local timer, because a stream that quietly dies must not turn
 * into a tool call that waits forever.
 */
export async function connectToHub(url: string, onLost: () => void): Promise<HubAsker> {
  const outstanding = new Map<string, Outstanding>();
  const abort = new AbortController();
  let closed = false;
  let lost = false;

  const settle = (id: string, resolution: Resolution): void => {
    const entry = outstanding.get(id);
    if (!entry) return;
    outstanding.delete(id);
    clearTimeout(entry.timer);
    entry.settle(resolution);
  };

  /** Make up a resolution for something the hub never told us about. */
  const locally = (createdAt: number, outcome: Outcome): Resolution => {
    const now = Date.now();
    return { outcome, respondedAt: now, latencyMs: now - createdAt };
  };

  const giveUp = (why: string): void => {
    if (lost || closed) return;
    lost = true;
    log.warn(`lost the meatsack hub at ${url} (${why})`);
    for (const [id, entry] of [...outstanding]) settle(id, locally(entry.createdAt, 'cancelled'));
    onLost();
  };

  const onEvent = (type: string, data: string): void => {
    if (type === 'bye') {
      giveUp('it said goodbye');
      return;
    }
    if (type === 'resolved') {
      const request = JSON.parse(data) as MeatsackRequest;
      if (request.resolution) settle(request.id, request.resolution);
      return;
    }
    if (type === 'sync') {
      // A fresh stream. Reconcile: anything of ours that finished (or that the
      // hub has never heard of, because it is a different hub now) is settled.
      const { requests } = JSON.parse(data) as { requests: MeatsackRequest[] };
      const byId = new Map(requests.map((r) => [r.id, r]));
      for (const [id, entry] of [...outstanding]) {
        const mine = byId.get(id);
        if (!mine) settle(id, locally(entry.createdAt, 'cancelled'));
        else if (mine.status !== 'pending' && mine.resolution) settle(id, mine.resolution);
      }
    }
  };

  // Keep one stream open for the whole process, reconnecting through small
  // hiccups and giving up if the hub really is gone.
  void (async () => {
    let failures = 0;
    while (!closed && !lost) {
      try {
        await readStream(url, abort.signal, (type, data) => {
          if (type === 'sync') failures = 0;
          onEvent(type, data);
        });
      } catch (err) {
        if (closed || abort.signal.aborted) return;
        log.warn(`hub stream wobbled: ${(err as Error).message}`);
      }
      if (closed || lost) return;
      if (++failures > 5) {
        giveUp('the stream will not stay up');
        return;
      }
      await sleep(200 * failures);
    }
  })();

  return {
    async ask(input: CreateInput, signal?: AbortSignal, onCreated?): Promise<AskSettled> {
      if (lost || closed) throw new Error('the meatsack hub went away before we could ask');

      const created = await postJson(`${url}/api/requests`, input);
      const request = (created as { request: MeatsackRequest }).request;
      onCreated?.(request.id, url);

      const resolution = await new Promise<Resolution>((resolve) => {
        // The hub times these out too; this is only here in case the news
        // never reaches us.
        const timer = setTimeout(
          () => settle(request.id, locally(request.createdAt, 'timeout')),
          Math.max(0, request.expiresAt - Date.now()) + 1500,
        );
        timer.unref?.();
        outstanding.set(request.id, { createdAt: request.createdAt, settle: resolve, timer });

        const withdraw = () => {
          // Take it off the human's screen, do not just stop listening.
          void postJson(`${url}/api/requests/${request.id}/cancel`, {}).catch(() => {});
          settle(request.id, locally(request.createdAt, 'cancelled'));
        };
        if (signal?.aborted) withdraw();
        else signal?.addEventListener('abort', withdraw, { once: true });
      });

      return { id: request.id, resolution };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Withdraw whatever we still have on the human's screen.
      const ids = [...outstanding.keys()];
      for (const [id, entry] of [...outstanding]) settle(id, locally(entry.createdAt, 'cancelled'));
      await Promise.all(
        ids.map((id) => postJson(`${url}/api/requests/${id}/cancel`, {}).catch(() => {})),
      );
      abort.abort();
    },
  };
}

/** Read one SSE connection to the end, handing every frame to `onEvent`. */
async function readStream(
  url: string,
  signal: AbortSignal,
  onEvent: (type: string, data: string) => void,
): Promise<void> {
  const res = await fetch(`${url}/api/events?role=client`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`hub said ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended');
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let type = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (type) onEvent(type, data.join('\n'));
    }
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(payload.error ?? `hub said ${res.status}`);
  return payload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
