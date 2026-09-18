#!/usr/bin/env node
/**
 * Summarises the audit log so that "run it as installed — in audit mode — for a
 * week and then set the thresholds" becomes an actual next step rather than a
 * pile of JSONL.
 *
 * The plugin writes one file per session to .claude/stepwarden/<session>.jsonl
 * in the project you ran Claude Code in — so RUN THIS FROM THAT PROJECT, not
 * from the plugin's own directory (`/stepwarden` prints the command with the
 * real path for your install):
 *
 *   cd ~/my-project
 *   node ~/path/to/stepwarden/scripts/analyze-audit.mjs
 *   node ~/path/to/stepwarden/scripts/analyze-audit.mjs <file-or-dir>
 *
 * Plain Node, no dependencies, no Claude Code needed. It describes what the
 * CURRENT thresholds do to the traffic you actually saw. It does not know
 * ground truth — whether a flagged call was genuinely bad — so treat it as a
 * sampling aid, not an auto-tuner.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// The plugin writes one file per session under .claude/stepwarden/, so the
// default target is that directory; a single file still works.
const DEFAULT_LOG = path.join(process.cwd(), ".claude", "stepwarden");
const target = process.argv[2] ?? DEFAULT_LOG;

if (!existsSync(target)) {
  console.error(`No audit log at ${target}`);
  console.error("");
  console.error("This script reads the log from the project you ran Claude Code in, so run it there:");
  console.error("  node <path-to-plugin>/scripts/analyze-audit.mjs            # .claude/stepwarden/");
  console.error("  node <path-to-plugin>/scripts/analyze-audit.mjs <file|dir>");
  console.error("");
  console.error("If the plugin is running, check that the audit-log option is on — run /stepwarden.");
  process.exit(1);
}

const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(target, f))
      .sort()
  : [target];

if (files.length === 0) {
  console.error(`No .jsonl files in ${target} — nothing has been logged yet.`);
  process.exit(1);
}

const lines = [];
for (const file of files) {
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.trim().length > 0) lines.push(line);
  }
}

const entries = [];
let unparseable = 0;
for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    unparseable++;
    continue;
  }
  // A bare `null` or a JSON scalar parses fine but is not an entry; keeping it
  // would crash every `e.type` read downstream.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    unparseable++;
    continue;
  }
  entries.push(parsed);
}

const verifications = entries.filter((e) => e.type === "verification");
const events = entries.filter((e) => e.type !== "verification");

function countBy(arr, keyFn) {
  const counts = new Map();
  for (const item of arr) {
    const key = keyFn(item) ?? "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function printCounts(title, counts) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${title}`);
  if (total === 0) {
    console.log("  (nothing)");
    return;
  }
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${String(key).padEnd(24)} ${String(count).padStart(6)}  ${pct}%`);
  }
}

/** Nearest-rank percentile. Guards the index so p99 of a short list is not undefined. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

console.log(`${target}  (${files.length} file${files.length === 1 ? "" : "s"})`);
console.log(`  ${lines.length} lines, ${unparseable} unparseable`);
console.log(`  ${verifications.length} verifications, ${events.length} other events`);

printCounts("What the policy decided (shadowAction)", countBy(verifications, (e) => e.shadowAction));
printCounts("What actually happened (effectiveAction)", countBy(verifications, (e) => e.effectiveAction));
printCounts("By tool", countBy(verifications, (e) => e.tool));
printCounts(
  "Outcome of asking a human",
  countBy(
    verifications.filter((e) => e.askOutcome),
    (e) => e.askOutcome
  )
);
if (events.length > 0) printCounts("Gate events", countBy(events, (e) => e.type));

const failed = verifications.filter((e) => e.failure);
if (failed.length > 0) {
  printCounts(
    `Verification failures (${failed.length} of ${verifications.length})`,
    countBy(failed, (e) => String(e.failure).slice(0, 60))
  );
}

// Where the policy and reality parted: audit mode, a human's answer, or a
// fallback. These are the rows worth reading one by one.
const diverged = verifications.filter((e) => e.shadowAction !== e.effectiveAction);
console.log(`\nShadow/effective divergence: ${diverged.length} of ${verifications.length}`);
for (const e of diverged.slice(0, 10)) {
  const reasons = Array.isArray(e.reasons) ? e.reasons.join("; ") : String(e.reasons ?? "");
  console.log(`  ${e.tool}: ${e.shadowAction} -> ${e.effectiveAction}   ${reasons.slice(0, 90)}`);
}
if (diverged.length > 10) console.log(`  … and ${diverged.length - 10} more`);

// Signal distribution: the point of the exercise. If p99 of a signal sits well
// below your denyAbove, that threshold can never fire on your traffic.
const withSignals = verifications.filter((e) => Array.isArray(e.signals) && e.signals.length > 0);
console.log("\nSignal distribution (only calls where Jev answered):");
if (withSignals.length === 0) {
  console.log("  (no verdicts captured yet)");
} else {
  const byKey = new Map();
  for (const e of withSignals) {
    for (const s of e.signals) {
      if (typeof s?.probability !== "number") continue;
      const key = typeof s.key === "string" && s.key.length > 0 ? s.key : "(unnamed)";
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s.probability);
    }
  }
  for (const [key, values] of byKey) {
    values.sort((a, b) => a - b);
    const f = (v) => (v === null ? " n/a" : v.toFixed(2));
    console.log(
      `  ${key.padEnd(22)} n=${String(values.length).padStart(5)}  ` +
        `p50=${f(percentile(values, 50))}  p90=${f(percentile(values, 90))}  ` +
        `p99=${f(percentile(values, 99))}  max=${f(values[values.length - 1])}`
    );
  }

  const intents = withSignals.map((e) => e.intent?.score).filter((v) => typeof v === "number");
  if (intents.length > 0) {
    intents.sort((a, b) => a - b);
    console.log(
      `  ${"intentConsistency".padEnd(22)} n=${String(intents.length).padStart(5)}  ` +
        `p10=${percentile(intents, 10).toFixed(2)}  p50=${percentile(intents, 50).toFixed(2)}  ` +
        `(0 contradicts … ${withSignals[0]?.intent?.max ?? 4} fully consistent)`
    );
  }
}

const usage = verifications.reduce(
  (acc, e) => ({
    input: acc.input + (e.usage?.inputTokens ?? 0),
    output: acc.output + (e.usage?.outputTokens ?? 0),
  }),
  { input: 0, output: 0 }
);
if (usage.input > 0) {
  console.log(`\nJev usage: ${usage.input} input tokens, ${usage.output} output tokens across ${verifications.length} calls`);
}

console.log(`
How to read this
  - If p99 of a signal sits well below your block threshold, that threshold can
    never fire on your traffic: lower it, or accept that it is decorative.
  - If most calls land on 'flag', your ask threshold is too low and you are
    training yourself to click through the dialog.
  - Read the divergence rows individually before tightening anything: they are
    the calls where the policy and what happened disagreed.
  - There is no ground truth here. Sample some 'flag' rows by hand and decide
    whether they were actually worth stopping.`);
