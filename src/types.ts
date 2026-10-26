/**
 * Shared vocabulary between the MCP tool, the backend and the prompt UI.
 *
 * One tool (`meatsack`) with three actions. The action decides what the human
 * is being asked for, and therefore which controls the prompt UI renders and
 * which response fields are required.
 */

/** What kind of favour we are asking the meatsack for. */
export type MeatsackAction =
  /** Do something: a task to perform, reported back as done or declined. */
  | 'do'
  /** Answer something: information only the human has. */
  | 'answer'
  /** Affect the physical world: move atoms, optionally with proof. */
  | 'physical';

export const ACTIONS: MeatsackAction[] = ['do', 'answer', 'physical'];

export type Urgency = 'low' | 'normal' | 'high';
export type Hazard = 'none' | 'low' | 'medium' | 'high';

export type RequestStatus = 'pending' | 'resolved' | 'cancelled';

export type Outcome =
  /** Task performed / physical act carried out. */
  | 'done'
  /** Question answered. */
  | 'answered'
  /** Human said no. */
  | 'declined'
  /** Nobody responded in time. */
  | 'timeout'
  /** The model (or the server) withdrew the request. */
  | 'cancelled';

export interface Proof {
  /** e.g. image/jpeg, image/png */
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
  filename?: string;
}

export interface Resolution {
  outcome: Outcome;
  /** Free text: the answer, or notes about how the task went. */
  text?: string;
  /** The option the human picked, when `choices` were offered. */
  choice?: string;
  /** Photo / file the human attached as evidence. */
  proof?: Proof;
  /** Human confirmed they read the safety note (physical + hazard). */
  acknowledged?: boolean;
  respondedAt: number;
  /** Milliseconds from asking to answering. */
  latencyMs: number;
}

export interface MeatsackRequest {
  id: string;
  action: MeatsackAction;
  /** The one-line ask, shown as the headline in the UI. */
  prompt: string;
  /** Extra context, shown under the headline. */
  detail?: string;
  /** Checklist, for `do` and `physical`. */
  steps?: string[];
  /** Fixed options, for `answer`. */
  choices?: string[];
  /** Hint text in the answer box, for `answer`. */
  placeholder?: string;
  /** Where the atoms are, for `physical`. */
  location?: string;
  /** Danger level, for `physical`. Anything but `none` needs an acknowledgement. */
  hazard: Hazard;
  /** Require a photo / file before the human can confirm, for `physical`. */
  requireProof: boolean;
  /** Who is asking (model / agent name), for the UI. */
  asker?: string;
  urgency: Urgency;
  createdAt: number;
  expiresAt: number;
  status: RequestStatus;
  resolution?: Resolution;
}

/** What the browser POSTs back. */
export interface RespondBody {
  outcome: 'done' | 'answered' | 'declined';
  text?: string;
  choice?: string;
  acknowledged?: boolean;
  proof?: Proof;
}

/** Sent to the model when the tool call finishes. */
export interface MeatsackResult {
  id: string;
  action: MeatsackAction;
  outcome: Outcome;
  answer?: string;
  choice?: string;
  notes?: string;
  acknowledged?: boolean;
  proofAttached: boolean;
  waitedSeconds: number;
}

export const MAX_PROOF_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 3600;
