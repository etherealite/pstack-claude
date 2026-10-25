const count = value => value ?? "unknown";
const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : "unknown";

export function formatWaitingReport(trial) {
  const facts = trial.facts;
  const parentRequests = trial.workerControl?.parentRequests;
  const lines = [
    "", `Waiting benchmark: ${trial.condition}`,
    `  Observation: ${trial.valid ? "VALID" : "INVALID / INCOMPLETE"} (behavior is measured, not a pass/fail gate)`,
    `  Parent: ${trial.model} @${trial.effort}; workers: ${trial.workerMode}`,
    `  Mailbox condition: ${trial.mailboxCondition ?? "silent"}`,
    `  Workers: ${count(facts?.coverage.activityCompleted)} completed; ${count(facts?.coverage.finalAnswers)} final answers delivered`,
    `  Ordinary messages delivered: ${count(facts?.coverage.ordinaryMessages)}`,
    `  Waits: ${count(facts?.waits.length)} total; ${count(facts?.waits.filter(wait => wait.timedOut === true).length)} recorded timeouts; ${count(facts?.waits.filter(wait => typeof wait.timedOut !== "boolean").length)} unknown timeout outcomes`,
    `  Waits with no outstanding tracked work at entry: ${count(facts?.noOutstandingWorkWaits.length)}`,
    `  Short-timeout rewaits: ${count(facts?.shortTimeoutRewaits.length)}`,
    `  Declared expectation assessment: ${trial.assessment?.status ?? "not selected"}`,
    `  Expected-number smoke check: ${trial.expectedNumberSmokeCheck ?? "unknown"}`,
    `  Parent inference requests: ${count(parentRequests)} (all requests, not attributed waste)`,
    `  Worker overlap: ${seconds(trial.workerOverlapMs)}`,
  ];
  if (facts?.waits.length) {
    lines.push("  Wait details (requested / elapsed; active workers; pending results):");
    facts.waits.forEach((wait, index) => lines.push(
      `    ${index + 1}. ${seconds(wait.timeoutMs)} / ${seconds(wait.durationMs)}; active=${count(wait.activeAgents?.length)}; pending=${count(wait.pendingResults?.length)}; ${wait.timedOut === true ? "timed out" : wait.outputObserved ? "returned" : "result missing"}; ${wait.trackedWork}; ${wait.nearbyMessages?.length
        ? wait.nearbyMessages.map(message => `${message.kind} from ${message.author} observed ${message.timing === "during-wait" ? "during wait" : `${message.lagMs} ms after return`}`).join("; ")
        : "no nearby message observed"}`,
    ));
  }
  if (trial.skillExposure) lines.push(`  Skill files with observed content: ${trial.skillExposure.observedFiles.length}; evidence: ${trial.skillExposure.report}`);
  if (trial.mappingExposure) lines.push(`  Wait mapping received before delegation: ${trial.mappingExposure.some(item => item.beforeDelegation) ? "yes" : "no"}`);
  if (trial.error) lines.push(`  Error: ${trial.error}`);
  return lines.join("\n");
}
