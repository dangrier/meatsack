import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Asker, CreateInput } from './store.js';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  type MeatsackResult,
  type Resolution,
} from './types.js';
import { log } from './log.js';

/** Stamped into /health so another process can tell a meatsack from a stranger. */
export const SERVICE = 'meatsack';
export const VERSION = '0.1.0';

const inputSchema = {
  action: z
    .enum(['do', 'answer', 'physical'])
    .describe(
      "Shape of the ask, which decides the buttons the human gets. " +
        "'do' = perform a task (they report done or declined). " +
        "'answer' = supply information only a human has (they type or pick). " +
        "'physical' = change something in the real world (they confirm, with optional safety ack and photo proof).",
    ),
  prompt: z
    .string()
    .min(1)
    .max(300)
    .describe('The ask, in one plain line. This is the headline in the UI. Be specific.'),
  detail: z
    .string()
    .max(4000)
    .optional()
    .describe('Context the human needs: why you are asking, what you already tried, what good looks like.'),
  steps: z
    .array(z.string().min(1).max(300))
    .max(20)
    .optional()
    .describe("Checklist shown as ticks. For 'do' and 'physical'."),
  choices: z
    .array(z.string().min(1).max(200))
    .max(12)
    .optional()
    .describe("Fixed options rendered as buttons. For 'answer'. Omit for a free-text reply."),
  placeholder: z
    .string()
    .max(120)
    .optional()
    .describe("Hint text inside the answer box. For 'answer' with free text."),
  location: z
    .string()
    .max(200)
    .optional()
    .describe("Where the thing is: 'server rack 3', 'kitchen', 'the red button'. For 'physical'."),
  hazard: z
    .enum(['none', 'low', 'medium', 'high'])
    .optional()
    .describe(
      "Risk of the physical act. Anything above 'none' makes the human tick a safety acknowledgement before confirming. For 'physical'.",
    ),
  requireProof: z
    .boolean()
    .optional()
    .describe('Make the human attach a photo or file before they can confirm. Returned to you as an image.'),
  urgency: z.enum(['low', 'normal', 'high']).optional().describe('How loudly the UI should shout.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(5)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`How long to wait for a human. Default ${DEFAULT_TIMEOUT_SECONDS}s.`),
};

/**
 * The tool's arguments as one validator, plus `asker`, which the tool fills in
 * from the MCP client name but a remote meatsack has to send explicitly.
 *
 * `POST /api/requests` runs the same thing, so the HTTP door cannot create an
 * ask the tool could not.
 */
export const remoteAskSchema = z.object(inputSchema).extend({
  asker: z.string().min(1).max(80).optional(),
});

export type AskArgs = z.infer<typeof remoteAskSchema>;

/** Drop the fields that make no sense for the chosen action. */
export function toCreateInput(args: AskArgs): CreateInput {
  const physical = args.action === 'physical';
  const question = args.action === 'answer';
  return {
    action: args.action,
    prompt: args.prompt,
    detail: args.detail,
    // Checklists make no sense on a question.
    steps: question ? undefined : args.steps,
    choices: question ? args.choices : undefined,
    placeholder: question ? args.placeholder : undefined,
    location: physical ? args.location : undefined,
    hazard: physical ? (args.hazard ?? 'none') : 'none',
    requireProof: args.requireProof ?? false,
    urgency: args.urgency ?? 'normal',
    timeoutSeconds: args.timeoutSeconds,
    asker: args.asker,
  };
}

const outputSchema = {
  id: z.string(),
  action: z.enum(['do', 'answer', 'physical']),
  outcome: z
    .enum(['done', 'answered', 'declined', 'timeout', 'cancelled'])
    .describe('What actually happened. Only done/answered mean the human came through.'),
  answer: z.string().optional().describe("Free text the human typed (the answer, or notes)."),
  choice: z.string().optional().describe('The option the human picked.'),
  acknowledged: z.boolean().optional().describe('Human ticked the safety acknowledgement.'),
  proofAttached: z.boolean().describe('A photo/file came back; it is in the content as an image.'),
  waitedSeconds: z.number().describe('How long the human took.'),
};

const DESCRIPTION = [
  'Ask a human being to do something you cannot do yourself, and wait for their reply.',
  'Opens a prompt window on the human\'s machine and blocks until they respond or it times out.',
  '',
  'Pick the action that matches the ask:',
  '  do       — a task in the world of software or paperwork ("restart the staging box", "approve this PR")',
  '  answer   — a fact, judgement or decision only they hold ("which customer is this for?", free text or choices)',
  '  physical — moving atoms ("unplug the blue cable", "check the printer"), with optional hazard warning and photo proof',
  '',
  'Humans are slow and occasionally say no. Always check `outcome` before you carry on:',
  'declined, timeout and cancelled all mean the thing did NOT happen.',
  'Use this sparingly — only when there is no tool, API or file that could answer instead.',
].join('\n');

export function createMcpServer(asker: Asker): McpServer {
  const server = new McpServer(
    { name: SERVICE, version: VERSION },
    {
      instructions:
        'meatsack puts a human in the loop. One tool, three actions: do (perform a task), ' +
        'answer (supply information), physical (change the real world). Calls block until the ' +
        'human responds, so set timeoutSeconds to something realistic and handle refusals.',
    },
  );

  server.registerTool(
    'meatsack',
    {
      title: 'Ask a human',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const input = toCreateInput({ ...(args as AskArgs), asker: clientName(server) });

      const { id, resolution } = await asker.ask(input, extra?.signal, (askId, url) =>
        log.info(`asking a human (${input.action}): ${input.prompt} → ${url}/#${askId}`),
      );
      log.info(`human said: ${resolution.outcome} (${Math.round(resolution.latencyMs / 1000)}s)`);

      return buildToolResult(id, input, resolution);
    },
  );

  return server;
}

function buildToolResult(id: string, input: CreateInput, resolution: Resolution) {
  const request = { action: input.action, prompt: input.prompt.trim() };
  const waitedSeconds = Math.round(resolution.latencyMs / 100) / 10;
  const structured: MeatsackResult = {
    id,
    action: request.action,
    outcome: resolution.outcome,
    proofAttached: Boolean(resolution.proof),
    waitedSeconds,
  };
  if (resolution.text) structured.answer = resolution.text;
  if (resolution.choice) structured.choice = resolution.choice;
  if (resolution.acknowledged !== undefined) structured.acknowledged = resolution.acknowledged;

  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  > = [{ type: 'text', text: summarise(request, resolution, waitedSeconds) }];

  if (resolution.proof) {
    if (resolution.proof.mimeType.startsWith('image/')) {
      content.push({
        type: 'image',
        data: resolution.proof.data,
        mimeType: resolution.proof.mimeType,
      });
    } else {
      content.push({
        type: 'text',
        text: `[proof attached: ${resolution.proof.filename ?? 'file'} (${resolution.proof.mimeType}), not an image so not inlined]`,
      });
    }
  }

  return { content, structuredContent: structured as unknown as Record<string, unknown> };
}

function summarise(
  request: { action: CreateInput['action']; prompt: string },
  r: Resolution,
  waited: number,
): string {
  const took = `after ${waited}s`;
  switch (r.outcome) {
    case 'answered': {
      const parts: string[] = [];
      if (r.choice) parts.push(`chose "${r.choice}"`);
      if (r.text) parts.push(r.choice ? `and added: ${r.text}` : r.text);
      return `HUMAN ANSWERED ${took}: ${parts.join(' ') || '(empty)'}`;
    }
    case 'done':
      return [
        `HUMAN DID IT ${took}: "${request.prompt}" is done.`,
        r.text ? `Their notes: ${r.text}` : null,
        r.acknowledged ? 'They acknowledged the safety warning.' : null,
        r.proof ? 'They attached proof (below).' : null,
      ]
        .filter(Boolean)
        .join(' ');
    case 'declined':
      return `HUMAN DECLINED ${took}. "${request.prompt}" did NOT happen.${r.text ? ` Reason: ${r.text}` : ' No reason given.'} Do not pretend it did; find another way or stop and tell them why it mattered.`;
    case 'timeout':
      return `NO HUMAN ${took}. Nobody answered "${request.prompt}", so it did NOT happen. Carry on without it, or stop and say you are blocked on a person.`;
    case 'cancelled':
      return `REQUEST WITHDRAWN ${took}. "${request.prompt}" was never answered.`;
  }
}

function clientName(server: McpServer): string | undefined {
  try {
    return server.server.getClientVersion()?.name;
  } catch {
    return undefined;
  }
}
