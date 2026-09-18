/**
 * stepwarden — per-tool-call verification through TypeSafe AI's Jev.
 *
 * Before each tool call runs, this asks Jev five questions about it against the
 * session's plan and recent history, and then allows it, asks a human, or
 * blocks it.
 *
 * WHY EVERYTHING LIVES IN ONE FILE
 * A function-hooks module is scanned statically before it loads. Three rules
 * shape this file, and breaking any of them makes the plugin fail to load with
 * no gate and no obvious error:
 *   1. `$` may not cross an import boundary, and may only be handed to a
 *      function declared at the TOP LEVEL of this same file — which is why the
 *      helpers below take `config` as a parameter instead of closing over it.
 *   2. A hooks module may import only relative paths and "claude-code" — no
 *      npm packages, no node: builtins. That is why the TypeSafe SDK is not
 *      used and the API is called directly through `$.http.fetch`.
 *   3. `$.env.get` takes a literal name, so the host can list what a module
 *      reads; it cannot be looped over a variable.
 * Everything else is pure and lives in lib/, where it is unit-testable.
 * Regenerate the types with `/plugin-types` after a Claude Code update.
 */

import type { Register } from "claude-code";
import {
  type RawOptions,
  describeMode,
  helpText,
  overrideMode,
  parseCommandArg,
  resolveApiKey,
  resolveConfig,
} from "../lib/config";
import {
  API_BASE,
  MODELS_PATH,
  SYSTEMONE_PATH,
  buildRequest,
  describeHttpFailure,
  parseResponse,
} from "../lib/jev";
import { keysOf, parseKey, sessionKey, staleSessions } from "../lib/keys";
import { decide, denyMessage } from "../lib/policy";
import { safeArgs, splitEvent } from "../lib/redact";
import type { Action, HistoryEntry, Mode, ResolvedConfig, Verdict } from "../lib/types";

/** Index of session id -> last seen, used only to prune the store. */
const LAST_SEEN_KEY = "stepwarden:last-seen";
/** Where `/stepwarden <mode>` remembers a switch for later sessions. */
const MODE_KEY = "stepwarden:mode-override";
const AUDIT_DIR = ".claude/stepwarden";

/** Sessions are forgotten after this long. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tool calls kept for contradiction checks. */
const HISTORY_KEEP = 8;
/** Audit lines kept on disk before the oldest are dropped. */
const AUDIT_KEEP = 2000;

interface Stats {
  checked: number;
  allowed: number;
  flagged: number;
  denied: number;
  skipped: number;
  errors: number;
  asked: number;
  inputTokens: number;
  outputTokens: number;
}

const ZERO_STATS: Stats = {
  checked: 0,
  allowed: 0,
  flagged: 0,
  denied: 0,
  skipped: 0,
  errors: 0,
  asked: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/* ------------------------------------------------------------------ helpers
 * Top-level declarations, so the scanner will follow `$` into them.
 */

async function readKey($: any, options: RawOptions): Promise<{ key: string | null; source: string }> {
  let fromEnv: string | undefined;
  try {
    // A literal name: the host lists what a module reads from the environment.
    fromEnv = await $.env.get("TYPESAFE_API_KEY");
  } catch {
    fromEnv = undefined;
  }
  return resolveApiKey(options, fromEnv);
}

/** The session this hook is running in; every stored key is scoped by it. */
async function sessionId($: any): Promise<string> {
  try {
    const id = await $.session.id();
    return typeof id === "string" && id.length > 0 ? id : "unknown-session";
  } catch {
    return "unknown-session";
  }
}

async function getStats($: any, sid: string): Promise<Stats> {
  try {
    const raw = await $.store.get(sessionKey(sid, "stats"));
    if (raw && typeof raw === "object") return { ...ZERO_STATS, ...(raw as Partial<Stats>) };
  } catch {
    /* fall through to zeros */
  }
  return { ...ZERO_STATS };
}

async function bumpStats($: any, sid: string, patch: Partial<Stats>): Promise<void> {
  await serialize(async () => {
    try {
      const cur = await getStats($, sid);
      const next: Record<string, number> = { ...(cur as unknown as Record<string, number>) };
      for (const [k, v] of Object.entries(patch)) {
        if (typeof v === "number") next[k] = (next[k] ?? 0) + v;
      }
      await $.store.set(sessionKey(sid, "stats"), next);
    } catch {
      /* stats are best-effort */
    }
  });
}

/**
 * The audit log's lines, per session, held for the life of the module.
 *
 * `$.fs.write` has no append mode, so the file is rewritten on every entry.
 * Re-reading it first would make that quadratic in a long session, and this
 * plugin is the only writer, so the lines are read once and kept.
 *
 * Keyed by session id, and memoised so two concurrent first-calls cannot both
 * load and race. One module can serve more than one session, and the path is
 * derived from the session id at write time — one shared buffer would write one
 * session's lines into the other session's file.
 */
const auditLines = new Map<string, Promise<string[]>>();

async function audit(
  $: any,
  config: ResolvedConfig,
  sid: string,
  entry: Record<string, unknown>
): Promise<void> {
  if (!config.auditLog) return;
  try {
    const path = `${AUDIT_DIR}/${sid}.jsonl`;
    let load = auditLines.get(sid);
    if (load === undefined) {
      load = (async () => {
        // Ask before reading. `$.fs.read` rejects on a missing file and the host
        // records that rejection, which put an ENOENT line in the debug log of
        // every clean session. `$.fs.exists` never rejects.
        let existing = "";
        try {
          if (await $.fs.exists(path)) existing = await $.fs.read(path);
        } catch {
          existing = ""; // unreadable: start a fresh buffer rather than lose this line
        }
        return existing.length > 0 ? existing.split("\n").filter((l: string) => l.length > 0) : [];
      })();
      auditLines.set(sid, load);
    }
    const lines = await load;

    const at = await $.clock.now();
    // Pushing before the await means a concurrent writer's line is already in
    // the array by the time either write runs: last write wins, nothing is lost.
    lines.push(JSON.stringify({ at, ...entry }));
    if (lines.length > AUDIT_KEEP) lines.splice(0, lines.length - AUDIT_KEEP);
    await $.fs.write(path, lines.join("\n") + "\n");
  } catch {
    /* an audit write must never break a tool call */
  }
}

/**
 * The mode `/stepwarden <mode>` set, per session.
 *
 * The module is loaded once, with the options it had then, so writing the
 * config alone would not reach the hooks already registered here. The override
 * applies to the session that asked for it at once; `$.config.set` persists the
 * same value, which every later session loads. Keyed by session id for the same
 * reason the audit buffer is: one module can serve more than one session, and
 * one session's switch is not another session's business. Cleared on load, so a
 * session always starts from the stored config.
 */
const modeOverride = new Map<string, Mode>();

/** The mode in force right now: this session's switch, else the config. */
function currentMode(config: ResolvedConfig, sid: string): Mode {
  return modeOverride.get(sid) ?? config.mode;
}

/**
 * Serves `/stepwarden <mode>`: remember it, then apply it to this session.
 *
 * Saving comes first on purpose. A refusal must not leave the running session
 * enforcing something the settings refused.
 *
 * Two ways to save, and the difference matters. The settings row the plugin
 * owns is the right home, but a Claude Code that does not expose a plugin's
 * `userConfig` through `$.config` rejects the write outright — 2.1.273 lists no
 * plugin rows at all — so the switch is kept in the plugin's own store instead,
 * next to the configured value it was made against. A `{ deny }`, on the other
 * hand, is somebody's decision: managed settings or an organization policy own
 * the row, and that is not something to route around.
 */
async function applyMode($: any, config: ResolvedConfig, sid: string, mode: Mode): Promise<string> {
  const from = currentMode(config, sid);
  let saved: "config" | "store" | null = null;
  let unavailable: string | null = null;

  try {
    const res = await $.config.set({ key: "stepwarden.mode", value: mode });
    if (res && typeof res.deny === "string") {
      await audit($, config, sid, { type: "mode_change_refused", from, to: mode, detail: res.deny });
      return (
        `  Mode is still ${from}: your settings refused the change (${String(res.deny).slice(0, 120)}).\n` +
        "  Whoever manages those settings owns this one."
      );
    }
    saved = "config";
  } catch (err) {
    unavailable = (err as Error)?.message ?? String(err);
  }

  try {
    if (saved === "config" || mode === config.mode) {
      // Nothing to shadow: the stored configuration already says this.
      await $.store.delete(MODE_KEY);
    } else {
      await $.store.set(MODE_KEY, { mode, basedOn: config.mode });
      saved = "store";
    }
  } catch (err) {
    if (saved === null) {
      const why = (err as Error)?.message ?? String(err);
      await audit($, config, sid, { type: "mode_change_refused", from, to: mode, detail: why });
      return (
        `  Mode is still ${from}: the switch could not be saved (${why.slice(0, 120)}).\n` +
        "  Set it in /plugin configure stepwarden instead."
      );
    }
  }

  modeOverride.set(sid, mode);
  await audit($, config, sid, { type: "mode_changed", from, to: mode, saved, detail: unavailable });
  if (mode === from) return `  Mode is ${mode} — ${describeMode(mode)}. Nothing changed.`;
  const head = `  Mode is now ${mode} — ${describeMode(mode)} (was ${from}).`;
  if (saved === "store" && mode !== config.mode) {
    return (
      `${head}\n  Remembered for your next sessions too. /plugin configure stepwarden still says ` +
      `${config.mode} — change it there and that wins.`
    );
  }
  return `${head}\n  Saved: new sessions start in ${mode} too. Run /stepwarden for the whole policy.`;
}

/**
 * Claude Code dispatches tool calls in concurrent batches, and `$.store` has no
 * compare-and-set, so a plain read-modify-write loses updates. Every store
 * mutation goes through this queue instead: counters stay exact and no history
 * entry is dropped. It only orders this plugin's own writes, so it cannot
 * deadlock anything else.
 */
let storeQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(work, work);
  storeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Reachability + credential check. Returns a line fit to show a human. */
async function probeKey(
  $: any,
  key: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<{ ok: boolean; line: string }> {
  const stop = new AbortController();
  try {
    const probe = await Promise.race([
      $.http.fetch(API_BASE + MODELS_PATH, {
        method: "GET",
        headers: { authorization: "Bearer " + key, accept: "application/json" },
      }).finally(() => stop.abort()),
      $.clock.sleep(timeoutMs, { signal: anySignal(stop.signal, signal) }).then(() => null),
    ]);
    if (probe === null) return { ok: false, line: `no answer from TypeSafe within ${timeoutMs}ms` };
    const r = probe as { ok: boolean; status: number; text: string };
    return r.ok ? { ok: true, line: "key accepted" } : { ok: false, line: describeHttpFailure(r.status, r.text) };
  } catch (err) {
    return { ok: false, line: `check failed — ${(err as Error).message}` };
  } finally {
    stop.abort();
  }
}

/** One signal that fires when either input does; used to cancel a timeout race. */
function anySignal(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  const out = new AbortController();
  const fire = () => out.abort();
  if (a.aborted || b.aborted) out.abort();
  else {
    a.addEventListener("abort", fire, { once: true });
    b.addEventListener("abort", fire, { once: true });
  }
  return out.signal;
}

/**
 * One verification round trip. Throws with a message written for a human; the
 * caller turns that into the configured onError action and counts it against
 * gate health.
 */
async function askJev(
  $: any,
  config: ResolvedConfig,
  apiKey: string,
  plan: string | null,
  history: HistoryEntry[],
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<Verdict> {
  const body = JSON.stringify(
    buildRequest({ plan, recentCalls: history, current: { tool, args }, model: config.model })
  );

  const timedOut = Symbol("timeout");
  const stop = new AbortController();
  let response: unknown;
  try {
    response = await Promise.race([
      $.http.fetch(API_BASE + SYSTEMONE_PATH, {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      }).finally(() => stop.abort()),
      // $.http.fetch takes no abort signal of its own, so the request is raced
      // against the clock. The timer is cancelled as soon as either the fetch
      // settles or the dispatch is abandoned, so no timer outlives the call.
      $.clock.sleep(config.timeoutMs, { signal: anySignal(stop.signal, signal) }).then(() => timedOut),
    ]);
  } finally {
    stop.abort();
  }

  if (response === timedOut) throw new Error(`Jev did not answer within ${config.timeoutMs}ms`);

  const res = response as { ok: boolean; status: number; text: string };
  if (!res.ok) throw new Error(describeHttpFailure(res.status, res.text));

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error("TypeSafe returned a body that is not JSON");
  }
  return parseResponse(parsed);
}

/* --------------------------------------------------------------- the plugin */

export const register: Register = (on, options) => {
  // `options` holds this plugin's userConfig values, already type-checked by
  // the engine (sensitive ones come from secure storage). Normalising once is
  // safe: a change through /plugin configure reloads the module.
  const config: ResolvedConfig = resolveConfig(options);
  const raw = options as RawOptions;
  // A fresh load starts from the stored config, never from the last session's
  // /stepwarden switch.
  modeOverride.clear();

  // ------------------------------------------------------------ session.start

  on("session.start", async ($: any, e: any, next: any) => {
    try {
      const sid = await sessionId($);
      await $.store.set(sessionKey(sid, "interactive"), e?.isInteractive === true);

      // Record this session and forget long-dead ones. Pruning by timestamp
      // (rather than "delete everything that is not me") keeps concurrent
      // sessions from deleting each other's plan mid-run.
      try {
        const now = await $.clock.now();
        const seenRaw = await $.store.get(LAST_SEEN_KEY);
        const seen: Record<string, unknown> =
          seenRaw && typeof seenRaw === "object" ? { ...(seenRaw as Record<string, unknown>) } : {};
        seen[sid] = now;
        const allKeys = (await $.store.keys()) as string[];

        // A session seen for the first time is recorded now and pruned only on
        // a later start. Deleting it immediately would race a session that is
        // starting concurrently and has not written its own timestamp yet.
        for (const key of allKeys) {
          const owner = parseKey(key);
          if (owner && seen[owner.sessionId] === undefined) seen[owner.sessionId] = now;
        }

        const dead = staleSessions(allKeys, seen, now, SESSION_TTL_MS, sid);
        for (const key of keysOf(allKeys, dead)) await $.store.delete(key);
        for (const id of dead) delete seen[id];
        await $.store.set(LAST_SEEN_KEY, seen);
      } catch {
        /* pruning is housekeeping; never let it cost the session */
      }

      // /stepwarden is registered here, not in engine.create: the command noun is not
      // available that early, and a failure there would fail the whole load.
      try {
        await $.command.register({
          name: "stepwarden",
          description: "stepwarden: status, help, or switch mode (enforce / audit / off)",
          argumentHint: "[enforce|audit|off|toggle|help]",
          // Switching the gate on or off is most useful mid-turn — exactly when
          // waiting for the turn to end would defeat the point.
          immediate: true,
        });
      } catch {
        /* no command surface here; the gate itself still works */
      }

      // A switch made with /stepwarden in an earlier session, unless the stored
      // configuration has changed since — then the dialog wins.
      try {
        const stored = await $.store.get(MODE_KEY);
        const remembered = overrideMode(stored ?? null, config.mode);
        if (remembered !== null) modeOverride.set(sid, remembered);
        else if (stored !== undefined && stored !== null) await $.store.delete(MODE_KEY);
      } catch {
        /* without it, the session simply starts from the stored config */
      }

      for (const w of config.warnings) $.ui.log(`[stepwarden] config: ${w}`);

      if (currentMode(config, sid) === "off") {
        $.ui.log("[stepwarden] mode is 'off' — no tool call is verified. Turn it back on with /stepwarden audit.");
        return next(e);
      }

      const { key, source } = await readKey($, raw);
      if (!key) {
        // The most common setup failure by far. Say exactly what to do, and
        // say plainly that nothing is being verified meanwhile.
        $.ui.toast("stepwarden: no API key — nothing is being verified. Run /stepwarden.", { timeoutMs: 12000 });
        $.ui.log(
          "[stepwarden] No TypeSafe API key found. Set one with:\n" +
            "        /plugin configure stepwarden      (stored in your OS keychain)\n" +
            "      or export TYPESAFE_API_KEY=... before starting Claude Code.\n" +
            "      Get a key at https://typesafe.ai — run /stepwarden any time to re-check."
        );
        await audit($, config, sid, { type: "no_api_key" });
        return next(e);
      }

      // A cheap authenticated GET turns "your key is wrong" into a message at
      // startup rather than a surprise on the first tool call.
      const probe = await probeKey($, key, Math.min(config.timeoutMs, 3000), next.signal);
      if (probe.ok) {
        $.ui.log(
          `[stepwarden] ready — mode=${currentMode(config, sid)}, model=${config.model}, key from ${source}; ` +
            `block at or above ${config.denyAbove}, ask at or above ${config.flagAbove}.`
        );
      } else {
        $.ui.toast(`stepwarden: ${probe.line}`, { timeoutMs: 12000 });
        $.ui.log(`[stepwarden] ${probe.line}`);
        await audit($, config, sid, { type: "key_check_failed", detail: probe.line });
      }

      if (currentMode(config, sid) === "audit") {
        $.ui.log(
          "[stepwarden] AUDIT mode: decisions are computed and logged, but nothing is ever blocked. " +
            "Turn the gate on with /stepwarden enforce once the numbers look right."
        );
      }
    } catch {
      /* session.start must never break the session */
    }
    return next(e);
  });

  // ----------------------------------------------------------- prompt.submit

  on("prompt.submit", async ($: any, e: any, next: any) => {
    try {
      const text = typeof e?.text === "string" ? e.text.trim() : "";
      if (text.length > 0) {
        const sid = await sessionId($);
        const existing = await $.store.get(sessionKey(sid, "plan"));
        if (typeof existing !== "string" || existing.length === 0) {
          // Stored verbatim, never summarised: a summary could quietly
          // misrepresent the intent that everything else is checked against.
          await $.store.set(sessionKey(sid, "plan"), text);
          $.ui.log(`[stepwarden] plan captured: "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`);
        }
      }
    } catch {
      /* plan capture is best-effort */
    }
    return next(e);
  });

  // --------------------------------------------------------------- tool.call

  on("tool.call", async ($: any, e: any, next: any) => {
    try {
      const sid = await sessionId($);
      if (currentMode(config, sid) === "off") return next(e);

      const { tool, toolUseId, args } = splitEvent(e ?? {});

      if (config.skipTools.includes(tool)) {
        await bumpStats($, sid, { skipped: 1 });
        return next(e);
      }

      const { key } = await readKey($, raw);
      if (!key) {
        // The gate cannot run. `onError` decides, and it is recorded, so an
        // unconfigured gate is never mistaken for a clean verdict.
        await bumpStats($, sid, { errors: 1 });
        await audit($, config, sid, {
          type: "verification",
          tool,
          args: safeArgs(args),
          failure: "no API key configured",
          shadowAction: config.onError,
          effectiveAction: currentMode(config, sid) === "enforce" ? config.onError : "allow",
        });
        if (currentMode(config, sid) === "enforce" && config.onError === "deny") {
          return { deny: "stepwarden: no TypeSafe API key is configured and the failure policy is 'deny'. Run /stepwarden." };
        }
        return next(e);
      }

      const scrubbed = safeArgs(args);
      let plan: string | null = null;
      let history: HistoryEntry[] = [];
      try {
        const p = await $.store.get(sessionKey(sid, "plan"));
        plan = typeof p === "string" ? p : null;
        const h = await $.store.get(sessionKey(sid, "history"));
        history = Array.isArray(h) ? (h as HistoryEntry[]) : [];
      } catch {
        /* an empty plan/history is a valid, lower-signal state */
      }

      let verdict: Verdict | null = null;
      let failure: string | null = null;
      try {
        verdict = await askJev($, config, key, plan, history.slice(-HISTORY_KEEP), tool, scrubbed, next.signal);
      } catch (err) {
        failure = (err as Error).message;
      }

      // ---- gate health: is the gate itself still working?
      // Every store touch in this hook is guarded. A throw here would propagate
      // out of the hook, and a failed hook is skipped — so the tool would run
      // unverified, with no deny, no prompt and no audit line: the gate would
      // fail open at exactly the moment it is reporting that it is unhealthy.
      const health = await serialize(async () => {
        try {
          let failures = 0;
          try {
            const rawFailures = await $.store.get(sessionKey(sid, "failures"));
            failures = typeof rawFailures === "number" ? rawFailures : 0;
          } catch {
            failures = 0;
          }
          if (failure === null) {
            if (failures > 0) await $.store.set(sessionKey(sid, "failures"), 0);
            return { recovered: failures > 0, consecutive: 0 };
          }
          const now = failures + 1;
          await $.store.set(sessionKey(sid, "failures"), now);
          return { recovered: false, consecutive: now };
        } catch {
          // Health tracking is observability, never a reason to drop the gate.
          return { recovered: false, consecutive: 0 };
        }
      });

      if (failure === null) {
        if (health.recovered) {
          $.ui.log("[stepwarden] verification gate recovered.");
          await audit($, config, sid, { type: "gate_recovered" });
        }
      } else {
        const now = health.consecutive;
        if (now === config.unhealthyAfter) {
          // Fire once at the threshold, not on every later call: an outage must
          // be visible without spamming every tool call.
          $.ui.toast(
            `stepwarden: ${now} verification failures in a row — calls are proceeding unverified (${config.onError}).`,
            { timeoutMs: 12000 }
          );
          await audit($, config, sid, { type: "gate_unhealthy", consecutiveFailures: now, reason: failure });
        }
      }

      // ---- decide
      let decision =
        verdict !== null
          ? decide(verdict, config)
          : { action: config.onError, reasons: [`verification failed: ${failure}`], maxProbability: 0 };

      const shadowAction: Action = decision.action;
      let effective: Action = shadowAction;
      let askOutcome: string | null = null;

      if (currentMode(config, sid) === "audit") {
        effective = "allow"; // compute and record, change nothing
      } else if (shadowAction === "flag") {
        let interactive = false;
        try {
          interactive = (await $.store.get(sessionKey(sid, "interactive"))) === true;
        } catch {
          interactive = false;
        }

        if (!interactive) {
          effective = config.onNoAnswer;
          askOutcome = "non-interactive session";
          // Say it. A flagged call nobody could be asked about must never read
          // as a clean verdict. A headless run has no transcript of its own:
          // the line reaches the SDK host as `ui_log` and the debug log, and
          // the audit log carries `askOutcome` either way.
          $.ui.toast(
            `stepwarden: ${tool} was flagged and nobody could be asked — ` +
              `${effective === "allow" ? "allowed" : "blocked"} under your 'if nobody answers' setting.`,
            { timeoutMs: 10000 }
          );
          $.ui.log(
            `[stepwarden] ${tool} was flagged and this run has nobody to ask, so 'if nobody answers' decided: ${effective}. ` +
              "Run it in an interactive session to be asked, or change onNoAnswer with /plugin configure stepwarden."
          );
        } else {
          try {
            const answer = await $.ui.ask(
              `${tool}: ${decision.reasons.join("; ")}. Allow this call?`,
              { header: "stepwarden", options: ["Allow", "Block"] }
            );
            await bumpStats($, sid, { asked: 1 });
            if (answer === "Allow") {
              effective = "allow";
              askOutcome = "allowed by a human";
            } else {
              effective = "deny";
              askOutcome = "blocked by a human";
              decision = { ...decision, reasons: [...decision.reasons, "a human chose to block it"] };
            }
          } catch (err) {
            // Dismissed, rate-limited (one question per 2s per plugin), or past
            // the session's question budget. None of those is an approval.
            const why = (err as Error).message;
            effective = config.onNoAnswer;
            askOutcome = `no answer: ${why.slice(0, 120)}`;
            // Say so. A flagged call quietly becoming an allow because the dialog
            // was unavailable is exactly the failure this plugin exists to avoid.
            if (effective === "allow") {
              $.ui.toast(
                `stepwarden: could not ask about this ${tool} call (${why.slice(0, 60)}) — it was allowed under your 'if nobody answers' setting.`,
                { timeoutMs: 10000 }
              );
            }
          }
        }
      }

      await bumpStats($, sid, {
        checked: 1,
        allowed: effective === "allow" ? 1 : 0,
        flagged: shadowAction === "flag" ? 1 : 0,
        denied: effective === "deny" ? 1 : 0,
        errors: failure === null ? 0 : 1,
        inputTokens: verdict?.usage?.inputTokens ?? 0,
        outputTokens: verdict?.usage?.outputTokens ?? 0,
      });

      await audit($, config, sid, {
        type: "verification",
        tool,
        tool_use_id: toolUseId,
        args: scrubbed,
        shadowAction,
        effectiveAction: effective,
        askOutcome,
        reasons: decision.reasons,
        maxProbability: decision.maxProbability,
        signals: verdict?.signals ?? null,
        intent: verdict?.intent ?? null,
        model: verdict?.model ?? null,
        usage: verdict?.usage ?? null,
        failure,
      });

      if (effective === "deny") return { deny: denyMessage(tool, decision, askOutcome) };

      await serialize(async () => {
        try {
          const at = await $.clock.now();
          const entry: HistoryEntry = { tool, args: scrubbed, at };
          // Re-read inside the critical section: a concurrent call in the same
          // batch may have appended since this hook read `history` above.
          const current = await $.store.get(sessionKey(sid, "history"));
          const base = Array.isArray(current) ? (current as HistoryEntry[]) : [];
          await $.store.set(sessionKey(sid, "history"), [...base, entry].slice(-HISTORY_KEEP));
        } catch {
          /* history is an optimisation, not a correctness requirement */
        }
      });

      return next(e);
    } catch (err) {
      // The gate itself crashed — a display call, a store write, a shape the
      // engine changed. A hook that throws is skipped and the tool simply
      // runs, so without this the gate would fail open at the one moment it
      // most needs to be visible. Make it a configured, recorded outcome.
      const why = (err as Error)?.message ?? String(err);
      try {
        $.ui.toast(`stepwarden crashed while checking a call: ${why.slice(0, 80)}`, { timeoutMs: 12000 });
      } catch {
        /* even the toast is best-effort here */
      }
      let sid = "unknown-session";
      try {
        sid = await sessionId($);
        await audit($, config, sid, { type: "gate_crashed", tool: e?.tool, failure: why });
      } catch {
        /* nothing more we can do */
      }
      if (currentMode(config, sid) === "enforce" && config.onError === "deny") {
        return { deny: `Blocked by stepwarden: the verifier itself failed (${why.slice(0, 120)}) and the failure policy is 'deny'.` };
      }
      return next(e);
    }
  });

  // ------------------------------------------------------------ /stepwarden command

  on("command.run", { command: "stepwarden" }, async ($: any, e: any, next: any) => {
    const sid = await sessionId($);

    // Bare, it reports. `help` explains the whole surface, and a mode switches
    // the gate.
    const asked = parseCommandArg(typeof e?.args === "string" ? e.args : "", currentMode(config, sid));
    if (asked.kind === "help") return { text: helpText() };
    if (asked.kind === "error") return { text: `  ${asked.message}` };
    if (asked.kind === "mode") return { text: await applyMode($, config, sid, asked.mode) };

    const { key, source } = await readKey($, raw);
    const stats = await getStats($, sid);
    let plan: unknown = null;
    try {
      plan = await $.store.get(sessionKey(sid, "plan"));
    } catch {
      plan = null;
    }

    // The host already draws the plugin's name above this output, so a leading
    // blank line printed a bare "stepwarden:" row with nothing after it.
    const lines: string[] = [];

    if (!key) {
      lines.push(
        "  API key:   NOT SET — nothing is being verified.",
        "",
        "  Set one, either way:",
        "    1.  /plugin configure stepwarden      (stored in your OS keychain)",
        "    2.  export TYPESAFE_API_KEY=...              (then restart Claude Code)",
        "",
        "  Get a key at https://typesafe.ai"
      );
    } else {
      const masked = key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "(set)";
      const probe = await probeKey($, key, Math.min(config.timeoutMs, 3000), next.signal);
      lines.push(`  API key:   ${masked}  from ${source}`, `  TypeSafe:  ${probe.line}`);
    }

    const mode = currentMode(config, sid);
    lines.push(
      "",
      `  Mode:      ${mode}   (${describeMode(mode)})` +
        `${modeOverride.has(sid) ? `  — set with /stepwarden; the dialog says ${config.mode}` : ""}`,
      `  Model:     ${config.model}`,
      `  Policy:    block at or above ${config.denyAbove} · ask at or above ${config.flagAbove} · ask at intent ≤ ${config.lowIntentAtOrBelow} of 4`,
      `  Fallbacks: on error ${config.onError} · on no answer ${config.onNoAnswer}`,
      `  Skipping:  ${config.skipTools.length > 0 ? config.skipTools.join(", ") : "(nothing)"}`,
      "",
      `  Plan:      ${typeof plan === "string" && plan.length > 0 ? `"${plan.slice(0, 100)}${plan.length > 100 ? "…" : ""}"` : "(none captured yet)"}`,
      "",
      `  Session:   ${stats.checked} verified · ${stats.allowed} allowed · ${stats.flagged} flagged · ` +
        `${stats.denied} blocked · ${stats.skipped} skipped · ${stats.errors} errors · ${stats.asked} asked`,
      `  Jev usage: ${stats.inputTokens} input tokens, ${stats.outputTokens} output tokens`
    );

    if (config.warnings.length > 0) {
      lines.push("", "  Config warnings:");
      for (const w of config.warnings) lines.push(`    - ${w}`);
    }
    lines.push("", "  /stepwarden help for the settings, the commands and how to set your key.");

    if (config.auditLog) {
      // The real path, so the line can be pasted into a shell. `.claude/stepwarden`
      // is the script's own default, read from the project you run it in.
      // Spelled `$.plugin.root` exactly: the static scanner refuses any other
      // shape, including optional chaining.
      let root = "<path-to-stepwarden>";
      try {
        const here = $.plugin.root;
        if (typeof here === "string" && here.length > 0) root = here;
      } catch {
        /* an older host without the field: the README still has the path */
      }
      lines.push(
        "",
        `  Audit log: ${AUDIT_DIR}/${sid}.jsonl`,
        `             analyse it from this project:  node ${root}/scripts/analyze-audit.mjs`
      );
    }

    return { text: lines.join("\n") };
  });
};
