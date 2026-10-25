export const MESSAGE_AFTER_RETURN_MS = 100;

export function analyzeWaitTrace(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Expected parent rollout rows");
  const agents = new Map();
  const calls = new Map();
  const spawns = [];
  const waits = [];
  const issues = [];
  const messages = [];
  let activityStarted = 0;
  let activityCompleted = 0;
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
    if (!agents.has(path)) agents.set(path, { path, lifecycle: "unknown", delivered: false });
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
        agent.lifecycle = "active";
        agent.delivered = false;
      } else {
        activityCompleted++;
        if (agent.lifecycle === "unknown") {
          issue(`Completion without started activity for ${agent.path}`);
        } else {
          agent.lifecycle = "completed";
        }
      }
    }

    if (row.type !== "response_item") continue;
    if (payload.type === "agent_message") {
      const text = payload.content?.map((part) => part.text || "").join("\n") || "";
      const kind = /^Message Type: FINAL_ANSWER(?:\r?\n|$)/.test(text) ? "final"
        : /^Message Type: MESSAGE(?:\r?\n|$)/.test(text) ? "ordinary_message" : null;
      const author = canonical(payload.author);
      if (kind === "final" && !author) {
        unsupported = true;
        issue(`Final answer without author at row ${index}`);
        continue;
      }
      if (kind && author?.startsWith("/root/") && payload.recipient === "/root") {
        messages.push({ rowIndex: index, timestamp: row.timestamp, author, kind });
        if (kind === "final") {
          const agent = agentFor(author);
          agent.delivered = true;
        }
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
      const call = { callId: payload.call_id, name: payload.name, timestamp: row.timestamp, rowIndex: index, outputObserved: false };
      calls.set(call.callId, call);
      if (payload.name === "spawn_agent") {
        const agent = agentFor(args.task_name);
        if (!agent) { unsupported = true; issue(`Spawn without task_name at row ${index}`); }
        else { agent.lifecycle = "unknown"; agent.delivered = false; }
        call.taskName = agent?.path || null;
        spawns.push(call);
      } else if (payload.name === "wait_agent") {
        const states = [...agents.values()];
        call.timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : null;
        call.activeAgents = states.filter((agent) => agent.lifecycle === "active").map((agent) => agent.path);
        call.pendingResults = states.filter((agent) => agent.lifecycle === "completed" && !agent.delivered).map((agent) => agent.path);
        call.unknownAgents = states.filter((agent) => agent.lifecycle === "unknown").map((agent) => agent.path);
        call.deliveredResults = states.filter((agent) => agent.delivered).map((agent) => agent.path);
        call.trackedWork = unsupported || call.unknownAgents.length ? "unknown"
          : call.activeAgents.length ? "active" : call.pendingResults.length ? "pending-result" : "no_outstanding_work_at_entry";
        call.completedAt = null;
        call.outputRowIndex = null;
        call.nearbyMessages = [];
        call.durationMs = null;
        call.timedOut = null;
        waits.push(call);
      } else if (["followup_task", "send_input", "resume_agent", "interrupt_agent", "close_agent"].includes(payload.name)) {
        const target = args.target || args.id || args.agent_id;
        const agent = [...agents.values()].find((entry) => entry.threadId === target) || agentFor(target);
        if (!agent) { unsupported = true; issue(`Work lifecycle call without target at row ${index}`); }
        else {
          agent.lifecycle = "unknown";
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
        call.outputRowIndex = index;
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
  const parentAction = row => row.type === "response_item" &&
    ["reasoning", "message", "function_call", "custom_tool_call"].includes(row.payload?.type) ||
    row.type === "event_msg" && row.payload?.type === "user_message";
  const ordered = (start, end) => {
    let previous = -Infinity;
    return rows.slice(start, end + 1).every(row => {
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < previous) return false;
      previous = timestamp;
      return true;
    });
  };
  for (const message of messages) {
    const openWaits = waits.filter(wait => wait.rowIndex < message.rowIndex &&
      (wait.outputRowIndex === null || message.rowIndex < wait.outputRowIndex));
    if (openWaits.length > 1) continue;
    const candidates = waits.filter(wait => {
      if (wait.outputRowIndex === null || wait.durationMs === null || message.rowIndex <= wait.rowIndex) return false;
      if (!ordered(wait.rowIndex, Math.max(wait.outputRowIndex, message.rowIndex))) return false;
      const delivered = Date.parse(message.timestamp);
      const started = Date.parse(wait.timestamp);
      const ended = Date.parse(wait.completedAt);
      if (!Number.isFinite(delivered) || delivered < started) return false;
      if (message.rowIndex < wait.outputRowIndex) return delivered <= ended;
      if (wait.timedOut !== false || delivered < ended || delivered - ended > MESSAGE_AFTER_RETURN_MS) return false;
      return !rows.slice(wait.outputRowIndex + 1, message.rowIndex).some(row =>
        parentAction(row) || !Number.isFinite(Date.parse(row.timestamp)) ||
        Date.parse(row.timestamp) < ended || Date.parse(row.timestamp) > delivered);
    });
    if (candidates.length !== 1) continue;
    const wait = candidates[0];
    const during = message.rowIndex < wait.outputRowIndex;
    wait.nearbyMessages.push({ ...message, timing: during ? "during-wait" : "after-return",
      lagMs: during ? null : Date.parse(message.timestamp) - Date.parse(wait.completedAt) });
  }
  const unknownWaits = waits.filter((wait) => wait.trackedWork === "unknown");
  const shortTimeoutRewaits = waits.filter((wait, index) => {
    const previous = waits[index - 1];
    if (!previous || previous.timedOut !== true || previous.trackedWork !== "active" || wait.trackedWork !== "active" ||
      previous.outputRowIndex === null || previous.outputRowIndex >= wait.rowIndex || !ordered(previous.rowIndex, wait.rowIndex) ||
      !Number.isFinite(previous.timeoutMs) || !Number.isFinite(wait.timeoutMs) ||
      previous.timeoutMs > 10000 || wait.timeoutMs > 10000 ||
      previous.timeoutMs <= 0 || wait.timeoutMs <= 0 ||
      JSON.stringify(previous.activeAgents) !== JSON.stringify(wait.activeAgents)) return false;
    return !rows.slice(previous.rowIndex + 1, wait.rowIndex).some((row) => {
      const payload = row?.payload;
      return row.type === "response_item" && (
        payload?.role === "user" ||
        payload?.type === "custom_tool_call" ||
        (payload?.type === "function_call" && (payload.namespace !== "collaboration" ||
          !["wait_agent", "send_message", "list_agents"].includes(payload.name)))
      ) || row.type === "event_msg" && payload?.item?.type === "SubAgentActivity" &&
        ["started", "completed"].includes(payload.item.kind);
    });
  }).map(wait => {
    const previous = waits[waits.indexOf(wait) - 1];
    return { previousCallId: previous.callId, callId: wait.callId,
      interveningMessages: messages.filter(message => message.rowIndex > previous.rowIndex && message.rowIndex < wait.rowIndex) };
  });
  return {
    spawns, waits, messages, shortTimeoutRewaits, noOutstandingWorkWaits: waits.filter((wait) => wait.trackedWork === "no_outstanding_work_at_entry"),
    coverage: { activityStarted, activityCompleted, finalAnswers: messages.filter(message => message.kind === "final").length,
      ordinaryMessages: messages.filter(message => message.kind === "ordinary_message").length,
      unknownWaits: unknownWaits.length, issues, complete: !issues.length && !unknownWaits.length },
  };
}

export function assessWaits(facts, expectations) {
  if (!Array.isArray(expectations)) throw new TypeError("Expected an array of per-wait expectations");
  const waitsById = new Map(facts.waits.map(wait => [wait.callId, wait]));
  const selected = new Map();
  for (const entry of expectations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some(key => !["callId", "requiredAgents", "mailboxReceive", "independentWork"].includes(key)) ||
      typeof entry.callId !== "string" || !waitsById.has(entry.callId) || selected.has(entry.callId)) {
      throw new TypeError("Invalid, untracked, or duplicate expectation callId");
    }
    if (entry.requiredAgents !== undefined && (!Array.isArray(entry.requiredAgents) ||
      entry.requiredAgents.some(agent => typeof agent !== "string" || !agent.trim()) ||
      new Set(entry.requiredAgents).size !== entry.requiredAgents.length)) {
      throw new TypeError(`Invalid requiredAgents for ${entry.callId}`);
    }
    if (entry.mailboxReceive !== undefined && !["required", "not-required"].includes(entry.mailboxReceive) ||
      entry.independentWork !== undefined && !["available", "exhausted"].includes(entry.independentWork)) {
      throw new TypeError(`Invalid wait expectation for ${entry.callId}`);
    }
    selected.set(entry.callId, entry);
  }
  const waits = facts.waits.map(wait => {
    const entry = selected.get(wait.callId);
    const verdict = (status, reason) => ({ callId: wait.callId, status, reason });
    if (entry?.independentWork === "available") return verdict("fail", "Independent work was declared available");
    if (entry?.independentWork !== "exhausted") return verdict("unknown", "Independent work availability is undeclared");
    const required = entry.requiredAgents?.map(agent => agent.startsWith("/") ? agent : `/root/${agent}`);
    const outstanding = required?.some(agent => !wait.deliveredResults.includes(agent) &&
      (wait.activeAgents.includes(agent) || wait.pendingResults.includes(agent)));
    if (outstanding || entry.mailboxReceive === "required") return verdict("pass", "A required result or mailbox receive was outstanding");
    if (required && required.every(agent => wait.deliveredResults.includes(agent)) && entry.mailboxReceive === "not-required") {
      return verdict("fail", "All required results were delivered and no mailbox receive was required");
    }
    return verdict("unknown", "Result or mailbox requirements are undeclared or unobserved");
  });
  return { status: waits.some(wait => wait.status === "fail") ? "fail"
    : waits.some(wait => wait.status === "unknown") ? "unknown" : "pass", waits };
}
