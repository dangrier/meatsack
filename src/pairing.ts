import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import QRCode from 'qrcode-svg';
import { log } from './log.js';

/**
 * Letting a phone in.
 *
 * meatsack is localhost-only by default, which a phone cannot reach. Pairing
 * opens a second door — a listener on the LAN address, guarded by a random
 * token — and shuts it again on a timer or when the human says stop. Nothing
 * is exposed until someone deliberately presses the button.
 */

export const DEFAULT_PAIR_MINUTES = clampMinutes(Number(process.env.MEATSACK_PAIR_TTL ?? 60));

const COOKIE_NAME = 'meatsack_k';

export type TokenSource = 'header' | 'query' | 'cookie';

export interface LanAddress {
  address: string;
  iface: string;
}

export interface PairState {
  active: boolean;
  /** The full link encoded in the QR, token and all. */
  url?: string;
  /** Inline SVG of that link. */
  qr?: string;
  address?: string;
  expiresAt?: number;
  /** Phones currently watching. */
  devices?: number;
}

export class PairError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'PairError';
  }
}

export interface Pairing {
  /** Open the LAN door. Idempotent: pairing again returns the same link. */
  start(ttlMinutes?: number): Promise<PairState>;
  /** Shut it. Safe to call when nothing is open. */
  stop(why: string): Promise<void>;
  state(deviceCount?: number): PairState;
  /** Is pairing open right now? */
  isOpen(): boolean;
  /** Where a valid token came from, or null if there wasn't one. */
  tokenFrom(req: http.IncomingMessage, url: URL): TokenSource | null;
  /**
   * A Set-Cookie that keeps the phone in. The link only carries the token on
   * the first hit; stylesheets, scripts and reloads need it too.
   */
  cookie(): string | null;
  /** Is this Host header one of the addresses we are listening on? */
  knowsHost(host?: string): boolean;
  /** Called just before the door shuts, so phones can be told why. */
  onEnd(listener: (why: string) => void): void;
}

export function createPairing(
  requestListener: http.RequestListener,
  port: number,
): Pairing {
  let token: string | null = null;
  let url: string | null = null;
  let qr: string | null = null;
  let address: string | null = null;
  let expiresAt = 0;
  let servers: http.Server[] = [];
  let hosts = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const enders: Array<(why: string) => void> = [];

  const isOpen = () => token !== null && Date.now() < expiresAt;

  async function start(ttlMinutes = DEFAULT_PAIR_MINUTES): Promise<PairState> {
    if (isOpen()) return state();
    await stop('restarting');

    const candidates = lanAddresses();
    if (candidates.length === 0) {
      throw new PairError(
        'This machine has no network address a phone could reach. Join a Wi-Fi network and try again.',
      );
    }

    const fresh = randomBytes(24).toString('base64url');
    const listening: http.Server[] = [];
    const names = new Set<string>();

    for (const candidate of candidates) {
      const server = http.createServer(requestListener);
      server.keepAliveTimeout = 0;
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      try {
        await listenOn(server, port, candidate.address);
        listening.push(server);
        names.add(candidate.address);
        names.add(`${candidate.address}:${port}`);
      } catch (err) {
        log.warn(`cannot share on ${candidate.address} (${(err as Error).message})`);
        server.close();
      }
    }

    if (listening.length === 0) {
      throw new PairError('Could not open the door on any network address.');
    }

    token = fresh;
    servers = listening;
    hosts = names;
    address = candidates[0]!.address;
    url = `http://${address}:${port}/?k=${fresh}`;
    qr = renderQr(url);
    expiresAt = Date.now() + clampMinutes(ttlMinutes) * 60_000;

    timer = setTimeout(() => void stop('the time ran out'), expiresAt - Date.now());
    timer.unref?.();

    log.info(`sharing the prompt UI on ${address}:${port} for ${clampMinutes(ttlMinutes)} minutes`);
    return state();
  }

  async function stop(why: string): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (servers.length === 0 && !token) return;

    // Tell the phones before the floor disappears.
    for (const ender of enders) {
      try {
        ender(why);
      } catch (err) {
        log.warn('pairing end handler blew up', err);
      }
    }

    token = null;
    url = null;
    qr = null;
    address = null;
    expiresAt = 0;
    hosts = new Set();

    const closing = servers;
    servers = [];
    await Promise.all(
      closing.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          }),
      ),
    );
    log.info(`stopped sharing on the network (${why})`);
  }

  function state(deviceCount?: number): PairState {
    if (!isOpen()) return { active: false };
    return {
      active: true,
      url: url!,
      qr: qr!,
      address: address!,
      expiresAt,
      devices: deviceCount ?? 0,
    };
  }

  return {
    start,
    stop,
    state,
    isOpen,
    tokenFrom(req, requestUrl) {
      if (!isOpen() || !token) return null;
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
      if (bearer && sameToken(bearer, token)) return 'header';

      const query = requestUrl.searchParams.get('k');
      if (query && sameToken(query, token)) return 'query';

      const baked = readCookie(req.headers.cookie, COOKIE_NAME);
      if (baked && sameToken(baked, token)) return 'cookie';

      return null;
    },
    cookie() {
      if (!isOpen() || !token) return null;
      const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      // No Secure flag: this is plain HTTP on a local network by design.
      return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
    },
    knowsHost(host) {
      if (!host) return false;
      return hosts.has(host) || hosts.has(host.split(':')[0]!);
    },
    onEnd(listener) {
      enders.push(listener);
    },
  };
}

/** Addresses a phone on the same Wi-Fi could actually dial, best first. */
export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      // Node <18.4 reported family as a number; both shapes show up in the wild.
      const isV4 = info.family === 'IPv4' || (info.family as unknown as number) === 4;
      if (!isV4 || info.internal) continue;
      // Self-assigned addresses mean "no DHCP"; nothing useful lives there.
      if (info.address.startsWith('169.254.')) continue;
      found.push({ address: info.address, iface });
    }
  }
  return found.sort((a, b) => rank(a) - rank(b));
}

/** Wi-Fi and ethernet beat VPN tunnels and docker bridges. */
function rank(addr: LanAddress): number {
  const realInterface = /^(en|eth|wlan|wl|wifi)/i.test(addr.iface);
  const privateRange = isPrivate(addr.address);
  if (realInterface && privateRange) return 0;
  if (privateRange) return 1;
  if (realInterface) return 2;
  return 3;
}

function isPrivate(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function renderQr(content: string): string {
  return new QRCode({
    content,
    padding: 2,
    width: 260,
    height: 260,
    // Medium correction: survives a smudged screen without bloating the grid.
    ecl: 'M',
    color: '#000000',
    background: '#ffffff',
    join: true,
    xmlDeclaration: false,
  }).svg();
}

function listenOn(server: http.Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, address, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sameToken(given: string, actual: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(480, Math.max(1, Math.round(minutes)));
}
