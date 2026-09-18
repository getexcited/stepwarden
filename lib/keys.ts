/**
 * Store keys.
 *
 * `$.store` is the plugin's own key-value store and is "kept between sessions
 * and hot reloads". Everything this plugin keeps — the plan, the recent-call
 * history, gate health, the counters — is meaningful only within one session,
 * so every key is scoped by the session id. Without that, a new session
 * inherits the previous session's plan and silently verifies today's work
 * against yesterday's intent.
 *
 * Scoping alone would grow the store forever, so old sessions are pruned. The
 * prune is deliberately based on a per-session timestamp rather than "delete
 * everything that is not me": concurrent sessions are normal, and they must
 * not delete each other's state.
 *
 * There is no migration path for keys written under a previous plugin name:
 * the engine keys each plugin's store by its manifest name, so a rename starts
 * from an empty store and the old file is orphaned whole, where this code can
 * never reach it.
 */

export const PREFIX = "stepwarden";

/** Suffixes, all session-scoped. `seen` is the prune timestamp. */
export const SUFFIXES = ["plan", "history", "failures", "stats", "interactive", "seen"] as const;
export type Suffix = (typeof SUFFIXES)[number];

export function sessionKey(sessionId: string, suffix: Suffix): string {
  return `${PREFIX}:${sessionId}:${suffix}`;
}

/** The inverse of sessionKey, for keys this plugin owns; null for anything else. */
export function parseKey(key: string): { sessionId: string; suffix: string } | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const sessionId = parts[1];
  const suffix = parts[2];
  if (!sessionId || !suffix) return null;
  return { sessionId, suffix };
}

/** Sessions to forget: last seen too long ago, or carrying no timestamp at all. */
export function staleSessions(
  keys: readonly string[],
  lastSeen: Readonly<Record<string, unknown>>,
  now: number,
  maxAgeMs: number,
  currentSessionId: string
): string[] {
  const sessions = new Set<string>();
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed) sessions.add(parsed.sessionId);
  }
  sessions.delete(currentSessionId);

  const stale: string[] = [];
  for (const id of sessions) {
    const seen = lastSeen[id];
    // A session with no timestamp is from an older version of this plugin, or
    // its session.start never completed: either way it is safe to forget.
    if (typeof seen !== "number" || now - seen > maxAgeMs) stale.push(id);
  }
  return stale.sort();
}

/** Every key belonging to the given sessions. */
export function keysOf(keys: readonly string[], sessionIds: readonly string[]): string[] {
  const ids = new Set(sessionIds);
  return keys.filter((k) => {
    const parsed = parseKey(k);
    return parsed !== null && ids.has(parsed.sessionId);
  });
}
