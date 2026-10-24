import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./replay-waits.mjs", import.meta.url));
const row = (second, type, payload) => ({ timestamp: new Date(Date.UTC(2026, 9, 19, 0, 0, second)).toISOString(), type, payload });
const meta = row(0, "session_meta", { id: "parent" });
const start = (second) => row(second, "event_msg", { type: "task_started" });
const done = (second) => row(second, "event_msg", { type: "task_complete" });

function replay(rows) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pstack-wait-replay-")));
  try {
    const path = join(directory, "parent.jsonl");
    writeFileSync(path, rows.map((value) => JSON.stringify(value)).join("\n"));
    const result = spawnSync(process.execPath, [script, path], { encoding: "utf8", timeout: 10_000 });
    if (result.error) throw result.error;
    return { status: result.status, summary: JSON.parse(result.stdout) };
  } finally {
    if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith("pstack-wait-replay-")) throw new Error(`Unexpected cleanup path: ${directory}`);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("replay exits zero for a finished trace with no empty waits", () => {
  const result = replay([meta, start(1), done(2)]);
  expect(result.status).toBe(0);
  expect(result.summary).toMatchObject({ complete: true, emptyWaits: 0 });
});

test("an earlier completed turn does not hide a later unfinished turn", () => {
  const result = replay([meta, start(1), done(2), start(3)]);
  expect(result.status).toBe(2);
  expect(result.summary.complete).toBe(false);
});

test("replay exits one for a completed empty wait", () => {
  const result = replay([
    meta, start(1), row(2, "response_item", { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: "wait-1", arguments: '{"timeout_ms":10000}' }),
    row(12, "response_item", { type: "function_call_output", call_id: "wait-1", output: '{"timed_out":true}' }), done(13),
  ]);
  expect(result.status).toBe(1);
  expect(result.summary).toMatchObject({ complete: true, emptyWaits: 1 });
  expect(result.summary.waits[0]).toMatchObject({ classification: "empty", durationMs: 10000, timedOut: true });
});

test("replay exits two when a wait has no recorded result", () => {
  const result = replay([
    meta, start(1), row(2, "response_item", { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: "wait-1", arguments: '{"timeout_ms":10000}' }), done(3),
  ]);
  expect(result.status).toBe(2);
  expect(result.summary.complete).toBe(false);
});

test("the historical short wait pattern fails only when that policy is selected", () => {
  const fixture = fileURLToPath(new URL("./fixtures/planning-original.jsonl", import.meta.url));
  const ordinary = spawnSync(process.execPath, [script, fixture], { encoding: "utf8", timeout: 10_000 });
  const strict = spawnSync(process.execPath, [script, fixture, "--short-waits"], { encoding: "utf8", timeout: 10_000 });
  expect(ordinary.status).toBe(0);
  expect(strict.status).toBe(1);
  expect(JSON.parse(strict.stdout)).toMatchObject({ complete: true, emptyWaits: 0, shortWaitRetries: 1 });
});
