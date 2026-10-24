import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCodex } from "./harness/harness.mjs";
import { analyzeWaitTrace } from "./wait-trace.mjs";

test("empty-wait-control calibrates the live trace format", async () => {
  await withCodex(async ({ root, exec, session }) => {
    const prompt = "Spawn no agents. Call collaboration.wait_agent exactly once with timeout_ms: 10000. After it returns, reply calibrated. This is an intentional trace calibration.";
    writeFileSync(join(root, "prompt.txt"), prompt);
    const output = await exec(prompt, { multiAgent: true, model: process.env.PSTACK_CODEX_LIVE_MODEL || "gpt-6.1-sol", effort: "low" });
    const events = output.trim().split(/\r?\n/).map(JSON.parse);
    const trace = session(events.find(event => event.type === "thread.started")?.thread_id);
    const result = analyzeWaitTrace(trace.rows);
    writeFileSync(join(root, "wait-summary.json"), JSON.stringify(result, null, 2));
    expect(events.some(event => event.type === "turn.completed")).toBe(true);
    expect(result.coverage.complete).toBe(true);
    expect(result.spawns).toHaveLength(0);
    expect(result.waits).toHaveLength(1);
    expect(result.emptyWaits).toHaveLength(1);
    expect(result.emptyWaits[0].timedOut).toBe(true);
  }, { env: { ...process.env, PSTACK_CODEX_LIVE_KEEP: "1" } });
}, 240_000);
