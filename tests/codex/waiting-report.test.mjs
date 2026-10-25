import { expect, test } from "bun:test";
import { formatWaitingReport } from "../../benchmarks/codex/support/waiting-report.mjs";

test("valid observations report facts separately from declared assessments", () => {
  const output = formatWaitingReport({ condition: "current-pstack", valid: true, model: "parent", effort: "low", workerMode: "controlled",
    facts: { coverage: { activityCompleted: 3, finalAnswers: 3 }, noOutstandingWorkWaits: [{}], shortTimeoutRewaits: [{}, {}],
      waits: [{ timeoutMs: 10000, durationMs: 10034, activeAgents: [], pendingResults: [], trackedWork: "no_outstanding_work_at_entry", timedOut: true }] },
    assessment: { status: "unknown" }, expectedNumberSmokeCheck: "passed",
    workerControl: { parentRequests: 1 },
  });
  expect(output).toContain("Observation: VALID");
  expect(output).toContain("Waits with no outstanding tracked work at entry: 1");
  expect(output).toContain("Short-timeout rewaits: 2");
  expect(output).toContain("Declared expectation assessment: unknown");
  expect(output).toContain("Expected-number smoke check: passed");
  expect(output).toContain("10.00s / 10.03s; active=0; pending=0; timed out; no_outstanding_work_at_entry");
  expect(output).toContain("Parent inference requests: 1 (all requests, not attributed waste)");
});

test("missing measurements in failed observations remain unknown rather than zero", () => {
  const output = formatWaitingReport({ condition: "current-pstack", valid: false, error: "execution failed" });
  expect(output).toContain("INVALID / INCOMPLETE");
  expect(output).toContain("Waits with no outstanding tracked work at entry: unknown");
  expect(output).toContain("Declared expectation assessment: not selected");
  expect(output).toContain("Parent inference requests: unknown");
  expect(output).toContain("Error: execution failed");
});

test("a missing timeout outcome remains visible alongside zero recorded timeouts", () => {
  const output = formatWaitingReport({ valid: false, facts: { coverage: {}, noOutstandingWorkWaits: [], shortTimeoutRewaits: [],
    waits: [{ outputObserved: true, timedOut: null, trackedWork: "active" }] } });
  expect(output).toContain("1 total; 0 recorded timeouts; 1 unknown timeout outcomes");
});

test("mailbox reports show observed message types and timing without claiming a native wake cause", () => {
  const output = formatWaitingReport({ condition: "current-pstack", valid: true, mailboxCondition: "ordinary-message",
    facts: { coverage: { ordinaryMessages: 2, finalAnswers: 1 }, noOutstandingWorkWaits: [], shortTimeoutRewaits: [], waits: [
      { outputObserved: true, timedOut: false, trackedWork: "active", nearbyMessages: [
        { kind: "ordinary_message", author: "/root/worker", timing: "after-return", lagMs: 3 },
        { kind: "final", author: "/root/other", timing: "during-wait", lagMs: null },
      ] }, { outputObserved: true, timedOut: false, trackedWork: "active", nearbyMessages: [] },
    ] } });
  expect(output).toContain("Mailbox condition: ordinary-message");
  expect(output).toContain("Ordinary messages delivered: 2");
  expect(output).toContain("1 final answers delivered");
  expect(output).toContain("ordinary_message from /root/worker observed 3 ms after return");
  expect(output).toContain("final from /root/other observed during wait");
  expect(output).toContain("returned; active; no nearby message observed");
  expect(output).not.toMatch(/wakeReason|woken by/);
});
