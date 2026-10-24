import { readFileSync } from "node:fs";
import { analyzeWaitTrace } from "./wait-trace.mjs";

const shortWaits = process.argv[3] === "--short-waits";
if (process.argv.length < 3 || process.argv.length > 4 || (process.argv.length === 4 && !shortWaits)) {
  throw new Error("Usage: bun tests/codex/replay-waits.mjs <parent-rollout.jsonl> [--short-waits]");
}
const rows = readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const result = analyzeWaitTrace(rows);
const lastTask = rows.findLast((row) => row.type === "event_msg" &&
  ["task_started", "task_complete", "turn_aborted"].includes(row.payload?.type));
const complete = result.coverage.complete && rows.some((row) => row.type === "session_meta") &&
  lastTask?.payload.type === "task_complete";
console.log(JSON.stringify({
  complete, spawns: result.spawns.length, coverage: result.coverage,
  waits: result.waits.map(({ callId, timestamp, classification, activeAgents, pendingResults, unknownAgents, durationMs, timedOut, args }) =>
    ({ callId, timestamp, classification, activeAgents, pendingResults, unknownAgents, durationMs, timedOut, timeoutMs: args.timeout_ms })),
  emptyWaits: result.emptyWaits.length,
  shortWaitRetries: result.shortWaitRetries.length,
}, null, 2));
process.exitCode = !complete ? 2 : result.emptyWaits.length || (shortWaits && result.shortWaitRetries.length) ? 1 : 0;
