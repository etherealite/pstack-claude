# Run Codex tests

Top-level test modules check plugin installation, live agent behavior, and the waiting detector and replay tooling.
The `fixtures/` directory contains recorded waiting traces.
The `harness/` directory contains the session runner, its tests and fake CLI fixture, and the plugin fixture builder.

| Modules | What they check | Requirements |
| --- | --- | --- |
| `harness/harness.test.mjs` | Isolated homes, CLI arguments, installation commands, authentication, logs, rollout lookup, timeouts, and cleanup through a scripted CLI subprocess. | Bun. No Codex installation, credentials, or model calls. |
| `wait-trace.test.mjs`, `replay-waits.test.mjs` | Trace classification and replay exit codes against synthetic and captured traces. | Bun. No credentials or model calls. |
| `installation.test.mjs` | Real Codex installation preserves the generated native skill and this checkout's pstack skill source. | Codex CLI and `PSTACK_CODEX_INSTALL=1`. No credentials or model calls. |
| `live.test.mjs`, `waiting.test.mjs` | Skill invocation, replies, delegation, and waiting choices made by a live agent. | Codex CLI, credentials, and `PSTACK_CODEX_LIVE=1`. Results depend on the model. |

Run the deterministic contracts from the repository root.

```powershell
bun test tests/codex/harness tests/codex/wait-trace.test.mjs tests/codex/replay-waits.test.mjs
```

Run the installation integration tests independently of live agents.

```powershell
$env:PSTACK_CODEX_INSTALL='1'
bun test tests/codex/installation.test.mjs
```

A default `bun test tests/codex` runs the deterministic contracts and skips both optional suites.
`harness/harness.mjs` authenticates only when a test calls `exec`, so installation checks do not copy or require credentials.
`harness/native-plugin.mjs` supplies the same generated plugin to the installation and live invocation tests.

## Reproduce Codex agent waiting

The planning investigation reproduced repeated short waits on Codex CLI 0.163.0 with pstack 0.9.93,
using `gpt-6.1-sol` at low effort. The live regression made five short waits for its explainer,
with three timeout-and-retry transitions. Its first request was for one second, which Codex clamped to ten seconds.
The recorded planning conversation made two 10-second waits, with one timeout-and-retry transition.
Neither trace contains an empty wait.
The separate report of waiting with no working agents remains unreproduced.

To test the working plugin in a fresh Codex session, enable the live suite.
Run these commands from the repository root with `codex` and `bun` on `PATH`.
The waiting test registers this checkout as its marketplace source in a temporary Codex home.
Codex installs a regular copy into that home's plugin cache. There is no extra staging copy of the source.
The native invocation smoke test builds its own temporary marketplace because its plugin is a generated fixture.
Both tests remove copied credentials after each run.

```powershell
$env:PSTACK_CODEX_LIVE='1'
$env:PSTACK_CODEX_LIVE_KEEP='1'
bun test tests/codex/waiting.test.mjs --test-name-pattern planning-investigation
```

Run `bun test tests/codex/live.test.mjs tests/codex/waiting.test.mjs` with `PSTACK_CODEX_LIVE=1` to include the native invocation smoke test.

Each scenario is a named test. Select one with `--test-name-pattern`, or omit the filter to run all six scenarios.

| Scenario | What the parent does |
| --- | --- |
| `planning-investigation` | Answers the original planning question through `pstack:how`. Checks empty waits and repeated short waits. |
| `completed-agents` | Delegates two file reads, computes a sum, and combines the results. |
| `no-agents` | Reads a file directly, with delegation forbidden. |
| `review-round` | Collects two reader reports, then starts two fresh reviewers. |
| `stale-handoff` | Resumes a note that refers to unfinished readers from an ended session. |
| `empty-wait-control` | Intentionally calls `wait_agent` with no agents to calibrate the detector. |

For another model, set `PSTACK_CODEX_LIVE_MODEL`.
For another reasoning effort, set `PSTACK_CODEX_WAIT_EFFORT`.
The planning case defaults to `gpt-6.1-sol` at `low`, matching the recorded conversation.
Other cases default to `gpt-6-luna` at `xhigh`.
Workers inherit the parent model. Hooks stay disabled to isolate explicit skill invocation.

Open `wait-summary.json` in the artifact directory printed by the test.
The directory also contains the prompt, model settings, CLI version, source revision, plugin diff, and session logs.
Failures preserve artifacts even without `PSTACK_CODEX_LIVE_KEEP`.

The ordinary scenarios fail if a new wait occurs after all workers have completed and delivered their final answers.
A wait that starts while a worker is active is valid, even if the worker finishes during that wait.
A completed worker whose result has not arrived is recorded as `pending-result`.
Unsupported or incomplete traces fail the coverage check.

The planning case also fails when a wait of at most 10 seconds times out and the parent requests
another such wait for the same active agents, without intervening work, incoming messages, or agent lifecycle changes.
Outgoing messages and agent listings do not count as independent work for this check.
Ten seconds matches the observed behavior. It is a scenario policy, not a universal rule that every short wait is wrong.
The prompt requests the planning investigation and its workflow. It does not tell the model to wait or select a timeout.
A live run can choose a different strategy, so a passing run means that attempt did not reproduce the pattern.

To verify the detector against a real empty wait, select `empty-wait-control` and rerun the live test.
That control passes only when it captures one empty wait that times out.
It forces the unwanted tool use. It does not establish that pstack causes the same behavior during ordinary work.

To check a saved parent rollout without another model call, run the replay command.
Use the rollout path from `wait-summary.json`.

```powershell
bun tests/codex/replay-waits.mjs '<parent-rollout.jsonl>'
```

The replay exits with `1` when it detects an empty wait, `0` for a complete trace without one, or `2` for incomplete evidence.
Add `--short-waits` to also fail on the planning case's short wait retries.

The captured fixtures make detection deterministic without credentials or another model call.

```powershell
bun tests/codex/replay-waits.mjs tests/codex/fixtures/planning-original.jsonl --short-waits
bun tests/codex/replay-waits.mjs tests/codex/fixtures/planning-live.jsonl --short-waits
```

Both commands should exit `1` and report `emptyWaits: 0`.
The original fixture reports `shortWaitRetries: 1`; the live regression fixture reports `shortWaitRetries: 3`.
Without `--short-waits`, both exit `0` because their agents were running.

`planning-original.jsonl` comes from the planning conversation's turn at 2026-10-19 08:17 UTC,
thread `01a152e3-87cb-7442-b7ba-f070ab941cdc`.
`planning-live.jsonl` comes from the fresh isolated regression run at 10:50 UTC,
thread `01a153c9-385c-7143-89f6-cfc8120d1b15`.
The fixtures retain timestamps, tool identities, activity, wait arguments and results, final-answer delivery, and turn boundaries.
They omit personal metadata, reasoning, token counters, and the contents of commands, messages, and reports.
Independent tool calls remain present so omissions cannot turn intervening work into apparent polling.
