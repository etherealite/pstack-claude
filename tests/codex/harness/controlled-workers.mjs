import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withCodex } from "./harness.mjs";

const delays = new Map([["gpt-6.1-sol", 74538], ["gpt-6-astra", 56257], ["gpt-6-luna", 60591]]);
const report = [
  "Claim A is correct: 132057411984.",
  "Let S_j sum floor(10^12/product(T)) over j-element subsets T of the listed primes. The exact-three count is sum from j=3 to 10 of (-1)^(j-3) binomial(j,3) S_j.",
  "An integer divisible by r listed primes contributes binomial(r,3)(1-1)^(r-3), hence one exactly when r=3. Integers with r<3 contribute zero.",
  "The S_j values for j=3..10 are 317975702781, 63550859786, 8020984512, 652913384, 34101713, 1100804, 19934, 154. Exact evaluation gives 132057411984.",
  "Claim B is false. Its corrected count is 79068200083062153040.",
  "Condition on position 1: zero gives binomial(70,30)=55347740058143507128; one forces positions 2 and 100 to zero and gives binomial(69,29)=23720460024918645912. Add these disjoint cases.",
  "The claimed binomial(71,30) counts linear strings, including binomial(69,28)=16777886359088798328 invalid strings with both endpoints one. Rotations are distinct, so no rotational division applies.",
  "Both claims have been checked. There are no other findings.",
].join("\n");

function messageCall(body, callId, text) {
  const groups = [...(body.tools || []), ...(body.input || []).filter(item => item.type === "additional_tools").flatMap(item => item.tools || [])];
  const tools = groups.filter(group => group.type === "namespace" && group.name === "collaboration")
    .flatMap(group => group.tools || []).filter(tool => tool.type === "function" && tool.name === "send_message");
  const schema = tools[0]?.parameters;
  if (tools.length !== 1 || schema?.type !== "object" ||
    schema.properties?.target?.type !== "string" || schema.properties?.message?.type !== "string" ||
    !["target", "message"].every(key => schema.required?.includes(key)) ||
    schema.required.some(key => !["target", "message"].includes(key))) throw new Error("Unsupported advertised collaboration.send_message schema");
  return { id: `fc_${randomUUID()}`, type: "function_call", namespace: "collaboration", name: "send_message",
    call_id: callId, arguments: JSON.stringify({ target: "/root", message: text }), status: "completed" };
}

export function createWorkerProxy({ workerDelays = delays, progressMessages = [], forward = fetch, onChange = () => {} } = {}) {
  const schedule = progressMessages.map(item => ({ ...item }));
  if (schedule.length > 8 || schedule.some((item, index) => !Number.isFinite(item.atMs) || item.atMs < 0 ||
    typeof item.text !== "string" || !item.text.trim() || (index > 0 && item.atMs <= schedule[index - 1].atMs) ||
    [...workerDelays.values()].some(delay => !Number.isFinite(delay) || delay <= item.atMs))) throw new Error("Invalid progress schedule");
  const workers = new Map();
  const observations = [];
  const pending = new Set();
  const control = {
    delays: Object.fromEntries(workerDelays), progressMessages: schedule, observations,
    get workers() { return [...workers.values()].map(({ acknowledged, messageIds, ...worker }) => ({ ...worker, acknowledgedCalls: [...acknowledged], messageIds: [...messageIds] })); },
    get workerCount() { return workers.size; },
    get parentRequests() { return observations.filter(item => item.path === "/responses" && item.route === "upstream").length; },
    get workerRequests() { return observations.filter(item => item.route === "scripted").length; },
    get workerUpstreamRequests() { return observations.filter(item => item.path === "/responses" && item.route === "upstream" && item.source === "subagent").length; },
  };

  function workerResponse(observation, worker, item, deadline) {
    const id = `resp_${randomUUID()}`;
    let stop;
    const stream = new ReadableStream({
      start(controller) {
        const send = event => controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        send({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
        const heartbeat = setInterval(() => {
          try { controller.enqueue(new TextEncoder().encode(": waiting\n\n")); }
          catch (error) { stop(error); }
        }, 10000);
        const release = setTimeout(() => {
          try {
            const functionCall = item.type === "function_call";
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(functionCall ? { arguments: "" } : { content: [] }) } });
            if (functionCall) {
              send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
              send({ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments });
            } else {
              send({ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              send({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: report });
            }
            send({ type: "response.output_item.done", output_index: 0, item });
            send({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
            worker.phase = functionCall ? "awaiting-tool-result" : "finished";
            observation.releasedAt = new Date().toISOString();
            if (functionCall) worker.releasedMessages++;
            controller.close();
            stop();
          } catch (error) { stop(error); }
        }, Math.max(0, deadline - Date.now()));
        stop = error => {
          clearInterval(heartbeat);
          clearTimeout(release);
          pending.delete(stop);
          if (error) { observation.error = String(error); worker.phase = "failed"; }
          onChange(control);
        };
        pending.add(stop);
      },
      cancel(reason) { stop(reason || "Worker response cancelled"); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/(?:backend-api\/codex|backend-api|v1|codex)(?=\/|$)/, "");
    if (!["/responses", "/models"].includes(path)) return new Response("Unsupported route", { status: 404 });
    let metadata;
    try { metadata = JSON.parse(request.headers.get("x-codex-turn-metadata") || "{}"); }
    catch { return new Response("Invalid metadata", { status: 400 }); }
    let body = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const observation = { path, agent: metadata.agent_name, thread: metadata.thread_id,
      model: metadata.model, source: metadata.thread_source, startedAt: new Date().toISOString() };
    observations.push(observation);
    function reject(message) {
      observation.error = message;
      onChange(control);
      return new Response(message, { status: 400 });
    }
    if (path === "/responses" && metadata.thread_source === "subagent") {
      try {
        const input = JSON.parse(new TextDecoder().decode(body));
        let worker = workers.get(metadata.thread_id);
        if (!worker) {
          if (!workerDelays.has(metadata.model) || !metadata.thread_id || !metadata.agent_name?.startsWith("/root/") || workers.size >= 3 ||
            [...workers.values()].some(existing => existing.agent === metadata.agent_name) ||
            (input.input || []).some(item => item.type === "function_call_output")) throw new Error("Unexpected worker request");
          worker = { thread: metadata.thread_id, agent: metadata.agent_name, model: metadata.model, startedAtMs: Date.now(),
            nextMessage: 0, releasedMessages: 0, messageIds: new Map(), acknowledged: new Set(), phase: "streaming" };
          workers.set(worker.thread, worker);
        } else {
          if (worker.model !== metadata.model || worker.agent !== metadata.agent_name || worker.phase !== "awaiting-tool-result") throw new Error("Unexpected worker continuation");
          const outputs = (input.input || []).filter(item => item.type === "function_call_output");
          const fresh = outputs.filter(item => !worker.acknowledged.has(item.call_id));
          if (fresh.length !== 1 || fresh[0].call_id !== worker.callId || fresh[0].output !== "") throw new Error("Expected exactly one successful send_message acknowledgment");
          if (new Set(outputs.map(item => item.call_id)).size !== outputs.length) throw new Error("Duplicate acknowledgment");
          worker.acknowledged.add(worker.callId);
          worker.phase = "streaming";
        }
        const progress = schedule[worker.nextMessage];
        const callId = `call_${randomUUID()}`;
        const item = progress ? messageCall(input, callId, progress.text) : {
          id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: report, annotations: [] }],
        };
        const delay = progress?.atMs ?? workerDelays.get(worker.model);
        if (progress) { worker.nextMessage++; worker.callId = callId; }
        observation.route = "scripted";
        observation.kind = progress ? "progress" : "final";
        observation.delayMs = delay;
        observation.scheduledAt = new Date(worker.startedAtMs + delay).toISOString();
        onChange(control);
        return workerResponse(observation, worker, item, worker.startedAtMs + delay);
      } catch (error) {
        return reject(error.message);
      }
    }
    if (path === "/responses" && (metadata.agent_name !== "/root" || metadata.thread_source !== "user" || control.parentRequests >= 30)) {
      return reject("Only root inference is allowed upstream, within the request budget");
    }
    if (path === "/responses" && schedule.length && workers.size) {
      try {
        const input = JSON.parse(new TextDecoder().decode(body));
        const bindings = new Map();
        const hydrated = [];
        const seen = new Set();
        for (const message of input.input || []) {
          if (message.type !== "agent_message") continue;
          const owner = [...workers.values()].find(item => item.messageIds.has(message.id));
          if (owner && owner.agent !== message.author) throw new Error("Synthetic progress ID changed worker");
          const worker = [...workers.values()].find(item => item.agent === message.author);
          if (!worker) continue;
          const known = worker.messageIds.has(message.id);
          const header = message.content?.[0];
          if (!known && !header?.text?.startsWith("Message Type: MESSAGE")) continue;
          const prefix = `Message Type: MESSAGE\nTask name: /root\nSender: ${worker.agent}\nPayload:\n`;
          if (typeof message.id !== "string" || !message.id || message.recipient !== "/root" ||
            message.content?.length !== 2 || header.type !== "input_text" || header.text !== prefix ||
            message.content[1].type !== "encrypted_content" || typeof message.content[1].encrypted_content !== "string" || !message.content[1].encrypted_content) {
            throw new Error("Unsupported synthetic progress envelope");
          }
          if (seen.has(message.id)) throw new Error("Duplicate synthetic progress ID");
          seen.add(message.id);
          let ids = bindings.get(worker);
          if (!ids) { ids = new Map(worker.messageIds); bindings.set(worker, ids); }
          if (!ids.has(message.id)) {
            if (ids.size >= worker.releasedMessages) throw new Error("Synthetic progress exceeds released schedule");
            if ([...workers.values()].some(other => other !== worker && (bindings.get(other) || other.messageIds).has(message.id))) throw new Error("Synthetic progress ID changed worker");
            ids.set(message.id, ids.size);
          }
          const scheduleIndex = ids.get(message.id);
          message.content = [{ type: "input_text", text: prefix + schedule[scheduleIndex].text }];
          hydrated.push({ id: message.id, worker: worker.agent, kind: "progress", scheduleIndex });
        }
        if (hydrated.length) {
          for (const [worker, ids] of bindings) worker.messageIds = ids;
          observation.hydratedMessages = hydrated;
          body = new TextEncoder().encode(JSON.stringify(input));
        }
      } catch (error) { return reject(error.message); }
    }
    observation.route = "upstream";
    const headers = new Headers(request.headers);
    for (const name of ["host", "content-length", "connection", "accept-encoding"]) headers.delete(name);
    try {
      const upstream = await forward(`https://chatgpt.com/backend-api/codex${path}${url.search}`, {
        method: request.method, headers, body, redirect: "error",
      });
      observation.status = upstream.status;
      const responseHeaders = new Headers(upstream.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) responseHeaders.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      observation.error = String(error);
      return new Response("Upstream transport failed", { status: 502 });
    } finally { onChange(control); }
  } });

  return {
    url: `http://127.0.0.1:${server.port}`, control,
    stop() {
      for (const cancel of pending) cancel("Proxy stopped before worker completion");
      server.stop(true);
    },
  };
}

export function assertControlledWorkers(control) {
  assert.equal(control.workerUpstreamRequests, 0, "Workers must never invoke upstream inference");
  assert.equal(control.workerCount, 3, "All three workers must be scripted");
  assert.equal(control.workerRequests, 3 * (control.progressMessages.length + 1), "Every scheduled worker response must be scripted");
  assert.ok(control.workers.every(worker => worker.phase === "finished" && worker.acknowledgedCalls.length === control.progressMessages.length), "Every worker must acknowledge progress and finish");
  assert.ok(control.parentRequests > 0, "Parent inference must remain real");
  assert.ok(control.observations.every(item => !item.error), "Proxy requests must complete without errors");
  assert.ok(control.observations.filter(item => item.route === "scripted").every(item => item.releasedAt), "Every worker must finish its scheduled response");
  assert.ok(control.observations.filter(item => item.path === "/responses" && item.route === "upstream").every(item => item.status === 200), "Parent inference must succeed upstream");
}

export function withControlledCodex(callback, { progressMessages = [], ...options } = {}) {
  return withCodex(async runtime => {
    const evidence = join(runtime.root, "controlled-workers.json");
    const proxy = createWorkerProxy({ progressMessages, onChange: control => writeFileSync(evidence, JSON.stringify(control, null, 2)) });
    writeFileSync(join(runtime.home, "config.toml"), [
      'model_provider = "forwarding"', `chatgpt_base_url = "${proxy.url}/backend-api"`,
      '[model_providers.forwarding]', 'name = "Local forwarding"', `base_url = "${proxy.url}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0', '',
    ].join("\n"));
    try {
      return await callback({ ...runtime, workerControl: proxy.control, async exec(...args) {
        const output = await runtime.exec(...args);
        assertControlledWorkers(proxy.control);
        return output;
      } });
    } finally {
      proxy.stop();
      writeFileSync(evidence, JSON.stringify(proxy.control, null, 2));
    }
  }, options);
}
