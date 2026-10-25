import { readFileSync } from "node:fs";
import { analyzeWaitTrace, assessWaits } from "./lib/wait-trace.mjs";

try {
  if (![3, 5].includes(process.argv.length) || process.argv[2].startsWith("--") ||
    process.argv.length === 5 && process.argv[3] !== "--expectations") {
    throw new Error("Usage: bun tools/codex/replay-waits.mjs <parent-rollout.jsonl> [--expectations <expectations.json>]");
  }
  const rows = readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const facts = analyzeWaitTrace(rows);
  const assessment = process.argv.length === 5
    ? assessWaits(facts, JSON.parse(readFileSync(process.argv[4], "utf8"))) : undefined;
  const lastTask = rows.findLast(row => row.type === "event_msg" &&
    ["task_started", "task_complete", "turn_aborted"].includes(row.payload?.type));
  const complete = facts.coverage.complete && rows.some(row => row.type === "session_meta") &&
    lastTask?.payload.type === "task_complete";
  console.log(JSON.stringify({ complete, facts, assessment }, null, 2));
  process.exitCode = !complete ? 2 : assessment?.status === "fail" ? 1 : assessment?.status === "unknown" ? 2 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
