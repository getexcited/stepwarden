/**
 * Policy and config are pure, so they are tested directly — no engine needed.
 * These are the cases that decide whether a call is blocked, so they are the
 * ones worth pinning down.
 */

import { describe, expect, test } from "claude-code/testing";
import {
  DEFAULTS,
  describeMode,
  helpText,
  overrideMode,
  parseCommandArg,
  resolveApiKey,
  resolveConfig,
} from "../lib/config";
import { keysOf, parseKey, sessionKey, staleSessions } from "../lib/keys";
import { decide, denyMessage } from "../lib/policy";
import { INTENT_RUBRIC, MAX_PLAN_CHARS, buildRequest, parseResponse } from "../lib/jev";
import { redactString, safeArgs, splitEvent } from "../lib/redact";
import type { Verdict } from "../lib/types";

const cfg = resolveConfig({});

function verdict(probs: number[], score: number | null = 4): Verdict {
  const keys = ["contradictsPlan", "outOfScope", "contradictsPrevious", "shouldFlag"];
  return {
    signals: keys.map((key, i) => ({ key, label: key, probability: probs[i] ?? 0 })),
    intent: score === null ? null : { score, max: INTENT_RUBRIC.length - 1, confidence: 0.9 },
    usage: null,
    model: "jev-test",
  };
}

describe("decide", () => {
  test("allows a call with no signal above threshold", () => {
    const d = decide(verdict([0.1, 0.2, 0.05, 0.3]), cfg);
    expect(d.action).toBe("allow");
    expect(d.reasons).toEqual([]);
  });

  test("denies when a single signal reaches denyAbove", () => {
    const d = decide(verdict([0.95, 0.1, 0.1, 0.1]), cfg);
    expect(d.action).toBe("deny");
    expect(d.maxProbability).toBe(0.95);
  });

  test("flags in the middle band", () => {
    const d = decide(verdict([0.7, 0.1, 0.1, 0.1]), cfg);
    expect(d.action).toBe("flag");
    expect(d.reasons.length).toBe(1);
  });

  test("flags on low intent consistency even when every probability is low", () => {
    // Scores are ZERO-indexed: 0 contradicts, 4 is fully consistent.
    const d = decide(verdict([0.01, 0.01, 0.01, 0.01], 0), cfg);
    expect(d.action).toBe("flag");
    expect(d.reasons.join(" ")).toContain("low consistency");
  });

  test("a fully consistent call with low probabilities is allowed", () => {
    const d = decide(verdict([0.01, 0.01, 0.01, 0.01], 4), cfg);
    expect(d.action).toBe("allow");
  });

  test("a missing intent score never fabricates a flag", () => {
    const d = decide(verdict([0.1, 0.1, 0.1, 0.1], null), cfg);
    expect(d.action).toBe("allow");
  });
});

describe("resolveConfig", () => {
  test("empty options give the documented defaults, and the shipped mode never blocks", () => {
    const c = resolveConfig({});
    expect(c.mode).toBe("audit");
    expect(c.denyAbove).toBe(DEFAULTS.denyAbove);
    expect(c.warnings).toEqual([]);
  });

  test("a garbage threshold falls back and warns instead of disabling the gate", () => {
    const c = resolveConfig({ denyAbove: "banana" as unknown as number });
    expect(c.denyAbove).toBe(DEFAULTS.denyAbove);
    expect(c.warnings.length).toBe(1);
  });

  test("an out-of-range threshold is rejected, not clamped silently", () => {
    const c = resolveConfig({ flagAbove: 42 });
    expect(c.flagAbove).toBe(DEFAULTS.flagAbove);
    expect(c.warnings.join(" ")).toContain("outside 0..1");
  });

  test("inverted thresholds are repaired into a real ask band, not a zero-width one", () => {
    const c = resolveConfig({ denyAbove: 0.5, flagAbove: 0.9 });
    // Collapsing flagAbove onto denyAbove would still mean every flagged call
    // is really a block, so the repair has to leave a band below it.
    expect(c.flagAbove).toBeLessThan(c.denyAbove);
    expect(c.flagAbove).toBe(0.4);
    expect(c.warnings.join(" ")).toContain("no band in which you are asked");
  });

  test("a blank threshold reads as unset rather than coercing to zero", () => {
    // Number("") is 0, which would have made the gate block everything.
    const c = resolveConfig({ denyAbove: "  ", flagAbove: "" });
    expect(c.denyAbove).toBe(DEFAULTS.denyAbove);
    expect(c.flagAbove).toBe(DEFAULTS.flagAbove);
  });

  test("'flag' is not accepted as a fallback, because nobody can be asked there", () => {
    const c = resolveConfig({ onError: "flag", onNoAnswer: "flag" });
    expect(c.onError).toBe(DEFAULTS.onError);
    expect(c.onNoAnswer).toBe(DEFAULTS.onNoAnswer);
    expect(c.warnings.length).toBe(2);
  });

  test("auditLog only turns off for a recognised false", () => {
    expect(resolveConfig({ auditLog: false }).auditLog).toBe(false);
    expect(resolveConfig({ auditLog: "false" }).auditLog).toBe(false);
    expect(resolveConfig({ auditLog: "no" }).auditLog).toBe(false);
    expect(resolveConfig({ auditLog: "yes" }).auditLog).toBe(true);
    expect(resolveConfig({ auditLog: "nonsense" }).auditLog).toBe(true);
  });

  test("an unknown mode warns rather than silently turning the gate off", () => {
    const c = resolveConfig({ mode: "enforcce" });
    expect(c.mode).toBe("audit");
    expect(c.warnings.length).toBe(1);
  });

  test("skipTools accepts a comma-separated string, and 'none' means verify everything", () => {
    expect(resolveConfig({ skipTools: "Read, Glob" }).skipTools).toEqual(["Read", "Glob"]);
    expect(resolveConfig({ skipTools: "none" }).skipTools).toEqual([]);
  });
});

describe("resolveApiKey", () => {
  test("plugin config wins over the environment", () => {
    const r = resolveApiKey({ TYPESAFE_API_KEY: "from-config" }, "from-env");
    expect(r.key).toBe("from-config");
    expect(r.source).toBe("plugin-config");
  });

  test("falls back to the environment", () => {
    const r = resolveApiKey({}, "from-env");
    expect(r.key).toBe("from-env");
    expect(r.source).toBe("environment");
  });

  test("a blank value counts as unset, not as a key", () => {
    const r = resolveApiKey({ TYPESAFE_API_KEY: "   " }, undefined);
    expect(r.key).toBe(null);
    expect(r.source).toBe("none");
  });
});

describe("parseResponse", () => {
  test("reads `noul` and a zero-indexed `score`", () => {
    const v = parseResponse({
      model: "jev-1.13.0",
      answers: {
        contradictsPlan: { type: "noul", noul: 0.92 },
        outOfScope: { type: "noul", noul: 0.91 },
        contradictsPrevious: { type: "noul", noul: 0.19 },
        shouldFlag: { type: "noul", noul: 0.96 },
        intentConsistency: { type: "score", score: 0.03, confidence: 0.98 },
      },
      usage: { input_tokens: 417, output_tokens: 81 },
    });
    expect(v.signals.length).toBe(4);
    expect(v.signals[0]?.probability).toBe(0.92);
    expect(v.intent?.score).toBe(0.03);
    expect(v.intent?.max).toBe(4);
    expect(v.usage?.inputTokens).toBe(417);
  });

  test("throws when the intent score is missing, instead of dropping the trigger", () => {
    // A silently absent score would disable the low-intent flag and read as a
    // clean verdict, which is the failure mode this whole file guards against.
    expect(() =>
      parseResponse({
        answers: {
          contradictsPlan: { type: "noul", noul: 0.1 },
          outOfScope: { type: "noul", noul: 0.1 },
          contradictsPrevious: { type: "noul", noul: 0.1 },
          shouldFlag: { type: "noul", noul: 0.1 },
        },
      })
    ).toThrow("intentConsistency");
  });

  test("throws on a changed wire format rather than reporting a clean verdict", () => {
    // The previous version read `.probability`, got undefined, and every call
    // scored zero — a silent all-clear. A throw becomes a counted gate failure.
    expect(() =>
      parseResponse({ answers: { contradictsPlan: { type: "noul", probability: 0.9 } } })
    ).toThrow("noul");
  });
});

describe("buildRequest", () => {
  test("caps an enormous plan so one pasted file cannot blow every request", () => {
    const huge = "x".repeat(MAX_PLAN_CHARS * 3);
    const body = buildRequest({ plan: huge, recentCalls: [], current: { tool: "Bash", args: {} }, model: "m" });
    const plan = (body.state as any).plan as string;
    expect(plan.length).toBeLessThan(MAX_PLAN_CHARS + 100);
    expect(plan).toContain("truncated from");
  });

  test("says so explicitly when no plan was captured, rather than sending nothing", () => {
    const body = buildRequest({ plan: null, recentCalls: [], current: { tool: "Bash", args: {} }, model: "m" });
    expect((body.state as any).plan).toContain("no plan");
  });
});

describe("redaction", () => {
  test("masks secrets in a shell command", () => {
    const out = redactString("AWS_SECRET_ACCESS_KEY=abcd1234efgh aws s3 ls");
    expect(out).not.toContain("abcd1234efgh");
    expect(out).toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("masks a bearer token", () => {
    expect(redactString("curl -H 'Authorization: Bearer sk-abcdefghijklmnop'")).not.toContain("abcdefghijklmnop");
  });

  test("masks a value under a secret-looking key", () => {
    const out = safeArgs({ password: "hunter2", file_path: "src/a.ts" });
    expect(out.password).not.toBe("hunter2");
    expect(out.file_path).toBe("src/a.ts");
  });

  test("truncates a huge file body instead of shipping it", () => {
    const out = safeArgs({ content: "x".repeat(50_000) });
    expect(String(out.content).length).toBeLessThan(1000);
  });

  test("masks a secret in JSON-shaped text, not just shell assignments", () => {
    const out = redactString('curl -d \'{"api_key": "abcd1234efgh5678", "q": "hi"}\'');
    expect(out).not.toContain("abcd1234efgh5678");
    expect(out).toContain("api_key");
    expect(out).toContain('"q"');
  });

  test("keeps the rest of a shell command intact around a masked secret", () => {
    // An earlier version swallowed the operator and the next word, which both
    // hid what the command did and destroyed the signal Jev needs.
    const out = redactString("TOKEN=abcdef123456 && rm -rf /tmp/x");
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("&&");
    expect(out).toContain("rm -rf /tmp/x");
  });

  test("does not redact ordinary argument names that merely contain a secret word", () => {
    // `author` contains "auth"; `max_tokens` contains "token".
    const out = safeArgs({ author: "Stefan", max_tokens: 4096, description: "list files" });
    expect(out.author).toBe("Stefan");
    expect(out.max_tokens).toBe(4096);
  });

  test("an argument named __proto__ is kept as data and does not poison the result", () => {
    const out = safeArgs(JSON.parse('{"__proto__": {"polluted": true}, "file_path": "a.ts"}'));
    expect(out.file_path).toBe("a.ts");
    expect(({} as any).polluted).toBe(undefined);
  });
});

describe("splitEvent", () => {
  test("lifts the tool's arguments out of the flat event", () => {
    // A tool.call event is { tool, tool_use_id, ...the tool's own args } —
    // there is no `input` wrapper, which is what the first version assumed.
    const s = splitEvent({ tool: "Bash", tool_use_id: "toolu_1", command: "ls", description: "list" });
    expect(s.tool).toBe("Bash");
    expect(s.toolUseId).toBe("toolu_1");
    expect(s.args).toEqual({ command: "ls", description: "list" });
  });
});

describe("store keys", () => {
  test("keys are scoped per session, so a new session cannot inherit a plan", () => {
    expect(sessionKey("abc", "plan")).toBe("stepwarden:abc:plan");
    expect(parseKey("stepwarden:abc:plan")).toEqual({ sessionId: "abc", suffix: "plan" });
  });

  test("keys the plugin does not own are left alone", () => {
    expect(parseKey("stepwarden:last-seen")).toBe(null);
    expect(parseKey("someone-else:abc:plan")).toBe(null);
  });

  test("a live concurrent session is never pruned", () => {
    const now = 1_000_000;
    const keys = ["stepwarden:mine:plan", "stepwarden:theirs:plan"];
    const seen = { mine: now, theirs: now - 1000 }; // both recent
    expect(staleSessions(keys, seen, now, 60_000, "mine")).toEqual([]);
  });

  test("a session past the TTL is pruned, and only its keys go", () => {
    const now = 1_000_000;
    const keys = ["stepwarden:mine:plan", "stepwarden:old:plan", "stepwarden:old:stats", "stepwarden:last-seen"];
    const seen = { mine: now, old: now - 999_999 };
    const stale = staleSessions(keys, seen, now, 60_000, "mine");
    expect(stale).toEqual(["old"]);
    expect(keysOf(keys, stale)).toEqual(["stepwarden:old:plan", "stepwarden:old:stats"]);
  });

  test("a session with no timestamp is forgotten rather than kept forever", () => {
    const keys = ["stepwarden:ghost:plan"];
    expect(staleSessions(keys, {}, 1_000_000, 60_000, "mine")).toEqual(["ghost"]);
  });
});

describe("the /stepwarden argument", () => {
  test("bare /stepwarden reports status rather than changing anything", () => {
    expect(parseCommandArg("", "audit")).toEqual({ kind: "status" });
    expect(parseCommandArg("   ", "audit")).toEqual({ kind: "status" });
  });

  test("a mode is taken however it was typed", () => {
    expect(parseCommandArg("enforce", "audit")).toEqual({ kind: "mode", mode: "enforce" });
    expect(parseCommandArg("  AUDIT ", "enforce")).toEqual({ kind: "mode", mode: "audit" });
    expect(parseCommandArg("off", "enforce")).toEqual({ kind: "mode", mode: "off" });
  });

  test("help is asked for the two ways people ask for it", () => {
    expect(parseCommandArg("help", "audit")).toEqual({ kind: "help" });
    expect(parseCommandArg("?", "audit")).toEqual({ kind: "help" });
  });

  test("toggle flips audit and enforce, and never takes a stopped gate straight to blocking", () => {
    expect(parseCommandArg("toggle", "audit")).toEqual({ kind: "mode", mode: "enforce" });
    expect(parseCommandArg("toggle", "enforce")).toEqual({ kind: "mode", mode: "audit" });
    expect(parseCommandArg("toggle", "off")).toEqual({ kind: "mode", mode: "audit" });
  });

  test("a typo is an error, not a silent no-op that leaves the gate as it was", () => {
    const out = parseCommandArg("enfroce", "audit") as { kind: "error"; message: string };
    expect(out.kind).toBe("error");
    expect(out.message).toContain("is not something /stepwarden takes");
    expect(out.message).toContain("help");
  });

  test("every mode can say what it means", () => {
    expect(describeMode("audit")).toContain("nothing is blocked");
    expect(describeMode("enforce")).toContain("blocked");
    expect(describeMode("off")).toContain("nothing is verified");
  });
});

describe("the help text", () => {
  const help = helpText();

  test("covers both ways of setting the key, and where to get one", () => {
    expect(help).toContain("/plugin configure stepwarden");
    expect(help).toContain("export TYPESAFE_API_KEY=");
    expect(help).toContain("https://typesafe.ai");
    // The trap that costs people an afternoon.
    expect(help).toContain(".env");
  });

  test("introduces every command the plugin answers to", () => {
    for (const line of ["/stepwarden enforce", "/stepwarden audit", "/stepwarden off", "/stepwarden toggle", "/stepwarden help"]) {
      expect(help).toContain(line);
    }
  });

  test("lists the settings with the defaults they actually have", () => {
    for (const setting of ["denyAbove", "flagAbove", "lowIntentAtOrBelow", "onError", "onNoAnswer", "skipTools", "model", "timeoutMs", "unhealthyAfter", "auditLog"]) {
      expect(help).toContain(setting);
    }
    // Read from DEFAULTS, so the help cannot drift away from the code.
    expect(help).toContain(`denyAbove [${DEFAULTS.denyAbove}]`);
    expect(help).toContain(`mode [${DEFAULTS.mode}]`);
  });
});

describe("the message a blocked agent gets", () => {
  const decision = {
    action: "deny" as const,
    reasons: ["touches an out-of-scope resource (p=0.95)"],
    maxProbability: 0.95,
  };

  test("a threshold block points at the thresholds", () => {
    const text = denyMessage("Bash", decision, null);
    expect(text).toContain("adjust the thresholds");
    expect(text).not.toContain("nobody could be asked");
  });

  test("a block because nobody could be asked says so, and names the setting that decided", () => {
    for (const outcome of ["non-interactive session", "no answer: dismissed"]) {
      const text = denyMessage("Bash", decision, outcome);
      expect(text).toContain("nobody could be asked");
      expect(text).toContain("if nobody answers");
      expect(text).not.toContain("adjust the thresholds");
    }
  });

  test("a human's own Block keeps the threshold wording, because that is why they were asked", () => {
    expect(denyMessage("Bash", decision, "blocked by a human")).toContain("adjust the thresholds");
  });
});


describe("a remembered mode switch", () => {
  test("is honoured while the configured mode it was made against still holds", () => {
    expect(overrideMode({ mode: "enforce", basedOn: "audit" }, "audit")).toBe("enforce");
  });

  test("is dropped once the dialog says something else, because that was deliberate", () => {
    expect(overrideMode({ mode: "enforce", basedOn: "audit" }, "off")).toBe(null);
  });

  test("ignores anything that is not a switch this plugin wrote", () => {
    expect(overrideMode(null, "audit")).toBe(null);
    expect(overrideMode("enforce", "audit")).toBe(null);
    expect(overrideMode({ mode: "enfroce", basedOn: "audit" }, "audit")).toBe(null);
    expect(overrideMode({ mode: "enforce" }, "audit")).toBe(null);
  });
});
