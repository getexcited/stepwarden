/**
 * Shared types.
 *
 * Everything in lib/ is PURE: no `$`, no imports other than relative ones.
 * That is not a style preference — the function-hooks loader refuses a module
 * that imports anything but a relative path or "claude-code", and its static
 * scanner refuses `$` crossing an import boundary. All engine access therefore
 * lives in hooks/verify.ts, and lib/ is plain data in, plain data out (which
 * also makes it directly unit-testable).
 */

/** What the policy decided, or what actually happened, for one tool call. */
export type Action = "allow" | "flag" | "deny";

/** How the plugin behaves overall. */
export type Mode = "enforce" | "audit" | "off";

/** One Jev signal, named for the audit log and the user-facing reason. */
export interface Signal {
  key: string;
  label: string;
  /** Calibrated probability 0..1 that the answer is "yes". */
  probability: number;
}

/** A parsed Jev verdict for one pending tool call. */
export interface Verdict {
  signals: Signal[];
  /**
   * Intent consistency on the supplied rubric. TypeSafe scores are indexed
   * FROM ZERO, so an N-entry rubric yields 0..N-1 — `max` is N-1, not N.
   */
  intent: { score: number; max: number; confidence: number } | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  model: string | null;
}

export interface Decision {
  action: Action;
  reasons: string[];
  maxProbability: number;
}

/** A previous tool call, as fed back to Jev for contradiction checks. */
export interface HistoryEntry {
  tool: string;
  args: Record<string, unknown>;
  at: number;
}

export interface ResolvedConfig {
  mode: Mode;
  model: string;
  denyAbove: number;
  flagAbove: number;
  /** Intent score at or below this (0-indexed rubric) counts as a flag signal. */
  lowIntentAtOrBelow: number;
  /** Applied when Jev itself fails: the gate's own failure policy. */
  onError: Action;
  /** Applied to a flagged call when no human answer is available. */
  onNoAnswer: Action;
  /** Tools never sent to Jev at all (cheap, read-only, high-volume). */
  skipTools: string[];
  /** Milliseconds to wait for Jev before giving up and applying onError. */
  timeoutMs: number;
  /** Consecutive failures before the gate reports itself degraded. */
  unhealthyAfter: number;
  auditLog: boolean;
  /** Warnings raised while normalizing user input; surfaced at session start. */
  warnings: string[];
}
