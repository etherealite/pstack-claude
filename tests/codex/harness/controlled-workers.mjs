import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

export function createWorkerProxy({ workerDelays = delays, forward = fetch, onChange = () => {} } = {}) {
  const observations = [];
  const pending = new Set();
  const control = {
    delays: Object.fromEntries(workerDelays), observations,
    get parentRequests() { return observations.filter(item => item.path === "/responses" && item.route === "upstream").length; },
    get workerRequests() { return observations.filter(item => item.route === "scripted").length; },
    get workerUpstreamRequests() { return observations.filter(item => item.path === "/responses" && item.route === "upstream" && item.source === "subagent").length; },
  };

  function workerResponse(observation, delay) {
    const id = `resp_${observation.thread}`;
    const item = { id: `msg_${observation.thread}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: report, annotations: [] }] };
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
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
            send({ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            send({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: report });
            send({ type: "response.output_item.done", output_index: 0, item });
            send({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
            controller.close();
            observation.releasedAt = new Date().toISOString();
            stop();
          } catch (error) { stop(error); }
        }, delay);
        stop = error => {
          clearInterval(heartbeat);
          clearTimeout(release);
          pending.delete(stop);
          if (error) observation.error = String(error);
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
    const metadata = JSON.parse(request.headers.get("x-codex-turn-metadata") || "{}");
    const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const observation = { path, agent: metadata.agent_name, thread: metadata.thread_id,
      model: metadata.model, source: metadata.thread_source, startedAt: new Date().toISOString() };
    observations.push(observation);
    function reject(message) {
      observation.error = message;
      onChange(control);
      return new Response(message, { status: 400 });
    }
    if (path === "/responses" && metadata.thread_source === "subagent") {
      const delay = workerDelays.get(metadata.model);
      if (delay === undefined || !metadata.thread_id || observations.some(item => item !== observation && item.route === "scripted" && item.thread === metadata.thread_id) || control.workerRequests >= 3) {
        return reject("Unexpected worker request");
      }
      observation.route = "scripted";
      observation.delayMs = delay;
      onChange(control);
      return workerResponse(observation, delay);
    }
    if (path === "/responses" && (metadata.agent_name !== "/root" || metadata.thread_source !== "user" || control.parentRequests >= 30)) {
      return reject("Only root inference is allowed upstream, within the request budget");
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
  assert.equal(control.workerRequests, 3, "All three worker responses must be scripted");
  assert.ok(control.parentRequests > 0, "Parent inference must remain real");
  assert.ok(control.observations.every(item => !item.error), "Proxy requests must complete without errors");
  assert.ok(control.observations.filter(item => item.route === "scripted").every(item => item.releasedAt), "Every worker must finish its scheduled response");
  assert.ok(control.observations.filter(item => item.path === "/responses" && item.route === "upstream").every(item => item.status === 200), "Parent inference must succeed upstream");
}

export function withControlledCodex(callback, options) {
  return withCodex(async runtime => {
    const evidence = join(runtime.root, "controlled-workers.json");
    const proxy = createWorkerProxy({ onChange: control => writeFileSync(evidence, JSON.stringify(control, null, 2)) });
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
