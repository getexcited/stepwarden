# Changelog

All notable changes to stepwarden are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-18

First public release. Proof of concept: the architecture is the point, the
default thresholds have not been tuned on production traffic, and both
dependencies — Claude Code function hooks and TypeSafe's Jev — are early access.

### Added

- Pre-execution verification of every tool call. Five independent questions are
  put to Jev in parallel against the session plan and recent history, before the
  call runs.
- Three outcomes per call: allow, ask, block. The ask band renders an
  Allow/Block dialog through `$.ui.ask`; a block hands the reason back to the
  agent instead of the tool result.
- Ships in `audit` mode. A fresh install verifies every call and records what
  it would have done, and blocks nothing until you ask it to. Thresholds that
  have never seen your traffic do not get to stop your work.
- `/stepwarden enforce` (also `audit`, `off`, `toggle`) switches the mode from
  the prompt, mid-turn included. It applies to the running session and is
  remembered for later ones. `/plugin configure stepwarden` still owns the
  setting, and changing it there wins; a change your settings refuse does
  nothing and says so.
- Configurable policy via `/plugin configure stepwarden`: `mode`
  (`audit` by default, `enforce`, `off`), `denyAbove`, `flagAbove`, `lowIntentAtOrBelow`,
  per-tool `skipTools`, `model`, `timeoutMs`.
- Explicit failure policy. `onError` decides what happens when Jev is
  unreachable, times out, or no key is set; `onNoAnswer` decides what happens to
  a flagged call that cannot be put to a human. Neither path can silently read
  as a clean verdict: a flagged call nobody could be asked about says so on
  screen, in the audit log, and — when it blocks — in the message handed back to
  the agent, which names the setting that blocked it rather than the thresholds.
- Health reporting: consecutive verification failures are counted and surfaced
  after `unhealthyAfter`, so a silent outage is visible rather than looking like
  a quiet gate.
- `/stepwarden help`: what every setting does with its default, what each
  command is for, and both ways to set the TypeSafe API key — including the
  `.env` trap — without leaving the session.
- `/stepwarden` status command, registered at runtime from the `session.start`
  hook. Reports whether a key is set and where it came from, whether TypeSafe
  accepts it, the active policy, the session's decisions so far, and the exact
  command to analyse this project's audit log.
- Audit log at `.claude/stepwarden/<session>.jsonl`, one file per session,
  carrying the per-question probabilities behind every decision. Tool arguments
  are redacted, though not perfectly.
- `scripts/analyze-audit.mjs`, a dependency-free summariser for calibrating
  thresholds against real traffic.
- Graceful unconfigured path: with no API key the plugin still loads, warns at
  startup, and points at `/plugin configure stepwarden`.

### Notes

- Requires Claude Code 2.1.273 or newer with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- No runtime dependencies. TypeSafe is called over `$.http.fetch` rather than
  `@typesafe-ai/sdk`, because a hooks module may import only relative paths and
  `claude-code`. No lockfile is committed either: Claude Code installs a
  plugin's dependencies only when it finds both a `package.json` and a lockfile
  at its root, so installing stepwarden runs no npm and copies no
  `node_modules`. `package.json` stays for the development scripts.

[0.1.0]: https://github.com/getexcited/stepwarden/releases/tag/v0.1.0
