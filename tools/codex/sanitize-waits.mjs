import { readFileSync, writeFileSync } from "node:fs";

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const tokenKeys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];

export function sanitizeWaitTrace(source, observations = []) {
  const calls = new Map(source.filter(row => ["function_call", "custom_tool_call"].includes(row.payload?.type))
    .map(row => [row.payload.call_id, row.payload]));
  const rows = source.flatMap(row => {
    const p = row.payload;
    let payload;
    if (row.type === "session_meta") payload = pick(p, ["id", "cli_version"]);
    else if (row.type === "turn_context") payload = pick(p, ["turn_id", "model", "effort", "reasoning_effort"]);
    else if (row.type === "token_usage_record") {
      payload = pick(p, ["thread_id", "turn_id", "session_id", "root_turn_id", "response_id"]);
      for (const key of ["usage", "turn_token_usage", "thread_token_usage"]) if (p[key]) payload[key] = pick(p[key], tokenKeys);
    } else if (row.type === "event_msg") {
      if (["task_started", "task_complete", "turn_aborted"].includes(p.type)) payload = pick(p, ["type", "turn_id"]);
      else if (p.item?.type === "SubAgentActivity") payload = {
        type: p.type, item: pick(p.item, ["type", "id", "kind", "agent_thread_id", "agent_path", "model", "reasoning_effort"]),
      };
      else if (p.type === "token_count" && p.info) payload = { type: p.type, info: {
        total_token_usage: pick(p.info.total_token_usage, tokenKeys),
        last_token_usage: pick(p.info.last_token_usage, tokenKeys),
      } };
    } else if (row.type === "response_item") {
      if (p.type === "function_call") {
        const args = p.namespace === "collaboration" ? pick(JSON.parse(p.arguments), ["task_name", "target", "id", "agent_id", "model", "reasoning_effort", "fork_turns", "timeout_ms"]) : {};
        payload = { ...pick(p, ["type", "namespace", "name", "call_id", "id"]), arguments: JSON.stringify(args) };
      } else if (p.type === "custom_tool_call") payload = {
        ...pick(p, ["type", "namespace", "name", "call_id", "id"]), input: "[Input omitted]",
      };
      else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) payload = {
        ...pick(p, ["type", "call_id"]),
        output: calls.get(p.call_id)?.namespace === "collaboration"
          ? JSON.stringify(pick(JSON.parse(p.output), ["timed_out", "task_name", "agent_id", "id", "status"])) : "[Output omitted]",
      };
      else if (p.type === "agent_message") {
        const text = p.content?.map(part => part.text || "").join("\n") || "";
        const kind = text.startsWith("Message Type: FINAL_ANSWER") ? "FINAL_ANSWER" : "MESSAGE";
        payload = { ...pick(p, ["type", "author", "recipient"]), content: [{ type: "input_text", text: `Message Type: ${kind}\nPayload:\n[Report omitted]` }] };
      } else if (p.type === "message") payload = {
        ...pick(p, ["type", "id", "role", "phase"]), content: [{ type: "input_text", text: "[Message omitted]" }],
      };
      else if (p.type === "reasoning") payload = pick(p, ["type", "id"]);
    }
    return payload ? [{ timestamp: row.timestamp, type: row.type, payload }] : [];
  });
  const requests = observations.filter(item => item.path === "/responses" && item.source === "user" && item.route === "upstream")
    .map((item, index) => ({ timestamp: item.startedAt, type: "proxy_request", payload: {
      request_index: index, ...pick(item, ["agent", "thread", "model", "source", "route", "status"]),
    } }));
  const combined = [];
  let next = 0;
  for (const row of rows) {
    while (next < requests.length && requests[next].timestamp <= row.timestamp) combined.push(requests[next++]);
    combined.push(row);
  }
  return combined.concat(requests.slice(next));
}

if (import.meta.main) {
  const [source, proxy, destination] = process.argv.slice(2);
  if (!source || !proxy || !destination || process.argv.length !== 5) throw new Error("Usage: bun tools/codex/sanitize-waits.mjs <rollout.jsonl> <controlled-workers.json> <fixture.jsonl>");
  const rows = readFileSync(source, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const observations = JSON.parse(readFileSync(proxy, "utf8")).observations;
  writeFileSync(destination, sanitizeWaitTrace(rows, observations).map(row => JSON.stringify(row)).join("\n") + "\n");
}
