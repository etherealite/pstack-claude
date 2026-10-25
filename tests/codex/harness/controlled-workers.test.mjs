import { expect, test } from "bun:test";
import { assertControlledWorkers, createWorkerProxy } from "./controlled-workers.mjs";
import { assertExpectedNumberSmokeCheck } from "../../../benchmarks/codex/support/waiting-suite.mjs";

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
      assertExpectedNumberSmokeCheck(stream);
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

test("expected-number smoke check accepts LaTeX grouping and rejects missing expected numbers", () => {
  assertExpectedNumberSmokeCheck("A is correct: \\(132\\,057\\,411\\,984\\). B needs correction to 79,068,200,083,062,153,040.");
  expect(() => assertExpectedNumberSmokeCheck("A: 132,057,411,985. B: 79,068,200,083,062,153,040.")).toThrow();
  expect(() => assertExpectedNumberSmokeCheck("A: 132,057,411,984. B: 95,846,086,442,150,951,368.")).toThrow();
});

const advertisedTools = [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "send_message",
  parameters: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"], additionalProperties: false } }] }];
const workerBody = input => JSON.stringify({ input: [{ type: "additional_tools", tools: advertisedTools }, ...input] });
const completedItem = text => text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
  .find(event => event.type === "response.completed").response.output[0];
const acknowledgment = (id, output = "") => ({ type: "function_call_output", call_id: id, output });
const identity = { agent_name: "/root/worker", thread_source: "subagent", thread_id: "worker", model: "worker" };

test("scheduled tool messages and final reports stay local and retain the original final deadline", async () => {
  let upstream = 0;
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 50]]), progressMessages: [{ atMs: 1, text: "First progress" }, { atMs: 2, text: "Second progress" }],
    forward: async () => { upstream++; throw new Error("No worker inference allowed"); } });
  try {
    const first = completedItem(await (await inferenceRequest(proxy, identity, workerBody([]))).text());
    expect(first).toMatchObject({ type: "function_call", namespace: "collaboration", name: "send_message" });
    expect(JSON.parse(first.arguments)).toEqual({ target: "/root", message: "First progress" });
    const second = completedItem(await (await inferenceRequest(proxy, identity, workerBody([acknowledgment(first.call_id)]))).text());
    expect(second.call_id).not.toBe(first.call_id);
    expect(JSON.parse(second.arguments)).toEqual({ target: "/root", message: "Second progress" });
    const final = await (await inferenceRequest(proxy, identity, workerBody([acknowledgment(first.call_id), acknowledgment(second.call_id)]))).text();
    assertExpectedNumberSmokeCheck(final);
    expect(proxy.control.observations.map(item => item.kind)).toEqual(["progress", "progress", "final"]);
    const start = proxy.control.workers[0].startedAtMs;
    expect(proxy.control.observations.map(item => Date.parse(item.scheduledAt) - start)).toEqual([1, 2, 50]);
    expect(proxy.control.workers[0].phase).toBe("finished");
    expect(proxy.control.workers[0].acknowledgedCalls).toEqual([first.call_id, second.call_id]);
    expect(upstream).toBe(0);
  } finally { proxy.stop(); }
});

test.each(["missing", "wrong", "failed", "duplicate", "changed-model", "changed-agent", "changed-thread", "new-worker-ack"])("%s continuation cannot bypass local acknowledgment validation", async kind => {
  let upstream = 0;
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 10], ["other", 10]]), progressMessages: [{ atMs: 0, text: "Progress" }],
    forward: async () => { upstream++; throw new Error("No worker inference allowed"); } });
  try {
    const first = completedItem(await (await inferenceRequest(proxy, identity, workerBody([]))).text());
    let outputs = [acknowledgment(first.call_id)];
    if (kind === "missing") outputs = [];
    if (kind === "wrong") outputs = [acknowledgment("wrong")];
    if (kind === "failed") outputs = [acknowledgment(first.call_id, '{"error":"Unknown target"}')];
    if (kind === "duplicate") outputs.push(acknowledgment(first.call_id));
    const metadata = { ...identity, ...(kind === "changed-model" ? { model: "other" } : {}),
      ...(kind === "changed-agent" ? { agent_name: "/root/other" } : {}),
      ...(kind === "changed-thread" ? { thread_id: "other" } : {}),
      ...(kind === "new-worker-ack" ? { thread_id: "other", agent_name: "/root/other" } : {}) };
    const response = await inferenceRequest(proxy, metadata, workerBody(outputs));
    expect(response.status).toBe(400);
    await response.text();
    expect(upstream).toBe(0);
  } finally { proxy.stop(); }
});

test("concurrent requests and replay-only acknowledgments are rejected without upstream inference", async () => {
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 100]]), progressMessages: [{ atMs: 10, text: "First" }, { atMs: 20, text: "Second" }], forward: () => { throw new Error("No upstream"); } });
  try {
    const pending = await inferenceRequest(proxy, identity, workerBody([]));
    const concurrent = await inferenceRequest(proxy, identity, workerBody([]));
    expect(concurrent.status).toBe(400);
    await concurrent.text();
    const first = completedItem(await pending.text());
    const second = completedItem(await (await inferenceRequest(proxy, identity, workerBody([acknowledgment(first.call_id)]))).text());
    const replay = await inferenceRequest(proxy, identity, workerBody([acknowledgment(first.call_id)]));
    expect(replay.status).toBe(400);
    await replay.text();
    expect(second.call_id).not.toBe(first.call_id);
    expect(proxy.control.workerUpstreamRequests).toBe(0);
  } finally { proxy.stop(); }
});

test("unsupported advertised tools and invalid schedules fail closed", async () => {
  for (const progressMessages of [[{ atMs: 1, text: "" }], [{ atMs: 5, text: "late" }], [{ atMs: 2, text: "a" }, { atMs: 1, text: "b" }]]) {
    expect(() => createWorkerProxy({ workerDelays: new Map([["worker", 5]]), progressMessages })).toThrow("Invalid progress schedule");
  }
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 10]]), progressMessages: [{ atMs: 0, text: "Progress" }], forward: () => { throw new Error("No upstream"); } });
  try {
    const response = await inferenceRequest(proxy, identity, JSON.stringify({ input: [] }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unsupported advertised");
    expect(proxy.control.workerRequests).toBe(0);
  } finally { proxy.stop(); }
});

const parentIdentity = { agent_name: "/root", thread_source: "user", thread_id: "parent" };
const mailboxProgress = (id, author = "/root/worker") => ({ type: "agent_message", id, author, recipient: "/root",
  content: [{ type: "input_text", text: `Message Type: MESSAGE\nTask name: /root\nSender: ${author}\nPayload:\n` },
    { type: "encrypted_content", encrypted_content: "local-test-ciphertext" }] });

async function releaseProgress(proxy, metadata = identity, count = 2) {
  const outputs = [];
  for (let index = 0; index < count; index++) {
    const item = completedItem(await (await inferenceRequest(proxy, metadata, workerBody(outputs))).text());
    outputs.push(acknowledgment(item.call_id));
  }
}

test("forwarded progress restores exact scheduled text and preserves IDs across repeated histories", async () => {
  const forwarded = [];
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 100]]),
    progressMessages: [{ atMs: 0, text: "First progress\nWith detail." }, { atMs: 1, text: "Second progress" }],
    forward: async (_, options) => { forwarded.push(JSON.parse(new TextDecoder().decode(options.body))); return new Response("parent"); } });
  try {
    await releaseProgress(proxy);
    const first = mailboxProgress("amsg-first");
    const second = mailboxProgress("amsg-second");
    for (const input of [[first], [first, second], [second, first]]) {
      expect((await inferenceRequest(proxy, parentIdentity, JSON.stringify({ input }))).status).toBe(200);
    }
    const restored = (message, text) => ({ ...message, content: [{ type: "input_text", text: message.content[0].text + text }] });
    const restoredFirst = restored(first, "First progress\nWith detail.");
    const restoredSecond = restored(second, "Second progress");
    expect(forwarded.map(body => body.input)).toEqual([[restoredFirst], [restoredFirst, restoredSecond], [restoredSecond, restoredFirst]]);
    expect(proxy.control.workers[0].messageIds).toEqual([["amsg-first", 0], ["amsg-second", 1]]);
    expect(proxy.control.observations.at(-1).hydratedMessages).toEqual([
      { id: "amsg-second", worker: "/root/worker", kind: "progress", scheduleIndex: 1 },
      { id: "amsg-first", worker: "/root/worker", kind: "progress", scheduleIndex: 0 },
    ]);
    expect(JSON.stringify(proxy.control)).not.toContain("local-test-ciphertext");
  } finally { proxy.stop(); }
});

test("workers bind progress independently of cross-worker delivery order", async () => {
  const forwarded = [];
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 100]]),
    progressMessages: [{ atMs: 0, text: "First" }, { atMs: 1, text: "Second" }],
    forward: async (_, options) => { forwarded.push(JSON.parse(new TextDecoder().decode(options.body))); return new Response("parent"); } });
  try {
    await releaseProgress(proxy);
    await releaseProgress(proxy, { ...identity, thread_id: "other", agent_name: "/root/other" });
    const input = [mailboxProgress("other-first", "/root/other"), mailboxProgress("worker-first"),
      mailboxProgress("worker-second"), mailboxProgress("other-second", "/root/other")];
    expect((await inferenceRequest(proxy, parentIdentity, JSON.stringify({ input }))).status).toBe(200);
    expect(forwarded[0].input.map(item => item.content[0].text.split("Payload:\n")[1])).toEqual(["First", "First", "Second", "Second"]);
  } finally { proxy.stop(); }
});

test("unrelated encrypted messages and plain final reports retain the original parent bytes", async () => {
  const forwarded = [];
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 100]]), progressMessages: [{ atMs: 0, text: "Progress" }],
    forward: async (_, options) => { forwarded.push(new TextDecoder().decode(options.body)); return new Response("parent"); } });
  try {
    await releaseProgress(proxy, identity, 1);
    const final = { ...mailboxProgress("final"), content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\nFinal report" }] };
    const unrelated = { ...mailboxProgress("unrelated"), content: [{ type: "encrypted_content", encrypted_content: "unrelated" }] };
    const body = JSON.stringify({ input: [mailboxProgress("unknown", "/root/uncontrolled"), final, unrelated] }, null, 2);
    expect((await inferenceRequest(proxy, parentIdentity, body)).status).toBe(200);
    expect(forwarded).toEqual([body]);
  } finally { proxy.stop(); }
});

test.each(["unreleased", "excess", "recipient", "header", "id", "ciphertext", "content", "duplicate", "changed-worker"])("%s synthetic progress fails before upstream forwarding", async kind => {
  let forwarded = 0;
  let pending;
  const proxy = createWorkerProxy({ workerDelays: new Map([["worker", 2000]]), progressMessages: [{ atMs: kind === "unreleased" ? 1000 : 0, text: "Progress" }],
    forward: async () => { forwarded++; return new Response("parent"); } });
  try {
    if (kind === "unreleased") {
      pending = await inferenceRequest(proxy, identity, workerBody([]));
    } else await releaseProgress(proxy, identity, 1);
    let message = mailboxProgress("amsg");
    if (kind === "recipient") message.recipient = "/root/other";
    if (kind === "header") message.content[0].text = message.content[0].text.replace("Sender: /root/worker", "Sender: /root/impostor");
    if (kind === "id") delete message.id;
    if (kind === "ciphertext") message.content[1].encrypted_content = "";
    if (kind === "content") message.content.push({ type: "input_text", text: "extra" });
    let input = [message];
    if (kind === "excess") input.push(mailboxProgress("amsg-extra"));
    if (kind === "duplicate") input.push(message);
    if (kind === "changed-worker") {
      await inferenceRequest(proxy, parentIdentity, JSON.stringify({ input }));
      forwarded = 0;
      input = [mailboxProgress("amsg", "/root/uncontrolled")];
    }
    const response = await inferenceRequest(proxy, parentIdentity, JSON.stringify({ input }));
    expect(response.status).toBe(400);
    expect(forwarded).toBe(0);
  } finally { await pending?.body.cancel(); proxy.stop(); }
});
