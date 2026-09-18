/**
 * Turns the raw `options` object that `register(on, options)` receives into a
 * validated ResolvedConfig.
 *
 * The values come from plugin.json's `userConfig` (settings.json
 * `pluginConfigs[<plugin>].options`, sensitive ones from secure storage). The
 * engine checks each value's *type* before the module loads, but nothing
 * checks that a number is in range or that the thresholds are ordered — so
 * that happens here.
 *
 * Every bad value is repaired to a safe default and recorded in `warnings`
 * rather than thrown. A typo in one field must not take the gate down; but it
 * also must not be silent, so hooks/verify.ts prints the warnings once at
 * session start.
 */

import type { Action, Mode, ResolvedConfig } from "./types";

/** Raw options as the engine hands them over. */
export type RawOptions = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>;

export const DEFAULTS: ResolvedConfig = {
  // Audit, not enforce: an installed plugin must not block anyone's work on
  // thresholds that have never seen their traffic. It verifies and records
  // every call from the first minute, and the user turns the gate on with
  // /stepwarden enforce when the numbers look right.
  mode: "audit",
  model: "jev-latest",
  // Jev's own published accuracy sits below frontier models in several
  // domains, so the shipped posture is "deny rarely, ask often": only a
  // near-certain signal blocks outright, and the middle band asks a human
  // rather than deciding for them.
  denyAbove: 0.9,
  flagAbove: 0.6,
  lowIntentAtOrBelow: 1,
  onError: "allow",
  onNoAnswer: "allow",
  skipTools: ["Read", "Glob", "Grep", "TodoWrite", "NotebookRead", "ListAgents", "TaskOutput"],
  timeoutMs: 5000,
  unhealthyAfter: 3,
  auditLog: true,
  warnings: [],
};

/**
 * "flag" is deliberately absent: these two settings say what to do when a human
 * CANNOT be asked, so "ask a human" is not an answer. A stored "flag" from an
 * older config falls back to the default and warns.
 */
const FALLBACK_ACTIONS: Action[] = ["allow", "deny"];
const MODES: Mode[] = ["enforce", "audit", "off"];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: T[], field: string, warnings: string[]): T | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  warnings.push(`${field}: "${s}" is not one of ${allowed.join(", ")} — using the default`);
  return undefined;
}

function probability(v: unknown, field: string, warnings: string[]): number | undefined {
  // Number("") and Number("  ") are both 0, which would silently set a
  // threshold of zero and make the gate block everything.
  if (v === undefined || v === null || typeof v === "boolean") return undefined;
  if (typeof v !== "number" && String(v).trim() === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) {
    warnings.push(`${field}: "${String(v)}" is not a number — using the default`);
    return undefined;
  }
  if (n < 0 || n > 1) {
    warnings.push(`${field}: ${n} is outside 0..1 — using the default`);
    return undefined;
  }
  return n;
}

function integer(v: unknown, field: string, min: number, max: number, warnings: string[]): number | undefined {
  if (v === undefined || v === null || typeof v === "boolean") return undefined;
  if (typeof v !== "number" && String(v).trim() === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) {
    warnings.push(`${field}: "${String(v)}" is not a number — using the default`);
    return undefined;
  }
  const r = Math.round(n);
  if (r < min || r > max) {
    warnings.push(`${field}: ${n} is outside ${min}..${max} — using the default`);
    return undefined;
  }
  return r;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "false" || s === "no" || s === "off" || s === "0") return false;
    if (s === "true" || s === "yes" || s === "on" || s === "1") return true;
  }
  return fallback;
}

/** Accepts a real list, or a comma/whitespace-separated string. */
function toolList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter((x) => x.length > 0);
    return out.length > 0 ? out : [];
  }
  const s = asString(v);
  if (s === undefined) return undefined;
  if (s.toLowerCase() === "none") return [];
  const out = s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : [];
}

export function resolveConfig(options: RawOptions | undefined): ResolvedConfig {
  const o = options ?? {};
  const warnings: string[] = [];

  const denyAbove = probability(o.denyAbove, "denyAbove", warnings) ?? DEFAULTS.denyAbove;
  let flagAbove = probability(o.flagAbove, "flagAbove", warnings) ?? DEFAULTS.flagAbove;

  // An inverted pair would make `flag` unreachable and quietly turn the middle
  // band into a deny. Repair it loudly instead of honouring a typo.
  if (flagAbove > denyAbove) {
    // Setting flagAbove == denyAbove would leave an ask band of zero width, so
    // the "repair" would still mean every flagged call is really a block.
    // Leave a real band below the block threshold instead.
    const repaired = Math.max(0, Math.round((denyAbove - 0.1) * 100) / 100);
    warnings.push(
      `flagAbove (${flagAbove}) is above denyAbove (${denyAbove}), which would leave no band in which you are asked — lowering flagAbove to ${repaired}`
    );
    flagAbove = repaired;
  }

  const skip = toolList(o.skipTools);

  return {
    mode: oneOf(o.mode, MODES, "mode", warnings) ?? DEFAULTS.mode,
    model: asString(o.model) ?? DEFAULTS.model,
    denyAbove,
    flagAbove,
    lowIntentAtOrBelow:
      integer(o.lowIntentAtOrBelow, "lowIntentAtOrBelow", 0, 4, warnings) ?? DEFAULTS.lowIntentAtOrBelow,
    onError: oneOf(o.onError, FALLBACK_ACTIONS, "onError", warnings) ?? DEFAULTS.onError,
    onNoAnswer: oneOf(o.onNoAnswer, FALLBACK_ACTIONS, "onNoAnswer", warnings) ?? DEFAULTS.onNoAnswer,
    skipTools: skip ?? DEFAULTS.skipTools,
    timeoutMs: integer(o.timeoutMs, "timeoutMs", 500, 30000, warnings) ?? DEFAULTS.timeoutMs,
    unhealthyAfter: integer(o.unhealthyAfter, "unhealthyAfter", 1, 100, warnings) ?? DEFAULTS.unhealthyAfter,
    auditLog: toBool(o.auditLog, DEFAULTS.auditLog),
    warnings,
  };
}

/** The API key, wherever the user chose to put it. */
export function resolveApiKey(
  options: RawOptions | undefined,
  envKey: string | undefined
): { key: string | null; source: "plugin-config" | "environment" | "none" } {
  const fromOptions = asString(options?.TYPESAFE_API_KEY);
  if (fromOptions) return { key: fromOptions, source: "plugin-config" };
  const fromEnv = asString(envKey);
  if (fromEnv) return { key: fromEnv, source: "environment" };
  return { key: null, source: "none" };
}

/** What a mode means, in the one line the command and the status print. */
export function describeMode(mode: Mode): string {
  if (mode === "enforce") return "risky calls are blocked or put to you";
  if (mode === "audit") return "every decision is logged, nothing is blocked";
  return "nothing is verified";
}

/** What `/stepwarden <arg>` was asking for. */
export type CommandArg =
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "mode"; mode: Mode }
  | { kind: "error"; message: string };

/**
 * Reads the argument of `/stepwarden`.
 *
 * No argument reports status. An unknown word is an error rather than a silent
 * no-op: a typo'd switch that quietly did nothing would leave the gate in
 * exactly the state they meant to leave.
 *
 * `toggle` goes to enforce from audit, and to audit from anywhere else —
 * turning a gate that is off all the way up to blocking in one word is not
 * something a toggle should do.
 */
export function parseCommandArg(raw: string, current: Mode): CommandArg {
  const word = raw.trim().toLowerCase();
  if (word.length === 0) return { kind: "status" };
  if (word === "help" || word === "?") return { kind: "help" };
  if (word === "toggle") return { kind: "mode", mode: current === "audit" ? "enforce" : "audit" };
  const hit = MODES.find((m) => m === word);
  if (hit) return { kind: "mode", mode: hit };
  return {
    kind: "error",
    message:
      `"${raw.trim()}" is not something /stepwarden takes. Try enforce, audit, off, toggle, ` +
      "or help — or /stepwarden on its own for status.",
  };
}

/**
 * `/stepwarden help`: the whole surface on one screen.
 *
 * Deliberately not the same text as the status command. Status answers "what is
 * happening right now"; this answers "what can I do, and how do I set the key",
 * which is what someone types `help` for. Defaults come from DEFAULTS so the
 * two cannot drift apart.
 */
export function helpText(): string {
  // Built as pairs so the second column lines up whatever the defaults are.
  const settings: Array<[string, string]> = [
    [`mode [${DEFAULTS.mode}]`, "enforce, audit or off"],
    [`denyAbove [${DEFAULTS.denyAbove}]`, "block at or above this probability"],
    [`flagAbove [${DEFAULTS.flagAbove}]`, "ask you at or above this probability"],
    [`lowIntentAtOrBelow [${DEFAULTS.lowIntentAtOrBelow}]`, "ask when intent consistency is this low, of 0-4"],
    [`onError [${DEFAULTS.onError}]`, "when Jev is unreachable, times out, or has no key"],
    [`onNoAnswer [${DEFAULTS.onNoAnswer}]`, "when a flagged call cannot be put to a human"],
    ["skipTools [Read, Glob, Grep, ...]", 'never verified; "none" verifies everything'],
    [`model [${DEFAULTS.model}]`, "which TypeSafe model answers"],
    [`timeoutMs [${DEFAULTS.timeoutMs}]`, "how long to wait before onError applies"],
    [`unhealthyAfter [${DEFAULTS.unhealthyAfter}]`, "warn after this many failures in a row"],
    [`auditLog [${DEFAULTS.auditLog}]`, "write .claude/stepwarden/<session>.jsonl"],
  ];
  const width = Math.max(...settings.map(([name]) => name.length)) + 3;

  return [
    "  stepwarden checks every tool call before it runs. This is how you drive it.",
    "",
    "  Commands",
    "    /stepwarden                    key, policy, and what it decided this session",
    "    /stepwarden enforce            block or ask on risky calls",
    `    /stepwarden audit              verify and log everything, block nothing (${DEFAULTS.mode} is the default)`,
    "    /stepwarden off                verify nothing",
    "    /stepwarden toggle             flip between audit and enforce",
    "    /stepwarden help               this text",
    "    /plugin configure stepwarden   every setting below, each with an explanation",
    "",
    "  Your TypeSafe API key",
    "    Without one, nothing is verified — the plugin says so at startup rather",
    "    than looking like a working gate. Get a key at https://typesafe.ai, then:",
    "      1.  /plugin configure stepwarden   stored in your OS keychain (recommended)",
    "      2.  export TYPESAFE_API_KEY=...    then restart Claude Code",
    "    A key in the plugin config wins over the environment. Claude Code does not",
    "    read .env files: source one into your shell first (set -a; . ./.env; set +a).",
    "",
    "  What you can configure                     (defaults in brackets)",
    ...settings.map(([name, what]) => `    ${name.padEnd(width)}${what}`),
    "",
    "  Use it in audit mode on real work, read the log with",
    "  scripts/analyze-audit.mjs (/stepwarden prints the command), then switch on",
    "  enforcement with /stepwarden enforce.",
  ].join("\n");
}

/**
 * A mode switch the user made with `/stepwarden`, as it comes back from the
 * plugin's store — or `null` when there is none to honour.
 *
 * The switch records the configured mode it was made against. If the stored
 * configuration has changed since, whoever changed it in
 * `/plugin configure stepwarden` meant it, and a switch made against the old
 * value is stale: the dialog wins, and the override is dropped.
 */
export function overrideMode(stored: unknown, configMode: Mode): Mode | null {
  if (stored === null || typeof stored !== "object") return null;
  const o = stored as { mode?: unknown; basedOn?: unknown };
  const mode = MODES.find((m) => m === o.mode);
  const basedOn = MODES.find((m) => m === o.basedOn);
  if (mode === undefined || basedOn === undefined) return null;
  return basedOn === configMode ? mode : null;
}
