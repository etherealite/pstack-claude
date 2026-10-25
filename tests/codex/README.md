# Run Codex tests and benchmarks

Run commands from the repository root. Deterministic tests need Bun and make no model calls:

```powershell
bun test tests/codex
```

Files ending in `.test.mjs` live under `tests/codex`, with shared helpers in `harness` and fixtures in `fixtures`.
Credential-dependent integration tests live in `tests/codex/integration` and skip unless enabled.
Paid benchmarks live outside Bun's configured test root in `benchmarks/codex`; select an entry explicitly by path.
`tools/codex` contains replay and sanitization commands, with imported helpers in `lib`.

| Test | Evidence | Additional requirements |
| --- | --- | --- |
| `harness/harness.test.mjs` | Session isolation, CLI arguments, credential cleanup, logs, and rollout lookup. | None. |
| `harness/controlled-workers.test.mjs` | Worker routing, scripted responses, forwarding, and refusal of paid fallbacks. | None. |
| `wait-trace.test.mjs` | Lifecycle and delivery facts, short timeout rewaits, explicit scenario assessments, and incomplete traces. | None. |
| `replay-waits.test.mjs` | Replay output, expectation validation, and exit codes. | None. |
| `sanitize-waits.test.mjs` | Redaction preserves measurements, request boundaries, and recorded token usage. | None. |
| `skill-exposure.test.mjs` | Full and partial content matches, call evidence, and exclusion of path mentions. | None. |
| `waiting-report.test.mjs` | Reports distinguish observed facts, assessments, missing measurements, and zero. | None. |
| `integration/installation.test.mjs` | Real plugin installation preserves skill source. | Codex CLI; `PSTACK_CODEX_INSTALL=1`. |
| `integration/live.test.mjs` | A generated native plugin invokes its installed skill. | Codex credentials; `PSTACK_CODEX_LIVE=1`. |
| `integration/local-mailbox.test.mjs` | The installed CLI executes messages, returns from active waits, and receives a later final answer. | Codex CLI; `PSTACK_CODEX_LOCAL=1`; no credentials or inference. |

The installation and native invocation tests retain their existing switches. See the root README's [Windows development instructions](../../README.md#develop-pstack-locally-on-windows) for committed snapshots and native-test credential handling.

## Replay facts and assess explicit scenarios

Replay a recorded trace without another model call:

```powershell
bun tools/codex/replay-waits.mjs tests/codex/fixtures/active-worker-polling.jsonl
bun tools/codex/replay-waits.mjs tests/codex/fixtures/interruptible-waits.jsonl
bun tools/codex/replay-waits.mjs tests/codex/fixtures/automatic-results.jsonl
bun tools/codex/replay-waits.mjs tests/codex/fixtures/synthetic-mailbox.jsonl
```

Raw replay exits `0` for complete evidence and `2` for incomplete evidence. It does not select a behavior policy.
`analyzeWaitTrace` reconstructs tracked worker activity, result delivery, waits, and messages. Its facts include `noOutstandingWorkWaits` and `shortTimeoutRewaits`.
The `trackedWork` value `no_outstanding_work_at_entry` records no outstanding tracked work. This means no tracked active work or pending result at entry; it does not mean the mailbox is empty or a receive is unnecessary.
Wait records preserve `timeoutMs`, duration, entry worker states, and nearby messages separately.

An ordinary `MESSAGE` becomes `ordinary_message`, counted by `ordinaryMessages`. It can contain a question or blocker and does not establish progress or completion.
Final result delivery and lifecycle completion are separate events. Delivery does not prove that the parent consumed the result.
Short timeout rewaits describe a timeout followed by another short wait with unchanged active work. Selected tool calls, user input, and lifecycle transitions break the pattern.
The detector does not assess whether intervening reasoning or parent messages are useful.
Ordinary messages, including unrelated messages, do not erase that pattern. The pattern alone does not prove wasted inference.

To assess a declared scenario, supply an expectations file:

```powershell
bun tools/codex/replay-waits.mjs scenario.jsonl --expectations scenario.json
```

The file contains an array of expectations, keyed by the recorded wait's `callId`:

```json
[
	{
		"callId": "wait-1",
		"requiredAgents": ["/root/reviewer"],
		"mailboxReceive": "not-required",
		"independentWork": "exhausted"
	}
]
```

`assessWaits` evaluates these declarations separately from trace reconstruction:

- `requiredAgents` names agents whose `FINAL_ANSWER` delivery is required at that wait's entry. `[]` explicitly declares none; omission leaves requiredness unknown.
- `mailboxReceive` is `required` or `not-required`, including a receive needed after tracked work has finished.
- `independentWork` is `available` or `exhausted`. The analyzer does not infer availability from silence or tool calls.

Available independent work fails the declared waiting rule. With independent work exhausted, an outstanding required result or a required mailbox receive supports waiting.
Known absence of both fails. Missing declarations or unobservable prerequisites leave the assessment unknown.
With expectations selected, replay exits `0` for pass, `1` for fail, and `2` for unknown or incomplete evidence.
Malformed expectations and unknown or duplicate wait IDs exit `2`. Required agents absent from the trace remain unknown.
Known failures take precedence over unknown assessments; incomplete trace evidence always exits `2`.

Nearby-message evidence covers messages during the call or within 100 ms after a non-timeout return, before the next parent action.
That window is observational and does not establish why the host returned. An unexplained return retains no inferred cause.
Missing or reversed timestamps, overlapping waits, unrelated recipients, and later deliveries do not receive ambiguous associations.
A timeout can still contain ordinary messages observed during its interval.

### Interpret fixture provenance and accounting

The three recorded fixtures come from a corpus-free review on Codex CLI 0.163.0, with real parent inference and scripted workers.
Polling and automatic-result runs use `gpt-6.1-sol @low`; interruptible waits use `gpt-6-luna @medium`.
The polling fixture contains three waits, one timeout, and one short timeout rewait. Interruptible waits contain three waits with no timeout; automatic results contain no waits.
All three have zero waits with no outstanding tracked work. These are behavior fixtures, not evidence of pstack causation or an efficiency ranking.
`synthetic-mailbox.jsonl` is constructed and covers ordinary messages after a return, messages during a rewait, and a later final answer.

`fixtures/manifest.json` records comparison blocks, conditions, thread IDs, and accounting expectations.
Polling comes from current-pstack in the 2026-10-24 `t3FYKH` block; interruptible waits come from the unchanged Luna-medium current-pstack run in `NH9OXl`.
Automatic results come from without-pstack in the earlier `TGxOu4` block. Earlier overlapping planning recordings remain in Git history.
Active-worker waits request ten seconds; interruptible waits request one hour and return early on results.
Automatic results demonstrate delivery without explicit waits while the parent still uses inference.

Fixtures retain tool identities, independent tool calls, timestamps, lifecycle events, message kinds, parent and turn boundaries, model settings, and recorded token usage.
They omit tool payloads, reports, instructions, reasoning, credentials, local paths, and personal metadata.
Sanitization preserves the tool and message boundaries used by the measurements.

Derived `proxy_request` rows identify actual parent inference request starts and are distinct from native rollout events.
Native `token_usage_record` rows retain response IDs and per-response usage; `token_count` retains last and cumulative usage.
Do not count token updates as requests or sum cumulative counters as costs.
The sources retain 9 usage records for 10 polling requests, 14 for 14 interruptible requests, and 6 for 7 automatic-result requests.
Missing per-response usage remains unknown. Total parent requests do not estimate wasted inference.

To sanitize another saved controlled run:

```powershell
bun tools/codex/sanitize-waits.mjs parent-rollout.jsonl controlled-workers.json fixture.jsonl
```

## Validate local CLI mailbox delivery

Run the scripted provider test without credentials or inference:

```powershell
$env:PSTACK_CODEX_LOCAL = "1"
bun test tests/codex/integration/local-mailbox.test.mjs
Remove-Item Env:PSTACK_CODEX_LOCAL
```

The test scripts the parent and one worker and retains its artifact directory.
It checks actual namespaced `collaboration.send_message` execution, empty-string tool acknowledgments, and later final delivery on the installed CLI.
Its forwarding stub rejects unhydrated encrypted synthetic messages while confirming that the original rollout retains the encrypted delivery.
This proves the local CLI path used by the mailbox benchmark, separately from deterministic proxy tests.

## Compare a candidate with a saved baseline

Each entry runs one observation. Select the mode explicitly:

| Command | Mode and inference cost |
| --- | --- |
| `bun test ./benchmarks/codex/waiting-controlled.mjs` | Current checkout, scheduled local worker responses; only parent inference goes upstream. Requires ChatGPT credentials. |
| `bun test ./benchmarks/codex/waiting-mailbox.mjs` | Current checkout, two scheduled progress messages per worker with the same final deadlines; only parent inference goes upstream. Requires ChatGPT credentials. |
| `bun test ./benchmarks/codex/waiting-control.mjs` | Optional no-plugin control with local workers; only parent inference goes upstream. Requires ChatGPT credentials. |
| `bun test ./benchmarks/codex/waiting-full-inference.mjs` | Current checkout with real reviewers for occasional calibration; all four agents use inference. Requires Codex credentials. |

The tiny entry files select modes through `benchmarks/codex/support/waiting-suite.mjs`; no environment variable selects a mode.
Record the unchanged reproduction branch once and retain its printed result directory.
Make changes in a separate branch or worktree based on that commit, then run the same command there. The benchmark never patches installed skill instructions or wait mappings.
Reuse the baseline while the task, parent model and effort, worker schedule, and runtime remain unchanged.
Start with one candidate observation per edit. Repeat promising or ambiguous results deliberately, using Bun's `--rerun-each` when needed.
Refresh a baseline when conditions change or confirmation is justified.

The parent requests three independent reviews of two mathematical claims supplied entirely in the prompt, then consolidates all required reviewer results.
Claim A counts integers divisible by exactly three of ten primes. Claim B incorrectly applies a linear binary-string count to a labeled circle.
Sessions start with empty workspaces and receive no task files or external sources. Recorded behavior fixtures are not task inputs.
The no-plugin control receives no pstack instructions or documents. Current-pstack invokes the unchanged `interrogate` workflow without explicitly requesting a mapping read.
The installed mapping must appear in parent tool output before delegation; activation alone does not prove exposure.

The parent defaults to `gpt-6.1-sol @low`. `PSTACK_CODEX_LIVE_MODEL` and `PSTACK_CODEX_WAIT_EFFORT` override it across conditions.
The fixed reviewer panel is `gpt-6.1-sol @xhigh`, `gpt-6-astra @medium`, and `gpt-6-luna @max`.
These are worker identities and schedule selectors in controlled modes; the named reviewer models run only in full-inference mode.
Hooks remain disabled to isolate explicit activation.

### Preserve routing and message controls

The controlled proxy identifies workers through Codex request metadata outside the conversation.
Only root inference and model-catalog requests reach the authenticated ChatGPT backend. Unsupported worker requests fail instead of falling back to paid inference.
Each worker receives the same scripted mathematical report after its assigned delay. Codex handles spawning, waiting, lifecycle completion, and delivery.
Prompts contain no proxy or timing instructions.

The Sol, Astra, and Luna delays are 74,538 ms, 56,257 ms, and 60,591 ms.
They come from the full-inference current-pstack run at 2026-10-24 12:06 UTC in `pstack-review-results-O2tGRE`.
Each delay begins at that worker's first inference request. Actual spawning, parent inference, OS scheduling, and notification delivery can vary.
`controlled-workers.json` records intended delays and actual releases.
The mailbox schedule adds progress at 10,000 ms and 25,000 ms after each worker's first request. Only this scripted schedule establishes that the ordinary messages contain progress.
Compare mailbox observations with the same schedule and keep the silent baseline separate.

Mailbox workers issue actual advertised `collaboration.send_message` calls to `/root`.
Each call permits one continuation after its successful acknowledgment. Concurrent requests, identity changes, missing acknowledgments, and replay-only acknowledgments fail.
The proxy supports the namespaced Responses `additional_tools` schema advertised by Codex CLI 0.163.0. Unrecognized schemas fail closed.
That CLI delivers synthetic progress arguments as encrypted mailbox content that the upstream backend cannot hydrate.
Before parent inference, the proxy restores only its own released progress text, binding mailbox IDs to each worker's emitted schedule order.
IDs, authors, recipients, runtime delivery, and plaintext final reports stay intact. Unknown messages remain unchanged.
Malformed synthetic progress and messages beyond the released schedule fail before forwarding.
Control evidence records hydrated IDs and schedule indices without ciphertext.

Each session permits at most 30 parent inference requests and disables automatic request and stream retries.
Silent controlled observations require three local responses, successful parent inference, and zero upstream worker requests.
Mailbox observations require nine local responses, two acknowledged progress calls per worker, and each worker's final answer.
These checks retain the no-paid-fallback guarantee and validate actual forwarding rather than simulated delivery alone.

### Interpret reports and comparison limits

Tests require execution, delegation, assigned models and efforts, instruction exposure, trace completeness, three overlapping reviewers, a message from each, and no further delegation.
Required reviewer results are declared. Independent work availability is not inferred, so scenario assessments generally remain unknown without explicit evidence.
Automatic final notifications are recorded separately; an ordinary message can deliver a reviewer's findings.
Answer checks look for `132057411984` and `79068200083062153040`, accepting commas and LaTeX thin spaces `\,`.
These counts are smoke checks. Inspect the saved answer and reviewer reports to assess proof accuracy.
Passing means the observation is usable; it does not establish that polling is fixed, that inference was wasted, or that pstack caused the behavior.

Each invocation prints a directory containing the condition JSON, `run.json`, and a text summary.
Reports separate validity, trace facts, and explicit assessments, with wait durations, entry states, nearby messages, timeouts, parent requests, and worker overlap.
Invalid observations and their errors are retained. Successful runs also retain artifacts; copied credentials are removed.
Results link raw parent and worker rollouts, the prompt, final answer, CLI version, revision, and plugin diff.
They record the task hash, reviewer panel, installed skill and mapping hashes, mapping exposure before delegation and waiting, and `workerMode`.
Controlled results include routing, timing, schedule, progress counts, and final-delivery evidence in `workerControl`.

`skill-exposure.md` and `skill-exposure.json` list installed skills, references, and generated shortcuts whose content appears in parent tool responses.
Evidence includes trace rows, exposure before delegation, installed hashes, call IDs, arguments, matched source lines, and the raw trace path.
Full matches and partial matches on file-unique lines are distinct. A path mention alone does not count.
Unidentified exposure stays separate because shared or transformed excerpts may be unattributable.
These reports measure content delivered to the parent, not comprehension or guaranteed filesystem access.

Compare repeated outcomes and worker durations within one mode. A short run without a polling opportunity cannot establish that a change fixed polling.
The no-plugin control examines activation on this task; a candidate improvement supports that candidate on this task.
Neither comparison proves that pstack caused the original behavior. Scripted reports can affect the parent differently from real reviews, which limits controlled observations.
Use full inference for occasional calibration and repeat only when the evidence justifies additional cost.

## Calibrate after a trace-format change

Run this paid diagnostic only to check recognition of live waits with no outstanding tracked work:

```powershell
bun test ./benchmarks/codex/no-work-wait-calibration.mjs
```

It deliberately requests one wait without spawning workers and verifies the captured timeout.
It installs no pstack plugin and provides no evidence of spontaneous polling or pstack causation.
