export function analyzeWaitTrace(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Expected parent rollout rows");
  const agents = new Map();
  const calls = new Map();
  const spawns = [];
  const waits = [];
  const issues = [];
  let activityStarted = 0;
  let activityCompleted = 0;
  let finalAnswers = 0;
  let unsupported = false;
  const canonical = (name) => typeof name === "string" && name ? (name.startsWith("/") ? name : `/root/${name}`) : null;
  const issue = (message) => { issues.push(message); };
  const parse = (value, label) => {
    try { return typeof value === "string" ? JSON.parse(value) : value; }
    catch { issue(`Invalid JSON in ${label}`); return null; }
  };
  const agentFor = (name) => {
    const path = canonical(name);
    if (!path) return null;
    if (!agents.has(path)) agents.set(path, { path, state: "unknown", delivered: false, started: false });
    return agents.get(path);
  };

  for (const [index, row] of rows.entries()) {
    const payload = row?.payload;
    if (!payload) continue;
    const item = payload.item;
    if (row.type === "event_msg" && item?.type === "SubAgentActivity") {
      const agent = agentFor(item.agent_path);
      const messageInteraction = item.kind === "interacted" && calls.get(item.id)?.name === "send_message";
      if (!agent || !item.agent_thread_id || (!["started", "completed"].includes(item.kind) && !messageInteraction)) {
        unsupported = true;
        issue(`Unsupported SubAgentActivity at row ${index}`);
        continue;
      }
      if (agent.threadId && agent.threadId !== item.agent_thread_id) {
        unsupported = true;
        issue(`Agent thread changed for ${agent.path}`);
      }
      agent.threadId = item.agent_thread_id;
      if (messageInteraction) continue;
      if (item.kind === "started") {
        activityStarted++;
        agent.state = "active";
        agent.started = true;
        agent.delivered = false;
      } else {
        activityCompleted++;
        if (!agent.started) {
          issue(`Completion without started activity for ${agent.path}`);
          agent.state = "unknown";
        } else {
          agent.state = agent.delivered ? "complete" : "pending-result";
        }
      }
    }

    if (row.type !== "response_item") continue;
    if (payload.type === "agent_message") {
      const text = payload.content?.map((part) => part.text || "").join("\n") || "";
      if (text.startsWith("Message Type: FINAL_ANSWER")) {
        finalAnswers++;
        const agent = agentFor(payload.author);
        if (!agent) { unsupported = true; issue(`Final answer without author at row ${index}`); continue; }
        agent.delivered = true;
        if (agent.state === "pending-result") agent.state = "complete";
      }
      continue;
    }
    if (payload.type === "function_call" && payload.namespace === "collaboration") {
      const args = parse(payload.arguments, `${payload.name} arguments`) || {};
      if (!payload.call_id || calls.has(payload.call_id)) {
        unsupported = true;
        issue(`Missing or duplicate collaboration call_id at row ${index}`);
        continue;
      }
      const call = { callId: payload.call_id, name: payload.name, timestamp: row.timestamp, rowIndex: index, args, outputObserved: false };
      calls.set(call.callId, call);
      if (payload.name === "spawn_agent") {
        const agent = agentFor(args.task_name);
        if (!agent) { unsupported = true; issue(`Spawn without task_name at row ${index}`); }
        else { agent.state = "unknown"; agent.started = false; agent.delivered = false; }
        call.taskName = agent?.path || null;
        spawns.push(call);
      } else if (payload.name === "wait_agent") {
        const states = [...agents.values()];
        call.activeAgents = states.filter((agent) => agent.state === "active").map((agent) => agent.path);
        call.pendingResults = states.filter((agent) => agent.state === "pending-result").map((agent) => agent.path);
        call.unknownAgents = states.filter((agent) => agent.state === "unknown").map((agent) => agent.path);
        call.classification = unsupported || call.unknownAgents.length ? "unknown"
          : call.activeAgents.length ? "active" : call.pendingResults.length ? "pending-result" : "empty";
        call.completedAt = null;
        call.durationMs = null;
        call.timedOut = null;
        waits.push(call);
      } else if (["followup_task", "send_input", "resume_agent", "interrupt_agent", "close_agent"].includes(payload.name)) {
        const target = args.target || args.id || args.agent_id;
        const agent = [...agents.values()].find((entry) => entry.threadId === target) || agentFor(target);
        if (!agent) { unsupported = true; issue(`Work lifecycle call without target at row ${index}`); }
        else {
          agent.state = "unknown";
          agent.started = false;
          agent.delivered = false;
        }
      } else if (!["send_message", "list_agents"].includes(payload.name)) {
        unsupported = true;
        issue(`Unsupported collaboration tool ${payload.name}`);
      }
    }
    if (payload.type === "function_call_output" && calls.has(payload.call_id)) {
      const call = calls.get(payload.call_id);
      call.outputObserved = true;
      if (call.name === "wait_agent") {
        const output = parse(payload.output, "wait_agent output");
        call.completedAt = row.timestamp;
        const duration = Date.parse(row.timestamp) - Date.parse(call.timestamp);
        if (Number.isFinite(duration) && duration >= 0) call.durationMs = duration;
        else issue(`Invalid wait timestamps for ${call.callId}`);
        if (typeof output?.timed_out === "boolean") call.timedOut = output.timed_out;
        else issue(`Missing timed_out for ${call.callId}`);
      }
    }
  }
  for (const spawn of spawns) {
    if (!spawn.outputObserved) issue(`Missing spawn output for ${spawn.callId}`);
    if (!agents.get(spawn.taskName)?.threadId) issue(`Missing started activity for ${spawn.taskName}`);
  }
  for (const wait of waits) if (!wait.outputObserved) issue(`Missing wait output for ${wait.callId}`);
  const unknownWaits = waits.filter((wait) => wait.classification === "unknown");
  const shortWaitRetries = waits.filter((wait, index) => {
    const previous = waits[index - 1];
    if (!previous || previous.timedOut !== true || previous.classification !== "active" || wait.classification !== "active" ||
      !Number.isFinite(previous.args.timeout_ms) || !Number.isFinite(wait.args.timeout_ms) ||
      previous.args.timeout_ms > 10000 || wait.args.timeout_ms > 10000 ||
      previous.args.timeout_ms <= 0 || wait.args.timeout_ms <= 0 ||
      JSON.stringify(previous.activeAgents) !== JSON.stringify(wait.activeAgents)) return false;
    return !rows.slice(previous.rowIndex + 1, wait.rowIndex).some((row) => {
      const payload = row?.payload;
      return row.type === "response_item" && (
        payload?.type === "agent_message" || payload?.role === "user" ||
        payload?.type === "custom_tool_call" ||
        (payload?.type === "function_call" && (payload.namespace !== "collaboration" ||
          !["wait_agent", "send_message", "list_agents"].includes(payload.name)))
      ) || row.type === "event_msg" && payload?.item?.type === "SubAgentActivity" &&
        ["started", "completed"].includes(payload.item.kind);
    });
  });
  return {
    spawns, waits, shortWaitRetries, emptyWaits: waits.filter((wait) => wait.classification === "empty"),
    coverage: { activityStarted, activityCompleted, finalAnswers, unknownWaits: unknownWaits.length, issues, complete: !issues.length && !unknownWaits.length },
  };
}
