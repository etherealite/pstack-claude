import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../tools/codex/replay-waits.mjs", import.meta.url));
const row = (second, type, payload) => ({ timestamp: new Date(Date.UTC(2026, 9, 19, 0, 0, second)).toISOString(), type, payload });
const meta = row(0, "session_meta", { id: "parent" });
const start = (second) => row(second, "event_msg", { type: "task_started" });
const done = (second) => row(second, "event_msg", { type: "task_complete" });

function replay(rows, expectations) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pstack-wait-replay-")));
  try {
    const path = join(directory, "parent.jsonl");
    writeFileSync(path, typeof rows === "string" ? rows : rows.map((value) => JSON.stringify(value)).join("\n"));
    const args = [script, path];
    if (expectations !== undefined) {
      const selected = join(directory, "expectations.json");
      writeFileSync(selected, typeof expectations === "string" ? expectations : JSON.stringify(expectations));
      args.push("--expectations", selected);
    }
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
    if (result.error) throw result.error;
    return { status: result.status, summary: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
  } finally {
    if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith("pstack-wait-replay-")) throw new Error(`Unexpected cleanup path: ${directory}`);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("raw replay exits zero for a finished trace without waits", () => {
  const result = replay([meta, start(1), done(2)]);
  expect(result.status).toBe(0);
  expect(result.summary).toMatchObject({ complete: true, facts: { noOutstandingWorkWaits: [] } });
  expect(result.summary.assessment).toBeUndefined();
});

const noWorkWait = [meta, start(1),
  row(2, "response_item", { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: "wait-1", arguments: '{"timeout_ms":10000}' }),
  row(12, "response_item", { type: "function_call_output", call_id: "wait-1", output: '{"timed_out":true}' }), done(13)];

test.each([
  { entry: { independentWork: "available" }, status: "fail", exit: 1 },
  { entry: { independentWork: "exhausted", requiredAgents: [], mailboxReceive: "not-required" }, status: "fail", exit: 1 },
  { entry: { independentWork: "exhausted", requiredAgents: [], mailboxReceive: "required" }, status: "pass", exit: 0 },
  { entry: { requiredAgents: [] }, status: "unknown", exit: 2 },
  { entry: { independentWork: "exhausted", requiredAgents: ["/root/untracked"], mailboxReceive: "not-required" }, status: "unknown", exit: 2 },
])("explicit $status expectation determines replay exit $exit", ({ entry, status, exit }) => {
  const result = replay(noWorkWait, [{ callId: "wait-1", ...entry }]);
  expect(result.status).toBe(exit);
  expect(result.summary.assessment.status).toBe(status);
  expect(result.summary.facts.noOutstandingWorkWaits).toHaveLength(1);
});

test.each([
  { expectations: [{ callId: "absent" }] },
  { expectations: [{ callId: "wait-1" }, { callId: "wait-1" }] },
  { expectations: [{}] },
  { expectations: "{" },
])("invalid selected expectations exit two with stderr %#", ({ expectations }) => {
  const result = replay(noWorkWait, expectations);
  expect(result.status).toBe(2);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.summary).toBeNull();
});

test("malformed rollout JSON and unknown options exit two", () => {
  expect(replay("{").status).toBe(2);
  const fixture = fileURLToPath(new URL("./fixtures/automatic-results.jsonl", import.meta.url));
  const result = spawnSync(process.execPath, [script, fixture, "--unsupported"], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Usage:");
});

test("an earlier completed turn does not hide a later unfinished turn", () => {
  const result = replay([meta, start(1), done(2), start(3)]);
  expect(result.status).toBe(2);
  expect(result.summary.complete).toBe(false);
});

test("raw replay exits zero for a completed wait without outstanding tracked work", () => {
  const result = replay([
    meta, start(1), row(2, "response_item", { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: "wait-1", arguments: '{"timeout_ms":10000}' }),
    row(12, "response_item", { type: "function_call_output", call_id: "wait-1", output: '{"timed_out":true}' }), done(13),
  ]);
  expect(result.status).toBe(0);
  expect(result.summary.complete).toBe(true);
  expect(result.summary.facts.noOutstandingWorkWaits).toHaveLength(1);
  expect(result.summary.facts.waits[0]).toMatchObject({ trackedWork: "no_outstanding_work_at_entry", durationMs: 10000, timedOut: true });
});

test("replay exits two when a wait has no recorded result", () => {
  const result = replay([
    meta, start(1), row(2, "response_item", { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: "wait-1", arguments: '{"timeout_ms":10000}' }), done(3),
  ]);
  expect(result.status).toBe(2);
  expect(result.summary.complete).toBe(false);
});

test("raw replay records active-worker polling without a behavioral verdict", () => {
  const fixture = fileURLToPath(new URL("./fixtures/active-worker-polling.jsonl", import.meta.url));
  const ordinary = spawnSync(process.execPath, [script, fixture], { encoding: "utf8", timeout: 10_000 });
  expect(ordinary.status).toBe(0);
  const summary = JSON.parse(ordinary.stdout);
  expect(summary.facts.shortTimeoutRewaits).toHaveLength(1);
  expect(summary.assessment).toBeUndefined();
});

test.each(["interruptible-waits", "automatic-results"])("%s has complete replay facts", name => {
  const fixture = fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url));
  const ordinary = spawnSync(process.execPath, [script, fixture], { encoding: "utf8", timeout: 10_000 });
  expect(ordinary.status).toBe(0);
  const summary = JSON.parse(ordinary.stdout);
  expect(summary.complete).toBe(true);
  expect(summary.facts.spawns).toHaveLength(3);
  expect(summary.facts).toMatchObject({ coverage: { finalAnswers: 3 }, noOutstandingWorkWaits: [], shortTimeoutRewaits: [] });
});

test("synthetic mailbox replay retains ordinary and final timing with explicit expectations", () => {
  const fixture = fileURLToPath(new URL("./fixtures/synthetic-mailbox.jsonl", import.meta.url));
  const expectations = fileURLToPath(new URL("./fixtures/synthetic-mailbox.expectations.json", import.meta.url));
  const result = spawnSync(process.execPath, [script, fixture, "--expectations", expectations], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(0);
  const replay = JSON.parse(result.stdout);
  expect(replay.assessment.status).toBe("pass");
  const summary = replay.facts;
  expect(summary.coverage).toMatchObject({ ordinaryMessages: 2, finalAnswers: 1, complete: true });
  expect(summary.waits.map(wait => wait.trackedWork)).toEqual(["active", "active", "active"]);
  expect(summary.waits.map(wait => wait.nearbyMessages.map(({ kind, timing, lagMs }) => ({ kind, timing, lagMs })))).toEqual([
    [{ kind: "ordinary_message", timing: "after-return", lagMs: 3 }],
    [{ kind: "ordinary_message", timing: "during-wait", lagMs: null }],
    [{ kind: "final", timing: "after-return", lagMs: 2 }],
  ]);
  expect(summary.messages).toHaveLength(3);
  expect(summary).toMatchObject({ noOutstandingWorkWaits: [], shortTimeoutRewaits: [] });
});
