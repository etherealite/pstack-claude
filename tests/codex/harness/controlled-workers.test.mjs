import { expect, test } from "bun:test";
import { assertControlledWorkers, createWorkerProxy } from "./controlled-workers.mjs";
import { assertReviewAnswers } from "../../../benchmarks/codex/support/waiting-suite.mjs";

function inferenceRequest(proxy, metadata, body = "{}") {
  return fetch(`${proxy.url}/v1/responses`, { method: "POST", body,
    headers: { "content-type": "application/json", authorization: "Bearer local-test-only", "x-codex-turn-metadata": JSON.stringify(metadata) } });
}

test("parent requests preserve authentication, payload, and streamed response", async () => {
  const forwarded = [];
  const proxy = createWorkerProxy({ forward: async (url, options) => {
    forwarded.push({ url, authorization: options.headers.get("authorization"), body: new TextDecoder().decode(options.body) });
    return new Response("event: response.completed\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const response = await inferenceRequest(proxy, { agent_name: "/root", thread_source: "user", thread_id: "parent" }, '{"model":"gpt-6.1-sol","input":[]}');
    expect(await response.text()).toBe("event: response.completed\ndata: {}\n\n");
    expect(forwarded).toEqual([{ url: "https://chatgpt.com/backend-api/codex/responses", authorization: "Bearer local-test-only", body: '{"model":"gpt-6.1-sol","input":[]}' }]);
    expect(JSON.stringify(proxy.control)).not.toContain("Bearer");
  } finally { proxy.stop(); }
});

test("three worker responses finish locally with zero upstream worker inference", async () => {
  const forwarded = [];
  const workerDelays = new Map([["first", 1], ["second", 1], ["third", 1]]);
  const proxy = createWorkerProxy({ workerDelays, forward: async (_, options) => {
    forwarded.push(JSON.parse(options.headers.get("x-codex-turn-metadata")));
    return new Response("parent response");
  } });
  try {
    for (const model of workerDelays.keys()) {
      const response = await inferenceRequest(proxy, { agent_name: `/root/${model}`, thread_source: "subagent", thread_id: model, model });
      const stream = await response.text();
      expect(stream).toContain("event: response.completed");
      expect(stream).toContain('"total_tokens":0');
      assertReviewAnswers(stream);
    }
    await (await inferenceRequest(proxy, { agent_name: "/root", thread_source: "user", thread_id: "parent" })).text();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].agent_name).toBe("/root");
    expect(proxy.control.workerUpstreamRequests).toBe(0);
    assertControlledWorkers(proxy.control);
    proxy.control.observations.push({ path: "/responses", source: "subagent", route: "upstream", status: 200 });
    expect(() => assertControlledWorkers(proxy.control)).toThrow("Workers must never invoke upstream inference");
  } finally { proxy.stop(); }
});

test("unsupported worker models and unclassified inference cannot escape upstream", async () => {
  let forwarded = 0;
  const proxy = createWorkerProxy({ forward: async () => { forwarded++; return new Response("unexpected"); } });
  try {
    const worker = await inferenceRequest(proxy, { agent_name: "/root/worker", thread_source: "subagent", thread_id: "worker", model: "unknown" });
    expect(worker.status).toBe(400);
    await worker.text();
    const unclassified = await inferenceRequest(proxy, {});
    expect(unclassified.status).toBe(400);
    await unclassified.text();
    expect(forwarded).toBe(0);
  } finally { proxy.stop(); }
});

test("worker retries are rejected rather than invoking a paid fallback", async () => {
  let forwarded = 0;
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 1]]), forward: async () => { forwarded++; return new Response("unexpected"); } });
  const metadata = { agent_name: "/root/worker", thread_source: "subagent", thread_id: "worker", model: "worker" };
  try {
    await (await inferenceRequest(proxy, metadata)).text();
    const retry = await inferenceRequest(proxy, metadata);
    expect(retry.status).toBe(400);
    await retry.text();
    expect(forwarded).toBe(0);
  } finally { proxy.stop(); }
});

test("review answer checks accept LaTeX grouping and reject incorrect counts", () => {
  assertReviewAnswers("A is correct: \\(132\\,057\\,411\\,984\\). B needs correction to 79,068,200,083,062,153,040.");
  expect(() => assertReviewAnswers("A: 132,057,411,985. B: 79,068,200,083,062,153,040.")).toThrow();
  expect(() => assertReviewAnswers("A: 132,057,411,984. B: 95,846,086,442,150,951,368.")).toThrow();
});
