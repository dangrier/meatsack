import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_PROOF_BYTES,
  MAX_TIMEOUT_SECONDS,
  type MeatsackRequest,
  type Proof,
  type RespondBody,
  type Resolution,
  type Outcome,
} from './types.js';

export interface CreateInput {
  action: MeatsackRequest['action'];
  prompt: string;
  detail?: string;
  steps?: string[];
  choices?: string[];
  placeholder?: string;
  location?: string;
  hazard?: MeatsackRequest['hazard'];
  requireProof?: boolean;
  asker?: string;
  urgency?: MeatsackRequest['urgency'];
  timeoutSeconds?: number;
}

export type StoreEvent =
  | { type: 'created'; request: MeatsackRequest }
  | { type: 'resolved'; request: MeatsackRequest };

/** An ask that has stopped being pending, one way or another. */
export interface AskSettled {
  id: string;
  resolution: Resolution;
}

/**
 * Somewhere to put an ask and block on it.
 *
 * Two of these exist: the local one below (we own the UI) and the hub client in
 * `http.ts` (another process owns the UI and we post asks to it). The MCP tool
 * cannot tell the difference.
 */
export interface Asker {
  ask(
    input: CreateInput,
    signal?: AbortSignal,
    onCreated?: (id: string, url: string) => void,
  ): Promise<AskSettled>;
}

/** The asker for a process that owns the store and the prompt UI. */
export function localAsker(store: RequestStore, url: () => string): Asker {
  return {
    async ask(input, signal, onCreated) {
      const request = store.create(input);
      onCreated?.(request.id, url());
      return { id: request.id, resolution: await store.wait(request.id, signal) };
    },
  };
}

/** A rejected response, with a reason the UI can show. */
export class RespondError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'RespondError';
  }
}

/**
 * Holds every ask in memory and parks the MCP tool call until a human
 * responds (or the clock runs out).
 */
export class RequestStore extends EventEmitter {
  private readonly requests = new Map<string, MeatsackRequest>();
  private readonly waiters = new Map<string, (r: Resolution) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Keep the last N resolved asks so the UI keeps a little history. */
  private readonly historyLimit = 50;

  create(input: CreateInput): MeatsackRequest {
    const timeoutSeconds = clamp(
      input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      5,
      MAX_TIMEOUT_SECONDS,
    );
    const now = Date.now();
    const request: MeatsackRequest = {
      id: randomUUID(),
      action: input.action,
      prompt: input.prompt.trim(),
      detail: input.detail?.trim() || undefined,
      steps: input.steps?.length ? input.steps : undefined,
      choices: input.choices?.length ? input.choices : undefined,
      placeholder: input.placeholder,
      location: input.location?.trim() || undefined,
      hazard: input.hazard ?? 'none',
      requireProof: input.requireProof ?? false,
      asker: input.asker?.trim() || undefined,
      urgency: input.urgency ?? 'normal',
      createdAt: now,
      expiresAt: now + timeoutSeconds * 1000,
      status: 'pending',
    };
    this.requests.set(request.id, request);
    this.prune();
    this.emit('event', { type: 'created', request } satisfies StoreEvent);
    return request;
  }

  /**
   * Resolves when a human responds, the request times out, or `signal` aborts
   * (the model gave up / the client disconnected).
   */
  wait(id: string, signal?: AbortSignal): Promise<Resolution> {
    const request = this.requests.get(id);
    if (!request) return Promise.reject(new Error(`unknown request ${id}`));
    if (request.status !== 'pending' && request.resolution) {
      return Promise.resolve(request.resolution);
    }

    return new Promise<Resolution>((resolve) => {
      this.waiters.set(id, resolve);

      const msLeft = Math.max(0, request.expiresAt - Date.now());
      const timer = setTimeout(() => this.finish(id, { outcome: 'timeout' }), msLeft);
      // Never hold the process open just for a pending ask.
      timer.unref?.();
      this.timers.set(id, timer);

      if (signal) {
        if (signal.aborted) {
          this.finish(id, { outcome: 'cancelled' });
          return;
        }
        signal.addEventListener('abort', () => this.finish(id, { outcome: 'cancelled' }), {
          once: true,
        });
      }
    });
  }

  /** Called by the HTTP layer when the human presses a button. */
  respond(id: string, body: RespondBody): MeatsackRequest {
    const request = this.requests.get(id);
    if (!request) throw new RespondError('No such request.', 404);
    if (request.status !== 'pending') {
      throw new RespondError('That one is already closed.', 409);
    }
    if (Date.now() > request.expiresAt) {
      this.finish(id, { outcome: 'timeout' });
      throw new RespondError('Too slow — that request expired.', 410);
    }

    validate(request, body);

    const resolution: Partial<Resolution> = {
      outcome: body.outcome,
      text: body.text?.trim() || undefined,
      choice: body.choice,
      acknowledged: body.acknowledged ?? undefined,
      proof: body.proof,
    };
    this.finish(id, resolution as Resolution);
    return request;
  }

  /** Withdraw a pending ask (abort, shutdown). */
  cancel(id: string): void {
    const request = this.requests.get(id);
    if (!request || request.status !== 'pending') return;
    this.finish(id, { outcome: 'cancelled' });
  }

  cancelAll(): void {
    for (const [id, request] of this.requests) {
      if (request.status === 'pending') this.finish(id, { outcome: 'cancelled' });
    }
  }

  get(id: string): MeatsackRequest | undefined {
    return this.requests.get(id);
  }

  /** Pending first (oldest first), then recent history (newest first). */
  list(): MeatsackRequest[] {
    const all = [...this.requests.values()];
    const pending = all.filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const rest = all.filter((r) => r.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt);
    return [...pending, ...rest];
  }

  pendingCount(): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.status === 'pending') n++;
    return n;
  }

  private finish(
    id: string,
    partial: Resolution | { outcome: Outcome },
  ): MeatsackRequest | undefined {
    const request = this.requests.get(id);
    // Whoever gets here first wins: a late abort must not undo a real answer.
    if (!request || request.status !== 'pending') return request;

    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    const now = Date.now();
    const resolution: Resolution = {
      ...(partial as Resolution),
      respondedAt: now,
      latencyMs: now - request.createdAt,
    };

    request.resolution = resolution;
    request.status = resolution.outcome === 'cancelled' ? 'cancelled' : 'resolved';

    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.(resolution);

    this.emit('event', { type: 'resolved', request } satisfies StoreEvent);
    return request;
  }

  /** Drop the oldest resolved asks so memory stays flat in long sessions. */
  private prune(): void {
    const resolved = [...this.requests.values()]
      .filter((r) => r.status !== 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = resolved.length - this.historyLimit;
    for (let i = 0; i < excess; i++) {
      const victim = resolved[i];
      if (victim) this.requests.delete(victim.id);
    }
  }
}

/** Action-specific rules. The UI enforces these too; this is the real gate. */
function validate(request: MeatsackRequest, body: RespondBody): void {
  if (body.outcome === 'declined') return; // Saying no never needs paperwork.

  if (request.action === 'answer') {
    if (body.outcome !== 'answered') {
      throw new RespondError('A question needs an answer, not a "done".');
    }
    const hasChoice = typeof body.choice === 'string' && body.choice.length > 0;
    const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
    if (!hasChoice && !hasText) throw new RespondError('Type an answer or pick an option.');
    if (hasChoice && request.choices && !request.choices.includes(body.choice!)) {
      throw new RespondError('That option was not on the list.');
    }
  } else {
    if (body.outcome !== 'done') {
      throw new RespondError('A task closes as done or declined.');
    }
  }

  if (request.hazard !== 'none' && body.acknowledged !== true) {
    throw new RespondError('Tick the safety box first.');
  }
  if (request.requireProof && !body.proof) {
    throw new RespondError('This one needs a photo as proof.');
  }
  if (body.proof) validateProof(body.proof);
}

function validateProof(proof: Proof): void {
  if (!proof.mimeType || !/^[\w.+-]+\/[\w.+-]+$/.test(proof.mimeType)) {
    throw new RespondError('That attachment has a strange type.');
  }
  if (typeof proof.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(proof.data)) {
    throw new RespondError('That attachment is not valid base64.');
  }
  const bytes = Math.floor((proof.data.length * 3) / 4);
  if (bytes > MAX_PROOF_BYTES) throw new RespondError('That attachment is too big (8MB max).');
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
