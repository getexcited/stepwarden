/**
 * Redaction + size-capping for anything that leaves the session.
 *
 * Two destinations make this necessary, and neither is obvious from the call
 * site: every verified tool call is (a) sent to TypeSafe's API and (b) written
 * to a local JSONL audit log. A `Bash` call can carry `AWS_SECRET=...` and a
 * `Write` call can carry an entire file body, so raw tool arguments must not
 * go out unfiltered — and a 2 MB file body would blow both the request latency
 * and the log.
 *
 * This is deliberately conservative pattern matching, not a secret scanner: it
 * catches the common shapes and truncates everything else. It reduces
 * exposure; it does not eliminate it, which is why the README says plainly
 * that tool arguments are sent to a third party.
 */

const MAX_STRING = 600;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;

/**
 * Terms that make a key's value a secret wherever they appear in the name.
 * These essentially never occur in a benign tool argument.
 */
const SECRET_SUBSTRINGS = [
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
  "api_key",
  "api-key",
  "private_key",
  "privatekey",
  "access_token",
  "refresh_token",
  "auth_token",
  "bearer",
];

/**
 * Terms that are secrets only as the WHOLE key. Matching these as substrings
 * redacted ordinary arguments — `max_tokens` contains "token", `author`
 * contains "auth" — which both destroys the signal Jev needs and makes the
 * audit log unreadable.
 */
const SECRET_EXACT = new Set([
  "token",
  "auth",
  "authorization",
  "key",
  "cookie",
  "session_id",
  "sessionid",
  "pass",
  "credentials",
]);

function isSecretKey(name: string): boolean {
  const k = name.trim().toLowerCase();
  if (SECRET_EXACT.has(k)) return true;
  return SECRET_SUBSTRINGS.some((term) => k.includes(term));
}

/** Value shapes that look like credentials wherever they appear. */
const SECRET_VALUE: RegExp[] = [
  // KEY=value / KEY: value for a secret-ish name — a shell env assignment, and
  // the quoted "api_key": "..." form that appears in JSON bodies and configs.
  /(?:"|')?\b([A-Za-z0-9_]*(?:PASS(?:WD|WORD)?|SECRET|TOKEN|API[-_]?KEY|CREDENTIAL|PRIVATE[-_]?KEY)[A-Za-z0-9_]*)\b(?:"|')?\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
  // Common vendor key prefixes
  /\b((?:sk|pk|rk|apikey|ghp|gho|ghu|ghs|ghr|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{8,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Authorization headers
  /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
  // PEM blocks
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export const REDACTED = "«redacted»";

/** Replaces credential-looking substrings inside a free-text value. */
export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE) {
    out = out.replace(re, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g) => typeof g === "string") as string[];
      const name = groups[0];
      // Keep the name and the real separator so the shape stays readable (and
      // so a shell command is still parseable by Jev); replace only the value.
      if (name !== undefined) {
        const at = match.indexOf(name);
        const after = match.slice(at + name.length);
        const sep = after.match(/^["']?\s*[=:]\s*|^\s+/)?.[0];
        if (sep !== undefined) return `${match.slice(0, at + name.length)}${sep}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

function truncate(s: string): string {
  return s.length <= MAX_STRING ? s : `${s.slice(0, MAX_STRING)}…[${s.length} chars]`;
}

function scrub(value: unknown, depth: number, keyHint?: string): unknown {
  if (keyHint && isSecretKey(keyHint)) return REDACTED;
  if (value === null || value === undefined) return value ?? null;

  const t = typeof value;
  if (t === "string") return truncate(redactString(value as string));
  if (t === "number" || t === "boolean") return value;
  if (t !== "object") return String(value);

  if (depth >= MAX_DEPTH) return "«depth»";

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…[${value.length} items]`] : head;
  }

  // A null-prototype object so an argument named __proto__ is kept as data
  // rather than silently reassigning the result's prototype.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrub(v, depth + 1, k);
  }
  return { ...out };
}

/**
 * The tool arguments as they may safely be sent to Jev and written to the
 * audit log: secrets masked, long values truncated, deep structures clipped.
 */
export function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrub(args, 0);
  return scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)
    ? (scrubbed as Record<string, unknown>)
    : {};
}

/**
 * Splits a raw `tool.call` event into its identity and its arguments.
 *
 * A tool.call event is `{ tool, tool_use_id, ...the tool's own arguments }` —
 * the arguments are spread at the top level, there is no `input` wrapper.
 * These reserved keys are the engine's, not the tool's.
 */
const RESERVED = new Set(["tool", "tool_use_id", "agentId", "parentAgentId", "$shadowed"]);

export function splitEvent(e: Record<string, unknown>): {
  tool: string;
  toolUseId: string | undefined;
  args: Record<string, unknown>;
} {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!RESERVED.has(k)) args[k] = v;
  }
  return {
    tool: typeof e.tool === "string" ? e.tool : "(unknown)",
    toolUseId: typeof e.tool_use_id === "string" ? e.tool_use_id : undefined,
    args,
  };
}
