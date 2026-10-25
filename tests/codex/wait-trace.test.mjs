import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeWaitTrace, assessWaits } from "../../tools/codex/lib/wait-trace.mjs";

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

const fixture = name => readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse);

test("recorded active-worker polling contains a short retry but no wait without outstanding tracked work", () => {
  const rows = fixture("active-worker-polling");
  const result = analyzeWaitTrace(rows);
  expect(result.coverage.complete).toBe(true);
  expect(result.spawns).toHaveLength(3);
  expect(result.coverage.finalAnswers).toBe(3);
  expect(result.noOutstandingWorkWaits).toHaveLength(0);
  expect(result.waits.map(entry => entry.timeoutMs)).toEqual([10000, 10000, 10000]);
  expect(result.waits.filter(entry => entry.timedOut)).toHaveLength(1);
  expect(result.shortTimeoutRewaits).toHaveLength(1);
  expect(result.shortTimeoutRewaits[0]).toEqual({ previousCallId: result.waits[0].callId,
    callId: result.waits[1].callId, interveningMessages: [] });
  expect(rows.filter(row => row.type === "proxy_request")).toHaveLength(10);
});

test("recorded long waits return on results before their timeout", () => {
  const rows = fixture("interruptible-waits");
  const result = analyzeWaitTrace(rows);
  expect(result.coverage.complete).toBe(true);
  expect(result.coverage.finalAnswers).toBe(3);
  expect(result.waits.map(entry => entry.timeoutMs)).toEqual([3600000, 3600000, 3600000]);
  expect(result.waits.every(entry => !entry.timedOut && entry.durationMs < entry.timeoutMs)).toBe(true);
  expect(result.shortTimeoutRewaits).toHaveLength(0);
  expect(result.noOutstandingWorkWaits).toHaveLength(0);
  expect(rows.filter(row => row.type === "proxy_request")).toHaveLength(14);
});

test("recorded results arrive without wait calls while the parent still uses inference", () => {
  const rows = fixture("automatic-results");
  const result = analyzeWaitTrace(rows);
  expect(result.coverage.complete).toBe(true);
  expect(result.spawns).toHaveLength(3);
  expect(result.coverage.finalAnswers).toBe(3);
  expect(result.waits).toHaveLength(0);
  expect(result.shortTimeoutRewaits).toHaveLength(0);
  expect(result.noOutstandingWorkWaits).toHaveLength(0);
  expect(rows.filter(row => row.type === "proxy_request")).toHaveLength(7);
});

test.each(["function_call", "custom_tool_call"])("a longer wait and %s work between short waits are not short wait retries", (type) => {
  const short = [call(2, "wait_agent", "first", { timeout_ms: 10000 }), output(12, "first", { timed_out: true })];
  const retry = [call(14, "wait_agent", "second", { timeout_ms: 10000 }), output(24, "second", { timed_out: true })];
  const work = row(13, "response_item", { type, namespace: "functions", name: "exec", call_id: "read-source", arguments: "{}" });
  expect(analyzeWaitTrace([...spawn(), ...short, work, ...retry]).shortTimeoutRewaits).toEqual([]);
  expect(analyzeWaitTrace([...spawn(), ...wait(2), ...retry]).shortTimeoutRewaits).toEqual([]);
});

test("completion during a wait does not change work tracked at entry", () => {
  const result = analyzeWaitTrace([
    ...spawn(), call(2, "wait_agent", "wait", { timeout_ms: 30000 }), activity(3, "completed"),
    output(4, "wait", { timed_out: false }), final(5),
  ]);
  expect(result.waits[0].trackedWork).toBe("active");
  expect(result.waits[0].durationMs).toBe(2000);
  expect(result.waits[0].timedOut).toBe(false);
  expect(result.noOutstandingWorkWaits).toEqual([]);
  expect(result.coverage.complete).toBe(true);
});

test("all completed workers and delivered answers leave no outstanding tracked work at a later wait", () => {
  const result = analyzeWaitTrace([
    ...spawn(1), ...spawn(2, "beta_reader"), activity(3, "completed"), final(4),
    activity(5, "completed", "beta_reader"), final(6, "beta_reader"), ...wait(7),
  ]);
  expect(result.spawns).toHaveLength(2);
  expect(result.noOutstandingWorkWaits).toHaveLength(1);
  expect(result.noOutstandingWorkWaits[0].trackedWork).toBe("no_outstanding_work_at_entry");
  expect(result.noOutstandingWorkWaits[0].durationMs).toBe(30000);
  expect(result.noOutstandingWorkWaits[0].timedOut).toBe(true);
  expect(result.coverage).toMatchObject({ activityStarted: 2, activityCompleted: 2, finalAnswers: 2, complete: true });
});

test("a parent with no spawned agents has no outstanding tracked work at entry", () => {
  const result = analyzeWaitTrace(wait(1));
  expect(result.noOutstandingWorkWaits).toHaveLength(1);
  expect(result.spawns).toEqual([]);
  expect(result.coverage.complete).toBe(true);
});

test("completed work whose answer has not arrived is pending delivery", () => {
  const result = analyzeWaitTrace([...spawn(), activity(2, "completed"), ...wait(3), final(34)]);
  expect(result.waits[0].trackedWork).toBe("pending-result");
  expect(result.waits[0].pendingResults).toEqual(["/root/alpha_reader"]);
  expect(result.noOutstandingWorkWaits).toEqual([]);
});

test.each(["followup_task", "send_input", "resume_agent"])("%s invalidates completed work until new activity is known", (name) => {
  const result = analyzeWaitTrace([
    ...spawn(), activity(2, "completed"), final(3), call(4, name, "again", { target: "/root/alpha_reader" }),
    ...wait(5, "uncertain"), activity(36, "started"), ...wait(37, "active"),
  ]);
  expect(result.waits.map((entry) => entry.trackedWork)).toEqual(["unknown", "active"]);
  expect(result.noOutstandingWorkWaits).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});

test("ordinary messages do not restart a completed task", () => {
  const result = analyzeWaitTrace([
    ...spawn(), activity(2, "completed"), final(3), call(4, "send_message", "message", { target: "alpha_reader" }),
    row(4, "event_msg", { item: { type: "SubAgentActivity", id: "message", kind: "interacted", agent_path: "/root/alpha_reader", agent_thread_id: "thread-alpha_reader" } }), ...wait(5),
  ]);
  expect(result.noOutstandingWorkWaits).toHaveLength(1);
  expect(result.coverage.complete).toBe(true);
});

test("a completed spawn tool call does not prove worker completion", () => {
  const result = analyzeWaitTrace([...spawn(), ...wait(2)]);
  expect(result.waits[0].trackedWork).toBe("active");
  expect(result.noOutstandingWorkWaits).toEqual([]);
});

test("missing activity is reported instead of claiming no outstanding tracked work", () => {
  const result = analyzeWaitTrace([
    call(1, "spawn_agent", "spawn", { task_name: "alpha_reader" }), output(1, "spawn", { task_name: "/root/alpha_reader" }), ...wait(2),
  ]);
  expect(result.waits[0].trackedWork).toBe("unknown");
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues.length).toBeGreaterThan(0);
  expect(result.noOutstandingWorkWaits).toEqual([]);
});

test("unsupported activity and truncated waits report incomplete coverage", () => {
  const result = analyzeWaitTrace([activity(1, "paused"), call(2, "wait_agent", "wait")]);
  expect(result.waits[0].trackedWork).toBe("unknown");
  expect(result.waits[0].durationMs).toBeNull();
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues).toHaveLength(2);
});

test("a completion without its start stays unknown even after final delivery", () => {
  const result = analyzeWaitTrace([activity(1, "completed"), final(2), ...wait(3)]);
  expect(result.waits[0].trackedWork).toBe("unknown");
  expect(result.noOutstandingWorkWaits).toEqual([]);
  expect(result.coverage.complete).toBe(false);
});

test("wait outputs without timeout evidence report incomplete coverage", () => {
  const result = analyzeWaitTrace([call(1, "wait_agent", "wait"), output(2, "wait", { message: "Wait completed." })]);
  expect(result.waits[0].timedOut).toBeNull();
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues).toHaveLength(1);
});

test("a final answer without an author reports incomplete coverage", () => {
  const message = final(2);
  delete message.payload.author;
  const result = analyzeWaitTrace([...spawn(), message]);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.issues).toEqual(["Final answer without author at row 3"]);
  expect(result.messages).toEqual([]);
});

const at = (value, ms) => ({ ...value, timestamp: new Date(Date.UTC(2026, 9, 19) + ms).toISOString() });
const ordinaryMessage = (ms, overrides = {}) => at({ ...final(0), payload: { ...final(0).payload,
  content: [{ type: "input_text", text: "Message Type: MESSAGE\nPayload:\nStill checking" }], ...overrides } }, ms);
const mailboxWait = (id, start, end, timedOut = false) => [at(call(0, "wait_agent", id, { timeout_ms: 10000 }), start), at(output(0, id, { timed_out: timedOut }), end)];
const mailboxSpawn = () => spawn().map(value => at(value, 0));

test("ordinary messages during a wait and repeated post-return messages leave a rewait active until final delivery", () => {
  const first = mailboxWait("first", 10, 100);
  const second = mailboxWait("second", 200, 500);
  const result = analyzeWaitTrace([...mailboxSpawn(), first[0], ordinaryMessage(90), first[1], ordinaryMessage(102), ordinaryMessage(103),
    second[0], at(activity(0, "completed"), 490), at(final(0), 499), second[1]]);
  expect(result.waits.map(value => value.trackedWork)).toEqual(["active", "active"]);
  expect(result.waits[0].nearbyMessages.map(({ kind, timing, lagMs }) => ({ kind, timing, lagMs }))).toEqual([
    { kind: "ordinary_message", timing: "during-wait", lagMs: null },
    { kind: "ordinary_message", timing: "after-return", lagMs: 2 },
    { kind: "ordinary_message", timing: "after-return", lagMs: 3 },
  ]);
  expect(result.waits[1].nearbyMessages[0].kind).toBe("final");
  expect(result.coverage).toMatchObject({ activityCompleted: 1, finalAnswers: 1, ordinaryMessages: 3, complete: true });
  expect(result.shortTimeoutRewaits).toEqual([]);
  expect(result.noOutstandingWorkWaits).toEqual([]);
});

test("an unexplained early return retains unknown message evidence", () => {
  const result = analyzeWaitTrace([...mailboxSpawn(), ...mailboxWait("wait", 10, 100)]);
  expect(result.waits[0]).toMatchObject({ trackedWork: "active", timedOut: false, nearbyMessages: [] });
});

test("timeouts preserve ordinary messages during the wait but never attach post-return deliveries", () => {
  const [start, end] = mailboxWait("wait", 10, 100, true);
  const result = analyzeWaitTrace([...mailboxSpawn(), start, ordinaryMessage(90), end, ordinaryMessage(103)]);
  expect(result.waits[0].timedOut).toBe(true);
  expect(result.waits[0].nearbyMessages.map(value => value.rowIndex)).toEqual([4]);
  expect(result.messages).toHaveLength(2);
});

test.each(["reasoning", "message", "function_call", "custom_tool_call"])("parent %s is a post-return boundary", type => {
  const boundary = at(row(0, "response_item", { type, role: "assistant", namespace: "functions", name: "exec", arguments: "{}" }), 101);
  const result = analyzeWaitTrace([...mailboxSpawn(), ...mailboxWait("wait", 10, 100), boundary, ordinaryMessage(103)]);
  expect(result.waits[0].nearbyMessages).toEqual([]);
  expect(result.messages).toHaveLength(1);
});

test.each([100, 101])("post-return evidence window has an inclusive 100ms bound, lag %d", lag => {
  const result = analyzeWaitTrace([...mailboxSpawn(), ...mailboxWait("wait", 10, 100), ordinaryMessage(100 + lag)]);
  expect(result.waits[0].nearbyMessages).toHaveLength(lag === 100 ? 1 : 0);
});

test("unrelated, malformed, reversed, overlapping and missing-output deliveries stay unassociated", () => {
  const [start, end] = mailboxWait("wait", 10, 100);
  for (const message of [ordinaryMessage(103, { recipient: "/root/other" }), ordinaryMessage(103, { author: "/other" }), ordinaryMessage(99),
    ordinaryMessage(103, { content: [{ text: "Message Type: MESSAGE_EXTRA\nPayload" }] })]) {
    expect(analyzeWaitTrace([...mailboxSpawn(), start, end, message]).waits[0].nearbyMessages).toEqual([]);
  }
  const result = analyzeWaitTrace([...mailboxSpawn(), start, at(call(0, "wait_agent", "overlap"), 20), ordinaryMessage(30),
    at(output(0, "overlap", { timed_out: false }), 40), end]);
  expect(result.waits.every(value => value.nearbyMessages.length === 0)).toBe(true);
  expect(analyzeWaitTrace([...mailboxSpawn(), start, ordinaryMessage(30)]).waits[0].nearbyMessages).toEqual([]);
  expect(analyzeWaitTrace([...mailboxSpawn(), start, end, at(row(0, "event_msg", { type: "user_message" }), 101), ordinaryMessage(103)]).waits[0].nearbyMessages).toEqual([]);
});

test("ordinary clarification and blocker messages remain ordinary message evidence", () => {
  const [start, end] = mailboxWait("wait", 10, 100);
  const question = ordinaryMessage(50, { content: [{ text: "Message Type: MESSAGE\nPayload:\nWhich input should I use?" }] });
  const blocker = ordinaryMessage(103, { content: [{ text: "Message Type: MESSAGE\nPayload:\nBlocked until the input arrives." }] });
  const facts = analyzeWaitTrace([...mailboxSpawn(), start, question, end, blocker]);
  expect(facts.coverage).toMatchObject({ ordinaryMessages: 2, finalAnswers: 0 });
  expect(facts.waits[0].nearbyMessages.map(message => message.kind)).toEqual(["ordinary_message", "ordinary_message"]);
  expect(facts.waits[0].deliveredResults).toEqual([]);
});

test("an unrelated ordinary message preserves an observed short-timeout rewait", () => {
  const first = mailboxWait("first", 10, 10010, true);
  const second = mailboxWait("second", 10020, 20020, true);
  const facts = analyzeWaitTrace([...mailboxSpawn(), ...first, ordinaryMessage(10015, { author: "/root/unrelated" }), ...second]);
  expect(facts.shortTimeoutRewaits).toEqual([{ previousCallId: "first", callId: "second", interveningMessages: [facts.messages[0]] }]);
  expect(facts.waits[0].nearbyMessages).toEqual([]);
});

test("a lifecycle transition breaks the immediate short-timeout rewait pattern", () => {
  const first = mailboxWait("first", 10, 10010, true);
  const second = mailboxWait("second", 10020, 20020, true);
  const facts = analyzeWaitTrace([...mailboxSpawn(), ...first, at(activity(0, "completed"), 10011),
    at(activity(0, "started"), 10012), ...second]);
  expect(facts.waits.map(wait => wait.trackedWork)).toEqual(["active", "active"]);
  expect(facts.shortTimeoutRewaits).toEqual([]);
});

test("overlapping and reversed wait calls cannot follow an observed timeout", () => {
  const first = mailboxWait("first", 10, 10010, true);
  const second = mailboxWait("second", 20, 10020, true);
  expect(analyzeWaitTrace([...mailboxSpawn(), first[0], ...second, first[1]]).shortTimeoutRewaits).toEqual([]);
  const reversed = mailboxWait("second", 10000, 20000, true);
  expect(analyzeWaitTrace([...mailboxSpawn(), ...first, ...reversed]).shortTimeoutRewaits).toEqual([]);
});

test("a mailbox receive can be required after all tracked work is complete", () => {
  const facts = analyzeWaitTrace([...mailboxSpawn(), at(activity(0, "completed"), 10), at(final(0), 20),
    ...mailboxWait("wait", 40, 50), ordinaryMessage(53)]);
  const expectations = [{ callId: "wait", requiredAgents: ["/root/alpha_reader"],
    independentWork: "exhausted", mailboxReceive: "required" }];
  expect(facts.waits[0].trackedWork).toBe("no_outstanding_work_at_entry");
  expect(facts.waits[0].timedOut).toBe(false);
  expect(facts.waits[0].nearbyMessages).toMatchObject([{ kind: "ordinary_message", timing: "after-return", lagMs: 3 }]);
  expect(assessWaits(facts, expectations).status).toBe("pass");
  expect(assessWaits(facts, [{ ...expectations[0], mailboxReceive: "not-required" }]).status).toBe("fail");
});

test("known available independent work fails even when a required result is outstanding", () => {
  const facts = analyzeWaitTrace([...spawn(), ...wait(2)]);
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader"], independentWork: "available" }]).status).toBe("fail");
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader"] }]).status).toBe("unknown");
});

test("delivery before lifecycle completion satisfies a required result at entry", () => {
  const facts = analyzeWaitTrace([...spawn(), final(2), ...wait(3)]);
  expect(facts.waits[0]).toMatchObject({ trackedWork: "active", activeAgents: ["/root/alpha_reader"], deliveredResults: ["/root/alpha_reader"] });
  expect(facts.waits[0]).not.toHaveProperty("args");
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader"],
    independentWork: "exhausted", mailboxReceive: "not-required" }]).status).toBe("fail");
});

test("a required agent absent from the trace stays unknown", () => {
  const facts = analyzeWaitTrace(wait(1));
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/untracked"],
    independentWork: "exhausted", mailboxReceive: "not-required" }]).status).toBe("unknown");
});

test("followup invalidates delivered results and a new started event establishes outstanding work", () => {
  const facts = analyzeWaitTrace([...spawn(), final(2), activity(3, "completed"),
    call(4, "followup_task", "again", { target: "/root/alpha_reader" }), ...wait(5, "unknown"),
    activity(36, "started"), ...wait(37, "active")]);
  expect(facts.waits.map(wait => wait.deliveredResults)).toEqual([[], []]);
  const expectations = facts.waits.map(wait => ({ callId: wait.callId, requiredAgents: ["/root/alpha_reader"],
    independentWork: "exhausted", mailboxReceive: "not-required" }));
  expect(assessWaits(facts, expectations)).toMatchObject({ status: "unknown", waits: [
    { callId: "unknown", status: "unknown" }, { callId: "active", status: "pass" },
  ] });
});

test("mixed delivered and outstanding required results still support waiting", () => {
  const facts = analyzeWaitTrace([...spawn(), ...spawn(1, "beta_reader"), final(2), ...wait(3)]);
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader", "/root/beta_reader"],
    independentWork: "exhausted", mailboxReceive: "not-required" }]).status).toBe("pass");
});

test("completion with pending delivery supports a required-result wait", () => {
  const facts = analyzeWaitTrace([...spawn(), activity(2, "completed"), ...wait(3), final(34)]);
  expect(facts.waits[0].deliveredResults).toEqual([]);
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader"],
    independentWork: "exhausted", mailboxReceive: "not-required" }]).status).toBe("pass");
});

test("delivery during a wait does not alter its entry snapshot", () => {
  const facts = analyzeWaitTrace([...spawn(), call(2, "wait_agent", "wait", { timeout_ms: 10000 }), final(3), output(4, "wait", { timed_out: false })]);
  expect(facts.waits[0].deliveredResults).toEqual([]);
  expect(facts.coverage.finalAnswers).toBe(1);
  expect(assessWaits(facts, [{ callId: "wait", requiredAgents: ["/root/alpha_reader"],
    independentWork: "exhausted", mailboxReceive: "not-required" }]).status).toBe("pass");
});

test("omitted result requirements differ from an explicit empty list", () => {
  const facts = analyzeWaitTrace(wait(1));
  const entry = { callId: "wait", independentWork: "exhausted", mailboxReceive: "not-required" };
  expect(assessWaits(facts, [entry]).status).toBe("unknown");
  expect(assessWaits(facts, [{ ...entry, requiredAgents: [] }]).status).toBe("fail");
  expect(assessWaits(facts, [{ ...entry, requiredAgents: [], mailboxReceive: "required" }]).status).toBe("pass");
});

test("unexplained return timing does not declare the conditions needed for a verdict", () => {
  const facts = analyzeWaitTrace([...mailboxSpawn(), ...mailboxWait("wait", 10, 100)]);
  expect(assessWaits(facts, []).status).toBe("unknown");
  expect(facts.waits[0].nearbyMessages).toEqual([]);
});

test("failed expectations take precedence over unknown expectations", () => {
  const facts = analyzeWaitTrace([...wait(1, "first"), ...wait(32, "second")]);
  expect(assessWaits(facts, [{ callId: "first", independentWork: "available" }])).toMatchObject({
    status: "fail", waits: [{ status: "fail" }, { status: "unknown" }],
  });
});

test.each([
  null, {}, [null], [{}], [{ callId: "absent" }], [{ callId: "wait" }, { callId: "wait" }],
  [{ callId: "wait", requiredAgents: "alpha" }], [{ callId: "wait", requiredAgents: [null] }],
  [{ callId: "wait", independentWork: "maybe" }], [{ callId: "wait", mailboxReceive: "maybe" }],
  [{ callId: "wait", unused: true }],
].map(expectations => ({ expectations })))("invalid expectation declaration %# is rejected", ({ expectations }) => {
  expect(() => assessWaits(analyzeWaitTrace(wait(1)), expectations)).toThrow(TypeError);
});
