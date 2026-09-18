/**
 * Turns a Verdict into allow / flag / deny.
 *
 * Shape of the decision, and why:
 *   - `deny` only on a near-certain single signal. TypeSafe publishes Jev
 *     accuracy below frontier models in several domains, so a hard block on a
 *     merely-probable signal produces false denials exactly where a gate is
 *     most wanted.
 *   - `flag` is the wide middle band, and it is a real tier now: it asks a
 *     human via $.ui.ask. A flag that resolves itself is not a gate.
 *   - low intent-consistency is its own flag trigger, independent of the
 *     probabilities, because "this is not what you said you were doing" is a
 *     different failure from "this looks dangerous".
 */

import type { Decision, ResolvedConfig, Verdict } from "./types";

export function decide(verdict: Verdict, config: ResolvedConfig): Decision {
  const reasons: string[] = [];
  let maxProbability = 0;

  for (const s of verdict.signals) {
    if (s.probability > maxProbability) maxProbability = s.probability;
    if (s.probability >= config.flagAbove) {
      reasons.push(`${s.label} (p=${s.probability.toFixed(2)})`);
    }
  }

  // Scores are zero-indexed: 0 is "contradicts", max is "fully consistent".
  const intent = verdict.intent;
  const lowIntent = intent !== null && intent.score <= config.lowIntentAtOrBelow;
  if (lowIntent) {
    reasons.push(
      `low consistency with the stated plan (${intent.score.toFixed(1)} of ${intent.max}, confidence ${intent.confidence.toFixed(2)})`
    );
  }

  if (maxProbability >= config.denyAbove) {
    return { action: "deny", reasons, maxProbability };
  }
  if (reasons.length > 0) {
    return { action: "flag", reasons, maxProbability };
  }
  return { action: "allow", reasons: [], maxProbability };
}

/** One line summarizing a decision, for the transcript and the audit log. */
export function summarize(tool: string, decision: Decision): string {
  if (decision.reasons.length === 0) {
    return `${tool}: no signal above threshold (max p=${decision.maxProbability.toFixed(2)})`;
  }
  return `${tool}: ${decision.reasons.join("; ")}`;
}

/**
 * What the agent is told when a call is blocked.
 *
 * Two different things block a call, and they are fixed with two different
 * settings. A block that came from nobody being able to answer must not send
 * the user to the thresholds: the thresholds were right, the question just
 * never reached a human. A human's own Block keeps the threshold wording —
 * there, the thresholds are why they were asked at all.
 */
export function denyMessage(tool: string, decision: Decision, askOutcome: string | null): string {
  const nobodyAsked =
    askOutcome === "non-interactive session" || (askOutcome !== null && askOutcome.startsWith("no answer:"));
  if (nobodyAsked) {
    return (
      `Blocked by stepwarden: ${summarize(tool, decision)} — a human had to decide and nobody could be asked ` +
      `(${askOutcome}). Run this in an interactive session to be asked, or set 'if nobody answers' to allow ` +
      "with /plugin configure stepwarden."
    );
  }
  return (
    `Blocked by stepwarden: ${summarize(tool, decision)}. ` +
    "If that is wrong, adjust the thresholds with /plugin configure stepwarden, or run /stepwarden to see the current policy."
  );
}
