import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sanitizeWaitTrace } from "../../tools/codex/sanitize-waits.mjs";
import { analyzeWaitTrace } from "../../tools/codex/lib/wait-trace.mjs";

const load = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse);
const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

test("sanitization preserves user-message boundaries without retaining private text", () => {
  const source = load("synthetic-mailbox.jsonl");
  source.splice(7, 0, { timestamp: "2026-10-25T00:00:00.101Z", type: "event_msg",
    payload: { type: "user_message", message: "PRIVATE-USER-MESSAGE" } });
  const sanitized = sanitizeWaitTrace(source);
  expect(JSON.stringify(sanitized)).not.toContain("PRIVATE-USER-MESSAGE");
  expect(sanitized.some(row => row.type === "event_msg" && row.payload.type === "user_message")).toBe(true);
  expect(analyzeWaitTrace(source).waits[0].nearbyMessages).toEqual([]);
  expect(analyzeWaitTrace(sanitized).waits[0].nearbyMessages).toEqual([]);
});

test("sanitization removes private content while retaining polling behavior and token usage", () => {
  const secret = "PRIVATE-CONTENT-DO-NOT-RETAIN";
  const source = load("active-worker-polling.jsonl").map(row => {
    const copy = structuredClone(row);
    const p = copy.payload;
    p.private_metadata = secret;
    if (p.type === "function_call") p.arguments = JSON.stringify({ ...JSON.parse(p.arguments), message: secret });
    if (p.type === "custom_tool_call") p.input = secret;
    if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      try { p.output = JSON.stringify({ ...JSON.parse(p.output), message: secret }); }
      catch { p.output = secret; }
    }
    if (p.type === "message") p.content = [{ type: "input_text", text: secret }];
    if (p.type === "reasoning") p.encrypted_content = secret;
    if (p.type === "agent_message") p.content[0].text = p.content[0].text.replace("[Report omitted]", secret);
    if (p.type === "token_count") p.rate_limits = { private: secret };
    return copy;
  });
  const projected = sanitizeWaitTrace(source, [{ path: "/responses", source: "user", route: "upstream", agent: "/root",
    model: "gpt-6.1-sol", startedAt: source[0].timestamp, status: 200, authorization: secret }]);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(analyzeWaitTrace(projected)).toMatchObject({ coverage: { complete: true, finalAnswers: 3 } });
  expect(analyzeWaitTrace(projected).shortTimeoutRewaits).toHaveLength(1);
  expect(analyzeWaitTrace(projected).waits.map(wait => [wait.callId, wait.trackedWork, wait.durationMs, wait.timedOut]))
    .toEqual(analyzeWaitTrace(source).waits.map(wait => [wait.callId, wait.trackedWork, wait.durationMs, wait.timedOut]));
  expect(projected.filter(row => ["custom_tool_call", "custom_tool_call_output"].includes(row.payload?.type)))
    .toHaveLength(source.filter(row => ["custom_tool_call", "custom_tool_call_output"].includes(row.payload?.type)).length);
  expect(projected.filter(row => row.type === "token_usage_record").map(row => row.payload.usage))
    .toEqual(source.filter(row => row.type === "token_usage_record").map(row => row.payload.usage));
  expect(projected.filter(row => row.type === "proxy_request")).toHaveLength(1);
});

test.each(manifest)("$file retains recorded request boundaries and token accounting", item => {
  const rows = load(item.file);
  expect(rows.filter(row => row.type === "proxy_request")).toHaveLength(item.parentRequests);
  expect(rows.filter(row => row.type === "token_usage_record")).toHaveLength(item.responseUsageRecords);
  expect(rows.findLast(row => row.payload?.type === "token_count").payload.info.total_token_usage).toEqual(item.finalTokenUsage);
  expect(rows.filter(row => row.type === "proxy_request").every(row => row.payload.agent === "/root" && row.payload.status === 200)).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/gAAAAA|encrypted_content|authorization|C:\\\\Users/);
});

test("sanitization preserves mailbox evidence and never invents ordinary messages from unknown envelopes", () => {
  const source = load("synthetic-mailbox.jsonl");
  const unknown = structuredClone(source.find(row => row.payload?.type === "agent_message"));
  unknown.payload.content[0].text = "Message Type: MESSAGE_EXTRA\nPrivate content";
  source.splice(8, 0, unknown);
  const projected = sanitizeWaitTrace(source);
  expect(projected[0].payload.fixture_kind).toBe("synthetic");
  const before = analyzeWaitTrace(source);
  const after = analyzeWaitTrace(projected);
  expect(after.messages).toEqual(before.messages);
  expect(after.waits.map(wait => wait.nearbyMessages)).toEqual(before.waits.map(wait => wait.nearbyMessages));
  expect(after.coverage).toEqual(before.coverage);
  expect(JSON.stringify(projected)).not.toContain("Private content");
});
