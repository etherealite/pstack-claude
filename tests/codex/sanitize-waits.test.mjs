import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sanitizeWaitTrace } from "../../tools/codex/sanitize-waits.mjs";
import { analyzeWaitTrace } from "../../tools/codex/lib/wait-trace.mjs";

const load = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split(/\r?\n/).map(JSON.parse);
const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

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
  expect(analyzeWaitTrace(projected).shortWaitRetries).toHaveLength(1);
  expect(analyzeWaitTrace(projected).waits.map(wait => [wait.callId, wait.classification, wait.durationMs, wait.timedOut]))
    .toEqual(analyzeWaitTrace(source).waits.map(wait => [wait.callId, wait.classification, wait.durationMs, wait.timedOut]));
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
