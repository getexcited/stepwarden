/**
 * End-to-end tests of the loaded plugin: a real tool.call dispatch through the
 * real hook, with the world beneath it mocked.
 *
 * `on` here registers hooks BENEATH the plugin under test, so:
 *   - on("http.fetch", ...) stands in for the TypeSafe API,
 *   - on("tool.call", ...) is the bottom of the chain and stands in for the
 *     tool actually running.
 * That makes the assertions about what the plugin does to a call, not about
 * what any mock returned.
 *
 * The plugin loads on the defaults in .claude-plugin/plugin.json — `claude
 * plugin test` ignores settings — so it starts in the shipped mode, `audit`.
 * The tests that need the gate to bite switch it the way a user does, with
 * `/stepwarden enforce`.
 */

import { describe, expect, mock, test } from "claude-code/testing";

/** A systemOne body with the four probabilities and an intent score. */
function jevBody(probs: [number, number, number, number], score = 4) {
  return JSON.stringify({
    model: "jev-test",
    answers: {
      contradictsPlan: { type: "noul", noul: probs[0] },
      outOfScope: { type: "noul", noul: probs[1] },
      contradictsPrevious: { type: "noul", noul: probs[2] },
      shouldFlag: { type: "noul", noul: probs[3] },
      intentConsistency: { type: "score", score, confidence: 0.9 },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}

/** Wires the world beneath the plugin. Returns a record of what was asked. */
function world(
  on: any,
  opts: {
    key?: string;
    verdict?: string;
    status?: number;
    answer?: string;
    configDeny?: string;
    configWritable?: boolean;
  } = {}
) {
  const store = new Map<string, unknown>();
  const said: string[] = [];
  const ids = { current: "test-session" };
  const seen = { verifications: 0, toolRan: 0, asked: 0, lastBody: "", store, said, ids };

  mock.clock(on, { now: 1_700_000_000_000 });
  mock.env(on, opts.key === undefined ? {} : { TYPESAFE_API_KEY: opts.key });

  // A real map rather than mock.store, so a test can read back what the plugin
  // stored and assert that nothing was lost.
  on("store.set", async ($: any, e: any) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)));
    return { value: undefined };
  });
  on("store.get", async ($: any, e: any) => ({ value: store.get(e.key) }));
  on("store.keys", async () => ({ value: [...store.keys()] }));
  on("store.delete", async ($: any, e: any) => {
    store.delete(e.key);
    return { value: undefined };
  });

  // A hook answering an engine op returns { value }, not the value itself.
  on("http.fetch", async ($: any, e: any) => {
    if (String(e.url).includes("/v1/models")) {
      return { value: { status: 200, ok: true, headers: {}, text: '{"models":[]}' } };
    }
    seen.verifications += 1;
    seen.lastBody = String(e.init?.body ?? "");
    const status = opts.status ?? 200;
    return {
      value: {
        status,
        ok: status >= 200 && status < 300,
        headers: {},
        text: opts.verdict ?? jevBody([0.05, 0.05, 0.05, 0.05]),
      },
    };
  });

  // The rest of the world beneath the plugin: display is a no-op, and the
  // bottom of the tool.call chain stands in for the tool actually running.
  // Kept, not dropped: several tests assert on what the user was actually told.
  on("ui.log", async ($: any, e: any) => {
    said.push(String(e.text ?? e.message ?? ""));
    return { value: undefined };
  });
  on("ui.toast", async ($: any, e: any) => {
    said.push(String(e.text ?? e.message ?? ""));
    return { value: undefined };
  });
  on("ui.notice", async () => ({ value: undefined }));
  on("command.register", async () => ({ value: undefined }));
  // `/stepwarden <mode>` tries the settings row the plugin owns first. By
  // default this behaves like the Claude Code the plugin ships against, which
  // exposes no plugin rows at all and rejects the write — the case that sends
  // the switch to the plugin's own store.
  on("config.set", async ($: any, e: any) => {
    if (opts.configDeny !== undefined) return { deny: opts.configDeny };
    if (opts.configWritable === true) return { value: e.value };
    throw new Error("$.config.set: no /config row with key stepwarden.mode");
  });
  on("session.start", async ($: any, e: any) => ({ cwd: e.cwd }));
  on("prompt.submit", async ($: any, e: any) => ({ text: e.text }));
  on("session.id", async () => ({ value: ids.current }));

  on("tool.call", async ($: any, e: any) => {
    // $.ui.ask is not an event — it runs the AskUserQuestion tool, so that is
    // where an answer is stubbed.
    if (e.tool === "AskUserQuestion") {
      seen.asked += 1;
      const q = e.questions?.[0]?.question ?? "";
      return { result: { answers: { [q]: opts.answer ?? "Block" } } };
    }
    seen.toolRan += 1;
    return { result: { stdout: "ok" } };
  });

  return seen;
}

const PLAN = "Fix the failing test in src/parser.ts. Do not touch production config.";

/** Turns the gate on the way a user does, and returns what the command said. */
async function enforce($: any): Promise<string> {
  const { text } = await $.command.run({ command: "stepwarden", args: "enforce" });
  return String(text);
}

async function startSession($: any, interactive = true) {
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: interactive });
  // The plan is captured from the session's first prompt, so drive that path
  // rather than seeding the store: it is what actually happens in a session.
  await $.prompt.submit({ text: PLAN });
}

describe("the gate", () => {
  test("lets a plainly-consistent call through", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "npm test", description: "run tests" });

    expect(seen.verifications).toBe(1);
    expect(seen.toolRan).toBe(1);
    expect((out as any).deny).toBe(undefined);
  });

  test("blocks a call when a signal is near-certain", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.97, 0.9, 0.1, 0.95], 0) });
    await startSession($);
    await enforce($);

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx", description: "cleanup" });

    expect(typeof (out as any).deny).toBe("string");
    expect((out as any).deny).toContain("stepwarden");
    // The tool must not have run.
    expect(seen.toolRan).toBe(0);
  });

  test("skips the tools on the skip list without calling the API at all", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    await $.tool.call({ tool: "Read", file_path: "/repo/src/parser.ts" });

    expect(seen.verifications).toBe(0);
    expect(seen.toolRan).toBe(1);
  });

  test("with no API key it does not block, and says so rather than looking clean", async ($: any, on: any) => {
    const seen = world(on, {}); // no key anywhere
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "npm test" });

    expect(seen.verifications).toBe(0);
    expect(seen.toolRan).toBe(1);
    expect((out as any).deny).toBe(undefined);
  });

  test("an API failure falls back to the configured policy and still runs the call", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test", status: 500 });
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "npm test" });

    // onError defaults to allow: an outage must not stop the user working.
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("redacts secrets out of what it sends to TypeSafe", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    await $.tool.call({ tool: "Bash", command: "AWS_SECRET_ACCESS_KEY=supersecret123 aws s3 ls" });

    expect(seen.lastBody).not.toContain("supersecret123");
    expect(seen.lastBody).toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("sends the captured plan so contradiction has something to check against", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    await $.tool.call({ tool: "Bash", command: "npm test" });

    expect(seen.lastBody).toContain("src/parser.ts");
  });

  test("a flagged call asks a human, and a 'Block' answer stops the call", async ($: any, on: any) => {
    // 0.7 sits between flagAbove (0.6) and denyAbove (0.9): the ask band.
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.7, 0.1, 0.1, 0.1]), answer: "Block" });
    await startSession($, true);
    await enforce($);

    const out = await $.tool.call({ tool: "Bash", command: "git push --force origin main" });

    expect(seen.asked).toBe(1);
    expect(typeof (out as any).deny).toBe("string");
    expect((out as any).deny).toContain("a human chose to block it");
    expect(seen.toolRan).toBe(0);
  });

  test("a flagged call a human allows goes through", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.7, 0.1, 0.1, 0.1]), answer: "Allow" });
    await startSession($, true);
    await enforce($);

    const out = await $.tool.call({ tool: "Bash", command: "git push --force origin main" });

    expect(seen.asked).toBe(1);
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("a flagged call in a non-interactive run cannot be approved by nobody, and says so", async ($: any, on: any) => {
    // 0.7 sits in the ask band. There is no human, so onNoAnswer decides.
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.7, 0.1, 0.1, 0.1]) });
    await startSession($, false);
    await enforce($);

    const out = await $.tool.call({ tool: "Bash", command: "git push --force" });

    // Default onNoAnswer is allow, so it proceeds — but it was verified, and a
    // call that quietly became an allow because nobody could be asked is the
    // exact failure this plugin exists to prevent, so it is announced.
    expect(seen.verifications).toBe(1);
    expect((out as any).deny).toBe(undefined);
    expect(seen.said.join(" ")).toContain("nobody could be asked");
    expect(seen.said.join(" ")).toContain("'if nobody answers' decided: allow");
  });
});

describe("concurrent batches", () => {
  // Claude Code dispatches tool calls in concurrent batches. $.store has no
  // compare-and-set, so a naive read-modify-write silently loses counts and
  // history entries. These pin the serialization that prevents that.
  test("every call in a concurrent batch is counted and recorded", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    const commands = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    await Promise.all(commands.map((c) => $.tool.call({ tool: "Bash", command: `echo ${c}` })));

    expect(seen.verifications).toBe(commands.length);
    expect(seen.toolRan).toBe(commands.length);

    const stats = seen.store.get("stepwarden:test-session:stats") as any;
    expect(stats.checked).toBe(commands.length);
    expect(stats.allowed).toBe(commands.length);

    // History keeps the most recent 8; with 8 concurrent calls none may be lost.
    const history = seen.store.get("stepwarden:test-session:history") as any[];
    expect(history.length).toBe(8);
    const recorded = history.map((h) => h.args.command).sort();
    expect(recorded).toEqual(commands.map((c) => `echo ${c}`).sort());
  });

  test("the audit log keeps a line for every concurrent call", async ($: any, on: any) => {
    let written = "";
    on("fs.read", async () => {
      throw new Error("ENOENT");
    });
    on("fs.write", async ($: any, e: any) => {
      written = String(e.text);
      return { value: undefined };
    });
    world(on, { key: "apikey_test" });
    await startSession($);

    await Promise.all(["a", "b", "c", "d"].map((c) => $.tool.call({ tool: "Bash", command: `echo ${c}` })));

    const verifications = written
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((d) => d.type === "verification");
    expect(verifications.length).toBe(4);
  });
});

describe("when the gate itself breaks", () => {
  // A hook that throws is skipped and the tool simply runs. Without a catch-all
  // the gate would fail open at the one moment it most needs to be visible.
  function brokenStore(on: any) {
    mock.clock(on, { now: 1_700_000_000_000 });
    mock.env(on, { TYPESAFE_API_KEY: "apikey_test" });
    on("session.id", async () => ({ value: "test-session" }));
    on("ui.log", async () => ({ value: undefined }));
    on("ui.toast", async () => ({ value: undefined }));
    on("command.register", async () => ({ value: undefined }));
    on("session.start", async ($: any, e: any) => ({ cwd: e.cwd }));
    on("prompt.submit", async ($: any, e: any) => ({ text: e.text }));
    on("fs.read", async () => {
      throw new Error("ENOENT");
    });
    on("fs.write", async () => ({ value: undefined }));
    on("store.get", async () => {
      throw new Error("store exploded");
    });
    on("store.set", async () => {
      throw new Error("store exploded");
    });
    on("store.keys", async () => {
      throw new Error("store exploded");
    });
  }

  test("a crash inside the gate is reported, not swallowed into a silent allow", async ($: any, on: any) => {
    let ran = 0;
    brokenStore(on);
    on("http.fetch", async () => ({
      value: { status: 200, ok: true, headers: {}, text: jevBody([0.05, 0.05, 0.05, 0.05]) },
    }));
    on("tool.call", async () => {
      ran += 1;
      return { result: { stdout: "ok" } };
    });

    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
    const out = await $.tool.call({ tool: "Bash", command: "npm test" });

    // onError defaults to allow, so the call proceeds — but it proceeds through
    // the plugin's own handled path, not by the hook vanishing.
    expect((out as any).deny).toBe(undefined);
    expect(ran).toBe(1);
  });

  test("a total API failure still runs the call through the handled path", async ($: any, on: any) => {
    let ran = 0;
    brokenStore(on);
    on("http.fetch", async () => {
      throw new Error("network exploded");
    });
    on("tool.call", async () => {
      ran += 1;
      return { result: { stdout: "ok" } };
    });

    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: false });
    const out = await $.tool.call({ tool: "Bash", command: "npm test" });

    // The default onError is allow, so the call proceeds — the point is that it
    // proceeds deliberately, having been recorded, rather than by the hook dying.
    expect((out as any).deny).toBe(undefined);
    expect(ran).toBe(1);
  });
});

describe("the shipped default", () => {
  // These are the tests that a fresh install cannot block. They fail loudly if
  // anyone flips plugin.json's default back to enforce.
  test("verifies a near-certain call, records the block it did not make, and runs it", async ($: any, on: any) => {
    let written = "";
    on("fs.exists", async () => ({ value: false }));
    on("fs.write", async ($: any, e: any) => {
      written = String(e.text);
      return { value: undefined };
    });
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.97, 0.9, 0.1, 0.95], 0) });
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });

    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
    const entry = written
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .find((d) => d.type === "verification");
    expect(entry.shadowAction).toBe("deny");
    expect(entry.effectiveAction).toBe("allow");
  });

  test("never opens the Allow/Block dialog", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.7, 0.1, 0.1, 0.1]), answer: "Block" });
    await startSession($, true);

    const out = await $.tool.call({ tool: "Bash", command: "git push --force origin main" });

    expect(seen.asked).toBe(0);
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });
});

describe("/stepwarden", () => {
  const NEAR_CERTAIN = { key: "apikey_test", verdict: jevBody([0.97, 0.9, 0.1, 0.95], 0) };

  test("enforce turns the gate on for this session and keeps it for the next", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);

    const text = await enforce($);
    expect(text).toContain("Mode is now enforce");
    expect(text).toContain("next sessions");

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });
    expect(typeof (out as any).deny).toBe("string");
    expect(seen.toolRan).toBe(0);
  });

  test("toggle flips back, and the gate stops blocking", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);
    await enforce($);

    const { text } = await $.command.run({ command: "stepwarden", args: "toggle" });
    expect(String(text)).toContain("Mode is now audit");

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("a typo changes nothing, and says what to type instead", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);

    const { text } = await $.command.run({ command: "stepwarden", args: "enfroce" });
    expect(String(text)).toContain("is not something /stepwarden takes");

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("a refused write leaves the running session as the config says", async ($: any, on: any) => {
    // Managed settings or an organization policy can own the row. A session
    // that started enforcing anyway would be enforcing something the stored
    // config refused.
    const seen = world(on, { ...NEAR_CERTAIN, configDeny: "managed settings own this row" });
    await startSession($);

    const text = await enforce($);
    expect(text).toContain("your settings refused the change");

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("help explains the settings, the commands and the key, and changes nothing", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);

    const { text } = await $.command.run({ command: "stepwarden", args: "help" });
    const out = String(text);

    expect(out).toContain("/plugin configure stepwarden");
    expect(out).toContain("export TYPESAFE_API_KEY=");
    expect(out).toContain("/stepwarden toggle");
    expect(out).toContain("denyAbove");

    // Help is not a mode switch: the gate is still on the shipped default.
    const call = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });
    expect((call as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });

  test("bare, it opens with the key line and prints a command that can be pasted", async ($: any, on: any) => {
    world(on, { key: "apikey_test" });
    await startSession($);

    const { text } = await $.command.run({ command: "stepwarden" });
    const out = String(text);

    // The host draws the plugin's name above this, so a leading blank line
    // rendered as a bare "stepwarden:" row.
    expect(out.split("\n")[0]).toContain("API key");
    expect(out).toContain("Mode:      audit");
    expect(out).toContain("scripts/analyze-audit.mjs");
    expect(out).not.toContain("<plugin>");
  });
});

describe("more than one session in one module", () => {
  test("two sessions keep their own audit logs", async ($: any, on: any) => {
    // The buffer is memoised for speed, and the path is derived from the
    // session id at write time: one shared buffer would write one session's
    // lines into the other session's file.
    const writes: Array<[string, string]> = [];
    on("fs.exists", async () => ({ value: false }));
    on("fs.write", async ($: any, e: any) => {
      writes.push([String(e.path), String(e.text)]);
      return { value: undefined };
    });
    const seen = world(on, { key: "apikey_test" });
    await startSession($);

    await $.tool.call({ tool: "Bash", command: "echo first" });
    seen.ids.current = "second-session";
    await $.tool.call({ tool: "Bash", command: "echo second" });

    // The engine resolves the plugin's relative path against the project.
    const latest = new Map(writes); // last write wins, per path
    const fileFor = (id: string) =>
      [...latest.entries()].find(([path]) => path.endsWith(`.claude/stepwarden/${id}.jsonl`))?.[1] ?? "";
    const first = fileFor("test-session");
    const second = fileFor("second-session");

    expect(first).toContain("echo first");
    expect(first).not.toContain("echo second");
    expect(second).toContain("echo second");
    expect(second).not.toContain("echo first");
  });

  test("a mode switch in one session does not turn the gate on in the other", async ($: any, on: any) => {
    const seen = world(on, { key: "apikey_test", verdict: jevBody([0.97, 0.9, 0.1, 0.95], 0) });
    await startSession($);
    await enforce($);

    seen.ids.current = "second-session";
    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });

    // The other session keeps the stored config until it loads again.
    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
  });
});

describe("remembering a mode switch", () => {
  const NEAR_CERTAIN = { key: "apikey_test", verdict: jevBody([0.97, 0.9, 0.1, 0.95], 0) };
  const OVERRIDE_KEY = "stepwarden:mode-override";

  test("a host with no plugin config row still keeps the switch, in the plugin's own store", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);

    const text = await enforce($);

    expect(text).toContain("Mode is now enforce");
    // The dialog still holds the configured value, and the message says so
    // rather than claiming a setting it could not write.
    expect(text).toContain("/plugin configure stepwarden still says audit");
    expect(seen.store.get(OVERRIDE_KEY)).toEqual({ mode: "enforce", basedOn: "audit" });
  });

  test("a host that does write plugin config is used, and nothing is left shadowing it", async ($: any, on: any) => {
    const seen = world(on, { ...NEAR_CERTAIN, configWritable: true });
    await startSession($);

    const text = await enforce($);

    expect(text).toContain("Saved: new sessions start in enforce");
    expect(seen.store.get(OVERRIDE_KEY)).toBe(undefined);
  });

  test("a remembered switch is in force from the start of the next session", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    seen.store.set(OVERRIDE_KEY, { mode: "enforce", basedOn: "audit" });
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });

    expect(typeof (out as any).deny).toBe("string");
    expect(seen.toolRan).toBe(0);
  });

  test("a switch made against a different configured mode is stale, and the dialog wins", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    // Made when the configured mode was `off`; the configuration now says
    // `audit`, so somebody changed it in the dialog and meant it.
    seen.store.set(OVERRIDE_KEY, { mode: "enforce", basedOn: "off" });
    await startSession($);

    const out = await $.tool.call({ tool: "Bash", command: "rm -rf /etc/nginx" });

    expect((out as any).deny).toBe(undefined);
    expect(seen.toolRan).toBe(1);
    expect(seen.store.get(OVERRIDE_KEY)).toBe(undefined);
  });

  test("switching back to the configured mode forgets the switch rather than pinning it", async ($: any, on: any) => {
    const seen = world(on, NEAR_CERTAIN);
    await startSession($);
    await enforce($);
    expect(seen.store.get(OVERRIDE_KEY)).toEqual({ mode: "enforce", basedOn: "audit" });

    const { text } = await $.command.run({ command: "stepwarden", args: "audit" });

    expect(String(text)).toContain("Mode is now audit");
    expect(seen.store.get(OVERRIDE_KEY)).toBe(undefined);
  });
});
