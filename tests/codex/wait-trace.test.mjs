import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeWaitTrace } from "./wait-trace.mjs";

const row = (second, type, payload) => ({ timestamp: new Date(Date.UTC(2026, 9, 19, 10, 12, second)).toISOString(), type, payload });
const call = (second, name, callId, args = {}) => row(second, "response_item", { type: "function_call", namespace: "collaboration", name, call_id: callId, status: "completed", arguments: JSON.stringify(args) });
const output = (second, callId, value) => row(second, "response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify(value) });
const activity = (second, kind, task = "alpha_reader") => row(second, "event_msg", {
  type: "item_completed", item: { type: "SubAgentActivity", kind, agent_path: `/root/${task}`, agent_thread_id: `thread-${task}` },
});
const final = (second, task = "alpha_reader") => row(second, "response_item", {
  type: "agent_message", author: `/root/${task}`, recipient: "/root", content: [{ type: "input_text", text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/${task}\nPayload:\nPASS` }],
});
const spawn = (second = 1, task = "alpha_reader") => [
  call(second, "spawn_agent", `spawn-${task}`, { task_name: task }), activity(second, "started", task), output(second, `spawn-${task}`, { task_name: `/root/${task}` }),
];
const wait = (second, id = "wait", timedOut = true) => [call(second, "wait_agent", id, { timeout_ms: 30000 }), output(second + 30, id, { message: "Wait completed.", timed_out: timedOut })];

test.each([
  ["planning-original", [10000, 10000], 1],
  ["planning-live", [1000, 10000, 10000, 10000, 10000], 3],
])("%s captures repeated short waits separately from empty waits", (name, timeouts, retries) => {
  const rows = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const result = analyzeWaitTrace(rows);
  expect(result.coverage.complete).toBe(true);
  expect(result.emptyWaits).toHaveLength(0);
  expect(result.waits.map((entry) => entry.args.timeout_ms)).toEqual(timeouts);
  expect(result.shortWaitRetries).toHaveLength(retries);
  expect(result.shortWaitRetries[0]).toBe(result.waits[1]);
});

test.each(["function_call", "custom_tool_call"])("a longer wait and %s work between short waits are not short wait retries", (type) => {
  const short = [call(2, "wait_agent", "first", { timeout_ms: 10000 }), output(12, "first", { timed_out: true })];
  const retry = [call(14, "wait_agent", "second", { timeout_ms: 10000 }), output(24, "second", { timed_out: true })];
  const work = row(13, "response_item", { type, namespace: "functions", name: "exec", call_id: "read-source", arguments: "{}" });
  expect(analyzeWaitTrace([...spawn(), ...short, work, ...retry]).shortWaitRetries).toEqual([]);
  expect(analyzeWaitTrace([...spawn(), ...wait(2), ...retry]).shortWaitRetries).toEqual([]);
});

test("completion during a wait does not make that wait empty", () => {
  const result = analyzeWaitTrace([
    ...spawn(), call(2, "wait_agent", "wait", { timeout_ms: 30000 }), activity(3, "completed"),
    output(4, "wait", { timed_out: false }), final(5),
  ]);
  expect(result.waits[0].classification).toBe("active");
  expect(result.waits[0].durationMs).toBe(2000);
  expect(result.waits[0].timedOut).toBe(false);
  expect(result.emptyWaits).toEqual([]);
  expect(result.coverage.complete).toBe(true);
});

test("all completed workers and delivered answers make a later wait empty", () => {
  const result = analyzeWaitTrace([
    ...spawn(1), ...spawn(2, "beta_reader"), activity(3, "completed"), final(4),
    activity(5, "completed", "beta_reader"), final(6, "beta_reader"), ...wait(7),
  ]);
  expect(result.spawns).toHaveLength(2);
  expect(result.emptyWaits).toHaveLength(1);
  expect(result.emptyWaits[0].classification).toBe("empty");
  expect(result.emptyWaits[0].durationMs).toBe(30000);
  expect(result.emptyWaits[0].timedOut).toBe(true);
  expect(result.coverage).toMatchObject({ activityStarted: 2, activityCompleted: 2, finalAnswers: 2, complete: true });
});

test("a parent with no spawned agents has an empty wait", () => {
  const result = analyzeWaitTrace(wait(1));
  expect(result.emptyWaits).toHaveLength(1);
  expect(result.spawns).toEqual([]);
  expect(result.coverage.complete).toBe(true);
});

test("completed work whose answer has not arrived is pending delivery", () => {
  const result = analyzeWaitTrace([...spawn(), activity(2, "completed"), ...wait(3), final(34)]);
  expect(result.waits[0].classification).toBe("pending-result");
  expect(result.waits[0].pendingResults).toEqual(["/root/alpha_reader"]);
  expect(result.emptyWaits).toEqual([]);
});

test.each(["followup_task", "send_input", "resume_agent"])("%s invalidates completed work until new activity is known", (name) => {
  const result = analyzeWaitTrace([
    ...spawn(), activity(2, "completed"), final(3), call(4, name, "again", { target: "/root/alpha_reader" }),
    ...wait(5, "uncertain"), activity(36, "started"), ...wait(37, "active"),
  ]);
  expect(result.waits.map((entry) => entry.classification)).toEqual(["unknown", "active"]);
  expect(result.emptyWaits).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});

test("ordinary messages do not restart a completed task", () => {
  const result = analyzeWaitTrace([
    ...spawn(), activity(2, "completed"), final(3), call(4, "send_message", "message", { target: "alpha_reader" }),
    row(4, "event_msg", { item: { type: "SubAgentActivity", id: "message", kind: "interacted", agent_path: "/root/alpha_reader", agent_thread_id: "thread-alpha_reader" } }), ...wait(5),
  ]);
  expect(result.emptyWaits).toHaveLength(1);
  expect(result.coverage.complete).toBe(true);
});

test("a completed spawn tool call does not prove worker completion", () => {
  const result = analyzeWaitTrace([...spawn(), ...wait(2)]);
  expect(result.waits[0].classification).toBe("active");
  expect(result.emptyWaits).toEqual([]);
});

test("missing activity is reported instead of passing an empty-wait check", () => {
  const result = analyzeWaitTrace([
    call(1, "spawn_agent", "spawn", { task_name: "alpha_reader" }), output(1, "spawn", { task_name: "/root/alpha_reader" }), ...wait(2),
  ]);
  expect(result.waits[0].classification).toBe("unknown");
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues.length).toBeGreaterThan(0);
  expect(result.emptyWaits).toEqual([]);
});

test("unsupported activity and truncated waits report incomplete coverage", () => {
  const result = analyzeWaitTrace([activity(1, "paused"), call(2, "wait_agent", "wait")]);
  expect(result.waits[0].classification).toBe("unknown");
  expect(result.waits[0].durationMs).toBeNull();
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues).toHaveLength(2);
});

test("a completion without its start stays unknown even after final delivery", () => {
  const result = analyzeWaitTrace([activity(1, "completed"), final(2), ...wait(3)]);
  expect(result.waits[0].classification).toBe("unknown");
  expect(result.emptyWaits).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});

test("wait outputs without timeout evidence report incomplete coverage", () => {
  const result = analyzeWaitTrace([call(1, "wait_agent", "wait"), output(2, "wait", { message: "Wait completed." })]);
  expect(result.waits[0].timedOut).toBeNull();
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues).toHaveLength(1);
});
