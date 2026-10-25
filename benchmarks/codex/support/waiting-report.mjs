const count = value => value ?? "unknown";
const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : "unknown";

export function formatWaitingReport(trial) {
  const observations = trial.workerControl?.observations;
  const parentRequests = observations?.filter(item => item.route === "upstream" && item.path === "/responses" && item.agent === "/root").length;
  const lines = [
    "", `Waiting benchmark: ${trial.condition}`,
    `  Observation: ${trial.valid ? "VALID" : "INVALID / INCOMPLETE"} (behavior is measured, not a pass/fail gate)`,
    `  Parent: ${trial.model} @${trial.effort}; workers: ${trial.workerMode}`,
    `  Workers: ${count(trial.coverage?.activityCompleted)} completed; ${count(trial.coverage?.finalAnswers)} final answers delivered`,
    `  Waits: ${count(trial.waits?.length)} total; ${count(trial.timedOutWaits)} timed out`,
    `  Empty waits: ${count(trial.emptyWaits)}`,
    `  Short-wait retries: ${count(trial.shortWaitRetries)}`,
    `  Parent inference requests: ${count(parentRequests)} (all requests, not attributed waste)`,
    `  Worker overlap: ${seconds(trial.workerOverlapMs)}`,
  ];
  if (trial.waits?.length) {
    lines.push("  Wait details (requested / elapsed; active workers; pending results):");
    trial.waits.forEach((wait, index) => lines.push(
      `    ${index + 1}. ${seconds(wait.args?.timeout_ms)} / ${seconds(wait.durationMs)}; active=${count(wait.activeAgents?.length)}; pending=${count(wait.pendingResults?.length)}; ${wait.timedOut === true ? "timed out" : wait.outputObserved ? "returned" : "result missing"}; ${wait.classification}`,
    ));
  }
  if (trial.skillExposure) lines.push(`  Skill files with observed content: ${trial.skillExposure.observedFiles.length}; evidence: ${trial.skillExposure.report}`);
  if (trial.mappingExposure) lines.push(`  Wait mapping received before delegation: ${trial.mappingExposure.some(item => item.beforeDelegation) ? "yes" : "no"}`);
  if (trial.error) lines.push(`  Error: ${trial.error}`);
  return lines.join("\n");
}
