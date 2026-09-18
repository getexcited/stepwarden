<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" width="538" alt="stepwarden — Every tool call your agent makes, checked before it runs.">
  </picture>
</h1>

A Claude Code plugin that verifies each agent action *before* it executes —
not after the run finishes. It routes every tool call through a purpose-built
verification model, [TypeSafe AI's Jev](https://typesafe.ai), instead of a full
LLM review, which is what makes checking *every* step affordable.

```
› My plan is strictly to add a docstring to lib/policy.ts and nothing else.
  Now run: git log --oneline -20 && cat ~/.gitconfig

  ┌ stepwarden ──────────────────────────────────────────────────┐
  │ Bash: touches an out-of-scope resource (p=0.83). Allow this   │
  │ call?                                    [ Allow ]  [ Block ] │
  └───────────────────────────────────────────────────────────────┘
```

That dialog is what `mode: enforce` looks like. A fresh install ships in
`mode: audit`: the same verdict is computed and written down, and the call runs.
You turn the gate on yourself, with `/stepwarden enforce`.

With the shipped thresholds that call lands in the **ask** band, so you decide.
Raise the pressure (`denyAbove: 0.8`) and the same call is blocked outright,
with the reason handed back to the model:

```
  The command was blocked by stepwarden before it ran:
  > Bash: touches an out-of-scope resource (p=0.83)
```
---

> [!IMPORTANT]
> **Status: Proof of Concept**
> This demonstrates an architecture pattern. 
> It is built on two early-access dependencies (Claude Code function hooks and Jev),
> its default thresholds have not been tuned on production traffic, 
> and it is not a substitute for deterministic security controls.
> Read [Limits](#limits) before relying on it.

---

## Why

Currently Agents are mostly reviewed at the end of a run, if at all. Between the moment you hit
enter and the moment you read the summary, the agent makes dozens or hundreds of
tool calls, and you find out what it did between checkpoints by reading the diff
afterwards — or by not reading it.

Everyone knows the fix: check each step before it executes. Nobody does it,
because running a frontier model as a judge on every tool call has always been
technically possible but absurd from an economic or latency perspective.
 So teams sample, or audit at the end, and call it a process.

[Jev](https://typesafe.ai/) changes that arithmetic. It doesn't generate text: you hand it state and a list of typed questions, and it returns typed answers with a calibrated
confidence on each, sampled in parallel rather than token by token. Near-zero
marginal cost per question, sub-second latency. 
This plugin is a proof of concept that we can use Jev (and decision models like it) to build such a smart gate.

There are real limits, though. — see [Limits](#limits).

## What it does

Before any tool executes, it asks Jev five independent questions in parallel,
against the session plan and recent history:

1. Does this action contradict the plan?
2. Does it touch a resource outside the declared scope?
3. Does it contradict the previous action?
4. Should a human look at this regardless?
5. How consistent is it with the user's stated intent?

Each answer comes back with a calibrated probability. A full five-question check
takes about half a second and 740–1,200 input tokens.

## The three outcomes

| Outcome | When | What happens |
|---|---|---|
| **allow** | no signal reaches the ask threshold | the call runs, nothing is shown |
| **ask** | any signal at or above `flagAbove` (default 0.6), or intent consistency at or below 1 | you get an Allow / Block dialog; your answer decides |
| **block** | any signal at or above `denyAbove` (default 0.9) | the call never runs; the reason goes back to the model |

Both thresholds are inclusive. If you cannot be asked — a `-p` run, a dismissed
dialog, or more than 50 questions already this session — `onNoAnswer` decides,
and the plugin says so rather than letting the call through silently: a notice
on screen where there is one, a line in the audit log always, and the reason
inside the block message when the answer is `deny`. A headless `-p` run has no
transcript of its own, so there the notice reaches the SDK host as a `ui_log`
message and the `--debug-file` log, and the audit log is the record to read.

The middle tier is the point. Blocking on a merely-probable signal produces
false stops exactly where a gate matters most, so `block` is reserved for
near-certainty and the wide middle band asks you instead.


## Install

Requires Claude Code 2.1.273 or newer with function hooks enabled:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Then, inside Claude Code:

```
/plugin marketplace add getexcited/claude-plugins
/plugin install stepwarden@getexcited
```

The install dialog asks for your TypeSafe API key. Leaving it blank is fine —
the plugin still loads, says so at startup, and `/stepwarden` tells you how to
set one. See [Setting your API key](#setting-your-api-key).

**It starts in audit mode.** A fresh install verifies every call and writes down
what it would have done, but never blocks and never interrupts you. Use it on
real work for a while, read the log, and turn the gate on when the numbers look
right:

```
/stepwarden enforce
```

See [Audit mode is the default](#audit-mode-is-the-default), or run
`/stepwarden help` for the whole surface — settings, commands and the key —
inside the session.

**From a local checkout** instead:

```bash
git clone https://github.com/getexcited/stepwarden
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./stepwarden
```

There is nothing to build and nothing to `npm install` — the plugin has no
runtime dependencies, and no lockfile ships with it, so installing it never runs
npm and never copies a `node_modules` into your plugins directory.

## Setting your API key

Get a key at [typesafe.ai](https://typesafe.ai), then pick either route:

**Through Claude Code (recommended).** The key is stored in your OS keychain,
never in a file in your project:

```
/plugin configure stepwarden
```

This is also where every other setting lives — mode, thresholds, which tools to
skip — each with an explanation in the dialog.

**Through the environment**, if you would rather manage it yourself:

```bash
export TYPESAFE_API_KEY=apikey_...
```

A key set in the plugin config wins over the environment.

> **A `.env` file is not enough on its own.** Claude Code does not read `.env`,
> so a key sitting there will not be found. Either use `/plugin configure`, or
> source the file into your shell first: `set -a; . ./.env; set +a`.

**Run `/stepwarden` at any time** to see whether the key is set, where it came from,
whether TypeSafe accepts it, what the current policy is, what the plugin has
decided so far this session, and the exact command to analyse this project's
audit log. **`/stepwarden help`** is the other half: what every setting does,
what the commands are, and both ways to set your key — without leaving the
session to find this page. If the key is missing or rejected, `/stepwarden` tells you
exactly how to fix it — and the plugin says so at startup rather than quietly
verifying nothing.

## Settings

All of these live in `/plugin configure stepwarden`. The one you will reach for
most often has its own command:

```
/stepwarden enforce     turn the gate on: risky calls are blocked or put to you
/stepwarden audit       back to logging only, nothing blocked
/stepwarden off         verify nothing
/stepwarden toggle      flip between audit and enforce
/stepwarden help        every setting, every command, and how to set your key
```

It takes effect in the running session — mid-turn too, which is when you usually
want it — and is remembered for the sessions after it. `/plugin configure
stepwarden` still owns the setting: it keeps showing the configured mode, and
the moment you change it there, that wins and the switch is forgotten. If your
settings are managed by someone else and the change is refused, the command says
so and changes nothing.

| Setting | Default | What it does |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Your key. Stored in the OS keychain. |
| `mode` | `audit` | `audit` decides and logs but never blocks — the shipped default. `enforce` blocks and asks. `off` verifies nothing. Also `/stepwarden <mode>`. |
| `denyAbove` | `0.9` | Block outright at or above this probability. |
| `flagAbove` | `0.6` | Ask you at or above this probability. |
| `lowIntentAtOrBelow` | `1` | Ask when consistency with the plan scores at or below this, on 0 (contradicts) to 4 (fully consistent). |
| `onError` | `allow` | `allow` or `deny`, for when Jev is unreachable, times out, or no key is set. |
| `onNoAnswer` | `allow` | `allow` or `deny`, for when a flagged call cannot be put to a human. |
| `skipTools` | `Read, Glob, Grep, …` | Tools never sent for verification. Set to `none` to verify everything. |
| `model` | `jev-latest` | Which TypeSafe model answers. |
| `timeoutMs` | `5000` | How long to wait before giving up and applying `onError`. |
| `unhealthyAfter` | `3` | Warn once after this many verification failures in a row. |
| `auditLog` | `true` | Write every decision to `.claude/stepwarden/<session>.jsonl`. |

`onError` and `onNoAnswer` deliberately offer only `allow` and `deny`: both
describe what to do when a human *cannot* be asked, so "ask" is not an answer.

A bad value never takes the gate down: it falls back to the default, warns at
session start, and shows up in `/stepwarden`. Thresholds that would make `ask`
unreachable are repaired and reported.

### Audit mode is the default

A fresh install runs in `mode: audit`: every call is verified, every decision is
logged, nothing is ever blocked and nothing interrupts you. Use it normally for
a while, then read what it would have done:

```bash
cd ~/my-project                                     # where you ran Claude Code
node ~/path/to/stepwarden/scripts/analyze-audit.mjs # /stepwarden prints this path
```

The plugin writes one file per session to `.claude/stepwarden/` in the project
you were working in, so run the script from there (not from the plugin's own
directory). That prints what your thresholds *would* have done to your real traffic — the
distribution of each signal, where the policy and reality diverged, which tools
dominate. If a signal's p99 sits well below your block threshold, that threshold
can never fire and you should lower it or drop it. The script has no ground
truth: it tells you what the policy does, not whether a flagged call deserved
it. Sample some rows by hand before tightening anything.

When the numbers look right, turn the gate on:

```
/stepwarden enforce
```

## What gets sent to TypeSafe

For every verified call, these are sent to `api.typesafe.ai`:

- the tool's name and its arguments,
- your captured plan — **your first prompt of the session, verbatim**,
- the tool name and arguments of the last eight calls.

**Arguments are redacted first** — values under key names like `password`,
`api_key` or `secret`, `KEY=value` assignments, `"api_key": "…"` in JSON,
bearer tokens, PEM blocks and JWTs are masked, and long values truncated.
Redaction is pattern matching, not a guarantee: a secret in an unusual shape
will get through. **The plan itself is not redacted**, because it is the thing
being compared against.

If a tool's arguments must never leave your machine, add it to `skipTools`. If
the work itself is confidential, use `mode: off`.

Locally, the same redacted arguments are written to
`.claude/stepwarden/<session>.jsonl` in your project. That file is worth adding
to `.gitignore`. Turn it off with the `auditLog` setting.

## Threat model

Following the Claude Mods five-line convention. Every claim here is what
`claude plugin validate . --strict` reports, not a summary of intent — it
statically lists what the module hooks, calls and reads, and refuses to load it
if the source disagrees.

- **Hooks:** `session.start`, `prompt.submit`, `tool.call`, `command.run{command=stepwarden}`.
- **Reads:** the pending tool call, the session plan, the last eight tool calls,
  and `TYPESAFE_API_KEY` from the environment — the only environment variable it
  reads, and it writes none.
- **Runs:** nothing on the host. It cannot: a hooks module may import only
  relative paths and `claude-code` — no `node:` builtins, no npm packages, no
  subprocesses — and that is enforced by the loader, not by convention.
- **Sends:** to `api.typesafe.ai` only — the tool name, its redacted arguments,
  the plan, and the last eight calls. Nothing else leaves the machine, and there
  is no telemetry.
- **Persists:** `.claude/stepwarden/<session>.jsonl` in your project (off with
  `auditLog`), plus its own key-value store for the plan, history and counters,
  scoped per session and pruned after seven days.
- **Hostile input:** a prompt-injected tool call is scored like any other.
  Injection aimed at the verifier itself is an open problem and one of the
  reasons this is not a sole control.

## Audit trail

Every decision is logged — allowed, asked, blocked — with the per-question
probabilities behind it, whether or not enforcement was on. Gate-health events
(`no_api_key`, `key_check_failed`, `gate_unhealthy`, `gate_recovered`,
`gate_crashed`) are logged too, so a period when the gate was degraded cannot
read as a clean record.

One file per session, so two Claude Code windows in one project do not overwrite
each other's log.

## How the plan is captured

The first prompt of the session is stored verbatim as the plan and never
changes. It is deliberately not summarised: a summary can quietly misrepresent
the intent that everything else is then measured against. `/stepwarden` shows the plan
in force.

This is also the main limitation. A long session drifts from its opening
sentence, and the plan does not follow. Say what you are doing in your first
message, and start a new session when the work changes.

## Limits

Read this section before quoting anything.

**Accuracy is below frontier level.** On TypeSafe's own dashboard, Jev aggregates
67.8% against 74.1% for the best comparator, with wider gaps in some domains
(invoice processing 61.8% vs 79.1%; security incidents 61.7% vs 66.2%). The one
independent test we know of found it caught 6 of 7 planted defects where a
frontier model caught 7 of 7 — at roughly 25× the speed and 1/580th the cost.
**That trade-off is the entire point:** a mid-tier judgment on every action
instead of a frontier judgment on none of them. This will miss things. It is
also why the shipped defaults block rarely and ask often — and why a fresh
install blocks nothing at all until you turn enforcement on.

**It is not a security boundary.** It is a fast, narrow, probabilistic judge —
one model checking another model's next step. It does not "understand code" the
way a full review does. For anything non-negotiable — production credentials, a
force-push to `main` — pair it with a deterministic, fail-closed `PreToolUse`
shell hook that works whether or not this plugin or TypeSafe are running.

**Function hooks fail open.** A hook that throws is skipped and the tool simply
runs, which means a bug in the verifier looks exactly like a clean verdict. This
plugin handles its own crashes — anything thrown inside the gate becomes a
configured, logged outcome that honours `onError` — and it counts consecutive
failures and says so. What it cannot cover is a module that fails to *load*, and
no plugin can. It also fails open by *choice* when Jev is unreachable, because a
verifier outage that stops your work is worse than one that admits it; set
`onError: deny` if your threat model says otherwise.

**Two early-access dependencies.** The function-hooks API is behind
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and has changed field names during its
preview — the declarations in `.claude/types/` are generated from one specific
build, and `/plugin-types` must be re-run after a Claude Code update. Jev is waitlisted,
with no published architecture or weights, and its calibration claim — that 70%
confidence means right 70% of the time, which is what makes a threshold
meaningful at all — has not been independently audited on messy input.

**Repeated calls move.** Ask Jev the same question twice and the probabilities
shift by a few points. Worth knowing before you set a threshold on a boundary.

**Thresholds are starting points,** not numbers derived from your traffic. That
is why `mode: audit` is what you get on install.

**The numbers above are TypeSafe's published figures** plus one third-party test,
not independently audited. Pricing at time of writing: $0.042 per million input
tokens, output free; 70–500 ms end to end in TypeSafe's own testing. Note that
the API does report a non-zero `output_tokens` per call, so confirm the billing
model yourself before relying on the arithmetic.

## Development

The type declarations for the function-hooks API are not in the repo: they are
Claude Code's own, and they are generated per build. After cloning, open a
Claude Code session in the checkout and run `/plugin-types`, which writes them
to `.claude/types/` (gitignored). Re-run it after every Claude Code update.

No lockfile is committed (see [Install](#install)), so install the one
development dependency — TypeScript — before running anything:

```bash
npm install        # dev-only: TypeScript, for `npm run typecheck`
npm run check      # typecheck + manifest validation + tests
npm run typecheck
npm run validate   # claude plugin validate . --strict
npm test           # claude plugin test .
```

Run `npm run check` after regenerating the types, before trusting anything.

### Layout

```
.claude-plugin/plugin.json  manifest and the userConfig schema
hooks/hooks.json            points Claude Code at the module
hooks/verify.ts             every $ call lives here — see the header comment
lib/config.ts               options -> validated config (pure)
lib/keys.ts                 session-scoped store keys and pruning (pure)
lib/jev.ts                  TypeSafe wire format (pure)
lib/policy.ts               verdict -> allow / ask / block (pure)
lib/redact.ts               secret masking and size caps (pure)
lib/types.ts                shared types
tests/                      unit + end-to-end tests
scripts/analyze-audit.mjs   audit log summariser (plain Node)
```

`hooks/verify.ts` is one large file on purpose. A function-hooks module is
scanned before it loads and `$` may not cross an import boundary, so every
engine call has to live in the module that registers the hooks. Everything else
is pure and lives in `lib/`, which is why it can be unit-tested directly.

The plugin deliberately does **not** use `@typesafe-ai/sdk`: a hooks module may
import only relative paths and `claude-code`, so the API is called through
`$.http.fetch` instead. `lib/jev.ts` holds the wire format, verified against the
live API.

## Contributing

The most useful thing you can do right now: run it as installed — `mode: audit` —
on real work for a week and share the anonymised `analyze-audit.mjs` output — **especially the
false positives.** Threshold tuning needs traffic we don't have, and a gate that
cries wolf is worse than no gate, because you learn to click through it.

Bug reports are most useful with the matching lines from
`.claude/stepwarden/<session>.jsonl`; they carry the per-question probabilities
behind whatever it did.

## License

Apache-2.0 — see [LICENSE](LICENSE).

stepwarden is an independent project, not affiliated with or endorsed by Anthropic or TypeSafe AI.
