# Run Codex tests

The suite separates detector correctness from live observations of agent behavior.

| Files | Evidence | Requirements |
| --- | --- | --- |
| `harness/harness.test.mjs` | Isolated sessions, CLI arguments, authentication cleanup, logs, and rollout lookup through a scripted CLI. | Bun. |
| `wait-trace.test.mjs` | Agent states, pending delivery, empty waits, short retries, and incomplete traces. | Bun. |
| `replay-waits.test.mjs` | Replay CLI output and exit codes. | Bun. |
| `installation.test.mjs` | Real plugin installation preserves skill source. | Codex CLI and existing `PSTACK_CODEX_INSTALL=1`. |
| `live.test.mjs` | A generated native plugin invokes its installed skill. | Codex credentials and existing `PSTACK_CODEX_LIVE=1`. |
| `waiting.mjs` | Three explicit tests compare the planning investigation under different instructions. | Codex credentials and explicit file selection. |
| `waiting-calibration.mjs` | A deliberately forced empty wait checks the live trace format. | Codex credentials and explicit file selection. |

Run the deterministic suite without credentials or model calls.

```powershell
bun test tests/codex
```

The two live waiting files omit `.test` in their filenames, so automatic discovery excludes them.
The existing installation and native invocation tests retain their existing switches.

## Inspect the recorded reproduction

The planning investigation captured repeated short waits on Codex CLI 0.163.0 with pstack 0.9.93 and `gpt-6.1-sol` at low effort.
The original conversation made two waits with one timeout-and-retry transition.
The isolated reproduction made five waits with three timeout-and-retry transitions.
Its initial one-second request was clamped to ten seconds.
Both recordings have zero empty waits. Waiting with no working agents remains unreproduced.

Replay the recordings without another model call.

```powershell
bun tests/codex/replay-waits.mjs tests/codex/fixtures/planning-original.jsonl --short-waits
bun tests/codex/replay-waits.mjs tests/codex/fixtures/planning-live.jsonl --short-waits
```

Both exit with code 1 and report one and three short wait retries respectively.
Without `--short-waits`, both exit with code 0 because their agents were working.
For other rollouts, exit code 2 means evidence is incomplete.

`planning-original.jsonl` comes from the conversation at 2026-10-19 08:17 UTC, thread `01a152e3-87cb-7442-b7ba-f070ab941cdc`.
`planning-live.jsonl` comes from the isolated run at 10:50 UTC, thread `01a153c9-385c-7143-89f6-cfc8120d1b15`.
The fixtures retain tool identities, timestamps, agent activity, wait arguments, results, messages, and turn boundaries.
They omit personal metadata, reasoning, token counters, and command and report contents.
Independent tool calls remain present so omissions cannot make useful work look like polling.

## Compare instructions on the planning task

Run the three named cases, or select one with Bun.

```powershell
bun test ./tests/codex/waiting.mjs
bun test ./tests/codex/waiting.mjs --test-name-pattern current-pstack
bun test ./tests/codex/waiting.mjs --rerun-each=5 --randomize --seed=42
```

| Test | Assigned instructions |
| --- | --- |
| `without-pstack` | No plugin installed or activated. |
| `current-pstack` | Current pstack, with its simple how workflow. This is also the live reproduction case. |
| `guided-pstack` | The same workflow, with only the wait mapping changed in its isolated installed copy. |

All cases ask the planning and storage question from the original reproduction.
Each assigns document reading to one worker with the same model and effort.
Every case receives the same snapshot of planning documents in `reference/`, with hashes recorded in the report.
The baseline studies pstack documents as source material; the comparison concerns workflow activation, not absence of all pstack prose.
The prompt now explicitly supplies source documents and requests a runtime-reference read in both plugin cases.
It preserves the planning workload rather than claiming byte-for-byte identity with the historical prompt.

The proposed guidance requests 60-second interruptible waits only when needed.
It also forbids waiting with no working agents or pending results.
The checkout's instructions remain unchanged.
Both plugin cases must receive their assigned mapping in parent tool output before delegation.
Skill activation alone does not establish mapping exposure.

Tests assert execution, delegation, worker model and effort, final-answer checks, trace completeness, and instruction exposure.
They record empty waits, retry counts, individual waits, and worker duration as outcomes, without requiring zero polling.
A test passing means the observation is usable; it does not establish that polling is fixed or that pstack caused it.
The answer checks require orchestration and repository content plus source citations; inspect the saved answer for substantive accuracy.

Each file run prints a comparison directory containing one result per selected condition and `comparison.json`.
The comparison retains invalid trials and their errors.
Contrasts are produced only when all three cases yield valid observations.
They report current-minus-baseline and guided-minus-current retry counts, not a statistical causal verdict.
Each result links to its raw parent and worker rollouts, prompt, final answer, CLI version, source revision, and plugin diff.
Artifacts remain available after successful runs; copied credentials are removed.

Compare repeated outcomes and worker durations before interpreting count differences.
A short worker run with no polling opportunity cannot establish that a change fixed polling.
Current exceeding baseline supports an activation effect on this task.
Guided improving current supports the guidance; by itself, that does not prove pstack caused the original polling.
Five runs are an exploratory starting point, not a power calculation.
Use different recorded seeds to vary order across batches; a fixed seed can repeat the same order.

The defaults are `gpt-6.1-sol` and `low`, matching the recordings.
Existing `PSTACK_CODEX_LIVE_MODEL` and `PSTACK_CODEX_WAIT_EFFORT` settings override them for all conditions.
Hooks remain disabled to isolate explicit activation.

## Calibrate after a trace-format change

Run this diagnostic only when checking that the detector recognizes the host's live empty-wait events.

```powershell
bun test ./tests/codex/waiting-calibration.mjs
```

It deliberately requests one empty wait and verifies the captured timeout.
It installs no pstack plugin and provides no evidence of spontaneous polling or pstack causation.
