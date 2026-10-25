import { expect, test } from "bun:test";
import { formatWaitingReport } from "../../benchmarks/codex/support/waiting-report.mjs";

test("valid observations still surface undesirable waits and distinguish inference from waste", () => {
  const output = formatWaitingReport({ condition: "current-pstack", valid: true, model: "parent", effort: "low", workerMode: "controlled",
    coverage: { activityCompleted: 3, finalAnswers: 3 }, emptyWaits: 1, shortWaitRetries: 2, timedOutWaits: 1,
    waits: [{ args: { timeout_ms: 10000 }, durationMs: 10034, activeAgents: [], pendingResults: [], classification: "empty", timedOut: true }],
    workerControl: { observations: [{ agent: "/root", route: "upstream", path: "/responses" }, { agent: "/root/child", route: "scripted", path: "/responses" }] },
  });
  expect(output).toContain("Observation: VALID");
  expect(output).toContain("Empty waits: 1");
  expect(output).toContain("Short-wait retries: 2");
  expect(output).toContain("10.00s / 10.03s; active=0; pending=0; timed out; empty");
  expect(output).toContain("Parent inference requests: 1 (all requests, not attributed waste)");
});

test("missing measurements in failed observations remain unknown rather than zero", () => {
  const output = formatWaitingReport({ condition: "current-pstack", valid: false, error: "execution failed" });
  expect(output).toContain("INVALID / INCOMPLETE");
  expect(output).toContain("Empty waits: unknown");
  expect(output).toContain("Parent inference requests: unknown");
  expect(output).toContain("Error: execution failed");
});
