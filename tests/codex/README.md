# Run Codex tests and benchmarks

The directories distinguish deterministic tests, credential-dependent integration tests, paid model benchmarks, and command-line tools:

```text
tests/codex/
  *.test.mjs
  fixtures/
  harness/
  integration/*.test.mjs
benchmarks/codex/
  waiting-controlled.mjs
  waiting-control.mjs
  waiting-full-inference.mjs
  empty-wait-calibration.mjs
  support/waiting-suite.mjs
  support/waiting-report.mjs
tools/codex/
  replay-waits.mjs
  sanitize-waits.mjs
  lib/wait-trace.mjs
  lib/skill-exposure.mjs
```

Files ending in `.test.mjs` are test suites. `harness`, `support`, and `lib` hold imported helpers.
Files directly under `benchmarks/codex` are explicitly selected model runs; files directly under `tools/codex` are commands.

| Files | Evidence | Requirements |
| --- | --- | --- |
| `harness/harness.test.mjs` | Isolated sessions, CLI arguments, authentication cleanup, logs, and rollout lookup through a scripted CLI. | Bun. |
| `harness/controlled-workers.test.mjs` | Parent forwarding, local worker responses, refusal of paid worker fallbacks, and answer formatting. | Bun; no model calls. |
| `wait-trace.test.mjs` | Agent states, pending delivery, empty waits, short retries, and incomplete traces. | Bun. |
| `replay-waits.test.mjs` | Replay CLI output and exit codes. | Bun. |
| `sanitize-waits.test.mjs` | Fixture redaction preserves classifications, request boundaries, and recorded token usage. | Bun. |
| `skill-exposure.test.mjs` | Skill content matching, partial excerpts, call evidence, and exclusion of mere path mentions. | Bun. |
| `waiting-report.test.mjs` | Console metrics preserve undesirable behavior and distinguish missing measurements from zero. | Bun. |
| `integration/installation.test.mjs` | Real plugin installation preserves skill source. | Codex CLI and existing `PSTACK_CODEX_INSTALL=1`. |
| `integration/live.test.mjs` | A generated native plugin invokes its installed skill. | Codex credentials and existing `PSTACK_CODEX_LIVE=1`. |
| `benchmarks/codex/waiting-controlled.mjs` | One current-checkout observation with scheduled local worker responses. | ChatGPT credentials and explicit file selection; only parent inference goes upstream. |
| `benchmarks/codex/waiting-control.mjs` | One optional no-plugin control observation. | ChatGPT credentials and explicit file selection; only parent inference goes upstream. |
| `benchmarks/codex/waiting-full-inference.mjs` | One current-checkout observation with real reviewers, for occasional calibration. | Codex credentials and explicit file selection; all four agents use inference. |
| `benchmarks/codex/empty-wait-calibration.mjs` | A deliberately forced empty wait checks the live trace format. | Codex credentials and explicit file selection. |

Run the deterministic suite without credentials or model calls.

```powershell
bun test tests/codex
```

The model benchmarks live outside the configured `tests` root and run only when explicitly selected by path.
The existing installation and native invocation tests retain their existing switches.

## Replay recorded delegation behaviors

The fixtures capture three behaviors from the corpus-free review on Codex CLI 0.163.0 with real parent inference and scripted workers.
The polling and automatic-result runs use `gpt-6.1-sol @low`; the interruptible-wait run uses `gpt-6-luna @medium`.

| Fixture | Waits | Timeouts | Short retries | Delivered worker results | Parent inference requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| `active-worker-polling.jsonl` | 3 | 1 | 1 | 3 | 10 |
| `interruptible-waits.jsonl` | 3 | 0 | 0 | 3 | 14 |
| `automatic-results.jsonl` | 0 | 0 | 0 | 3 | 7 |

All three have zero empty waits. Synthetic detector tests cover empty waits separately.
The active-worker waits request ten seconds; the interruptible waits request one hour and return early on results.
The automatic-results recording demonstrates that worker results arrive without explicit waits, while the parent still uses inference.
These are behavior regression fixtures, not evidence of pstack causation or a ranking of efficiency.
They replace the overlapping planning recordings, which remain in Git history.

Replay without another model call:

```powershell
bun tools/codex/replay-waits.mjs tests/codex/fixtures/active-worker-polling.jsonl --short-waits
bun tools/codex/replay-waits.mjs tests/codex/fixtures/interruptible-waits.jsonl --short-waits
bun tools/codex/replay-waits.mjs tests/codex/fixtures/automatic-results.jsonl --short-waits
```

The polling fixture exits with code 1 under `--short-waits`, reporting one retry.
The other two exit with code 0 under both replay policies.
Without `--short-waits`, all three exit with code 0 because none contains an empty wait.
Exit code 2 means evidence is incomplete.

`fixtures/manifest.json` records source comparison blocks, conditions, thread IDs, expected metrics, and token totals.
The polling fixture comes from the current-pstack condition in the 2026-10-24 `t3FYKH` block.
The interruptible fixture comes from the current-pstack Luna-medium run in block `NH9OXl`, without any intervention to the skills.
The automatic-results fixture comes from the without-pstack condition in the earlier `TGxOu4` block.

The fixtures retain tool identities, independent tool calls, timestamps, worker lifecycle events, message kinds, parent message boundaries, turn boundaries, model settings, and recorded token usage.
Tool inputs and outputs, reports, instructions, reasoning content, credentials, local paths, and other personal metadata are omitted.
Sanitization preserves detector results; independent tool calls cannot disappear and make useful work look like polling.

Rows with type `proxy_request` are derived from the proxy log and identify actual parent inference request starts.
They are explicitly distinct from native Codex rollout events.
Native `token_usage_record` rows retain response IDs and per-response usage; `token_count` rows retain last and cumulative usage.
Do not count token updates as inference requests or sum cumulative counters as costs.
The sources contain 9 usage records for 10 polling requests, 14 for 14 interruptible requests, and 6 for 7 automatic-result requests.
Those gaps are preserved. Missing per-response usage must remain unknown when attributing future waste metrics.

To sanitize another saved controlled run:

```powershell
bun tools/codex/sanitize-waits.mjs parent-rollout.jsonl controlled-workers.json fixture.jsonl
```

## Iterate from a saved baseline

The default entry runs `current-pstack` once against the checkout where it is invoked.
It keeps parent inference real and serves worker responses through a local provider proxy.

At completion, the console prints observation validity, wait/timeout counts, empty waits, short-wait retries, parent inference request count, worker overlap, and individual wait durations and worker states. The same summary is saved as `<condition>.txt` beside the trial JSON. A valid observation can contain undesirable waits; total parent requests are not an estimate of wasted inference.

Each observation saves `skill-exposure.md` and `skill-exposure.json` in its artifact directory; the console summary links the JSON evidence.
That report lists installed skill files, references, and generated prompt shortcuts whose content appeared in parent tool responses, with trace row indices and whether exposure preceded delegation.
`skill-exposure.json` adds installed file hashes, call IDs, tool arguments, matched source line numbers, and the raw trace path. The trial summary links this report and lists observed paths.
Full content matches and partial matches on lines unique to a file are distinguished. A path mentioned in a command alone does not count.
Files without identifiable exposure are listed separately; shared or transformed excerpts may not be attributable. These reports measure delivered content, not comprehension or guaranteed filesystem access, and cover the parent only.

```powershell
bun test ./benchmarks/codex/waiting-controlled.mjs
```

Record the unchanged reproduction branch once and retain the printed result directory as the baseline.
Implement skill changes in a separate fix branch or worktree based on the reproduction commit.
Run the same command in that worktree to measure only the candidate; it does not rerun a baseline or patch the skill instructions.
Start with one candidate observation per edit. Repeat promising or ambiguous observations deliberately, using Bun's `--rerun-each` when needed.

Reuse baseline results while the task, parent model and effort, worker timing profile, and Codex runtime remain unchanged.
Refresh the baseline when those conditions change or a confirmation run is justified.
The no-plugin control is a separate, optional command, not the previous revision of pstack:

```powershell
bun test ./benchmarks/codex/waiting-control.mjs
```

Run full inference only when calibrating against real reviewer behavior:

```powershell
bun test ./benchmarks/codex/waiting-full-inference.mjs
```

The entry files share the workload and validation in `benchmarks/codex/support/waiting-suite.mjs`, using different session helpers or selecting the no-plugin control at registration time.
They share the task, reviewer settings, assertions, and report format. No environment variable selects the mode.

| Test | Assigned instructions |
| --- | --- |
| `without-pstack` | No plugin installed or activated. |
| `current-pstack` | The current checkout, with its unmodified interrogate workflow and runtime mapping. It is the original behavior on the reproduction branch and the candidate on a fix branch. |

All cases ask three independent reviewers to check two mathematical claims supplied entirely in the prompt.
Claim A gives an exact count of integers divisible by exactly three of ten specified primes.
Claim B incorrectly applies a linear binary-string count to a labeled circle.
The parent consolidates findings as they arrive and returns proofs and corrected counts after receiving all three reviewers' results.
Every session starts with an empty workspace. No task files or external sources are supplied.
The baseline receives no pstack instructions or documents.
The current-checkout case invokes `interrogate` without explicitly requesting a mapping read; the workflow itself directs that read.
Recorded behavior fixtures are available for detector replay and are not inputs to this task.

In the default mode, the proxy identifies workers using Codex's request metadata, outside the model conversation.
Only root inference and model-catalog requests are forwarded to the authenticated ChatGPT backend.
Worker model names remain unchanged, but the named reviewer models do not run.
Each worker receives the same scripted mathematical report after its assigned delay.
Spawning, waiting, worker completion, and result delivery still pass through Codex.
The prompts contain no proxy or timing instructions.

The delays are 74,538 ms for Sol, 56,257 ms for Astra, and 60,591 ms for Luna.
They come from worker durations in the full-inference current-pstack run at 2026-10-24 12:06 UTC, comparison block `pstack-review-results-O2tGRE`.
Each delay begins when the proxy receives that worker's first inference request; it does not fix absolute spawn or completion times.
Every condition uses the same delays. OS scheduling, parent inference, and notification delivery can still vary.
The proxy records intended delays and actual release times in `controlled-workers.json`.
Unsupported or repeated worker requests fail instead of falling back to paid inference.
Each session permits at most 30 parent inference requests and disables automatic request and stream retries.
Each controlled trial asserts three local worker responses, successful real parent inference, and zero upstream worker requests.

The benchmark never patches the installed skill instructions or wait mapping.
The current-checkout case must receive its installed mapping in parent tool output before delegation.
Skill activation alone does not establish mapping exposure.

Tests assert execution, delegation, worker model and effort, final-answer checks, trace completeness, and instruction exposure.
They require three overlapping reviewers and an observed message from each, and prohibit further delegation.
Automatic final notifications are recorded separately; a reviewer can deliver its findings in an ordinary message.
They record empty waits, timeouts, retry counts, individual waits, and worker durations as outcomes, without requiring zero polling.
A test passing means the observation is usable; it does not establish that polling is fixed or that pstack caused it.
The answer checks require the correct counts, `132057411984` and `79068200083062153040`.
Ordinary commas and LaTeX thin-space separators (`\,`) are accepted.
Inspect the saved answer and reviewer reports for substantive proof accuracy; number presence alone does not validate the proofs.

Each invocation prints a result directory containing the condition's JSON file and `run.json`.
The report is complete when that one observation is valid; it does not require control runs.
It retains invalid observations and their errors. Compare saved baseline and candidate reports rather than regenerating baselines for every edit.
The report records the common task hash, reviewer panel, installed skill and mapping hashes, and actual mapping exposure before delegation and waiting.
It also records `workerMode`; controlled trials include routing and timing evidence in `workerControl`.
Compare instruction conditions within one mode rather than combining controlled and full-inference observations.
Each result links to its raw parent and worker rollouts, prompt, final answer, CLI version, source revision, and plugin diff.
Artifacts remain available after successful runs; copied credentials are removed.

Compare repeated outcomes and worker durations before interpreting count differences.
A short worker run with no polling opportunity cannot establish that a change fixed polling.
Comparing current pstack with the optional no-plugin control examines activation on this task.
An improvement on the fix branch supports that candidate on this task; it does not prove pstack caused the original polling.
Scripted reports can change parent behavior relative to real reviews. The full-inference entry provides calibration for that limitation.
Single observations can vary; repeat only when the evidence warrants the additional inference.

The parent defaults are `gpt-6.1-sol` and `low`.
Existing `PSTACK_CODEX_LIVE_MODEL` and `PSTACK_CODEX_WAIT_EFFORT` settings override the parent for all conditions.
All conditions use the same fixed reviewer panel: `gpt-6.1-sol @xhigh`, `gpt-6-astra @medium`, and `gpt-6-luna @max`.
These settings reproduced short retries in the full-cost run; reviewer settings do not vary with the parent's overrides.
In default controlled mode these are worker identities and schedule selectors, not paid reviewer inference.
Hooks remain disabled to isolate explicit activation.

## Calibrate after a trace-format change

Run this diagnostic only when checking that the detector recognizes the host's live empty-wait events.

```powershell
bun test ./benchmarks/codex/empty-wait-calibration.mjs
```

It deliberately requests one empty wait and verifies the captured timeout.
It installs no pstack plugin and provides no evidence of spontaneous polling or pstack causation.
