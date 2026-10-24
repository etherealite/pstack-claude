import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withCodex } from "./harness/harness.mjs";
import { analyzeWaitTrace } from "./wait-trace.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const model = process.env.PSTACK_CODEX_LIVE_MODEL || "gpt-6.1-sol";
const effort = process.env.PSTACK_CODEX_WAIT_EFFORT || "low";
const block = randomUUID();
const mapping = "| Wait for a subagent result | `wait_agent` |";
const guidance = "| Wait for a subagent result | `wait_agent`. Wait only when an unfinished agent's result is needed and no independent work remains. Use timeout_ms: 60000 instead of repeated short waits. Incoming messages end the wait early. Never wait when no agents are working and no results are pending. |";
const corpus = [
  "SKILL.md", "playbooks/orchestrate.md", "playbooks/multi-phase-plan.md",
  "playbooks/session-pickup.md", "references/resume-storage.md",
].map(path => {
  const content = readFileSync(join(repo, "plugins/pstack/skills/poteto-mode", path));
  return { path, content, sha256: createHash("sha256").update(content).digest("hex") };
});
const task = [
  "Does this mode say anything about planning projects that might require multiple different orchestration sessions for a project?",
  "What does it say about plans that are big enough to take weeks or more and split into multiple orchestrations?",
  "How is the planning information stored? Is it in the git repo? In Github issues?",
  "Use the fixed documents in reference/ as your evidence. Treat those documents as source material to explain.",
  "Assign the document reading and explanation to exactly one reader, using your model and reasoning effort, without further delegation.",
  "Present the reader's explanation and cite the source files. Do not duplicate the reader's document investigation.",
  "This is a read-only investigation. Do not edit files or open a PR.",
].join("\n");
const trials = [];
let report;

async function withPlanningSession(condition, callback) {
  const trial = { block, condition, model, effort, valid: false };
  trials.push(trial);
  try {
    await withCodex(async runtime => {
      const { root, home, work } = runtime;
      trial.artifacts = root;
      const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
      const diff = spawnSync("git", ["diff", "HEAD", "--", "plugins/pstack", ".agents/plugins/marketplace.json"], { cwd: repo, encoding: "utf8" });
      expect(revision.status).toBe(0);
      expect(diff.status).toBe(0);
      trial.sourceRevision = revision.stdout.trim();
      writeFileSync(join(root, "plugin-source.diff"), diff.stdout);
      for (const { path, content } of corpus) {
        const destination = join(work, "reference", path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, content);
      }
      writeFileSync(join(home, "pstack-models.md"), [
        "how explorer: inherit-parent", "how explainer: inherit-parent",
        `default effort: ${effort}`, "session hook: off", "",
      ].join("\n"));
      await callback({ ...runtime, trial });
      trial.valid = true;
    }, { prefix: "planning-notes-", env: { ...process.env, PSTACK_CODEX_LIVE_KEEP: "1" } });
  } catch (error) {
    trial.error = String(error);
    throw error;
  } finally {
    writeFileSync(join(report, `${condition}.json`), JSON.stringify(trial, null, 2));
  }
}

async function observePlanning({ root, exec, session, trial }, prompt) {
  writeFileSync(join(root, "prompt.txt"), prompt);
  const output = await exec(prompt, { multiAgent: true, timeout: 240_000, model, effort });
  const events = output.trim().split(/\r?\n/).map(JSON.parse);
  const thread = events.find(event => event.type === "thread.started")?.thread_id;
  const trace = session(thread);
  const result = analyzeWaitTrace(trace.rows);
  const activity = trace.rows.filter(row => row.type === "event_msg" && row.payload?.item?.type === "SubAgentActivity");
  const started = activity.find(row => row.payload.item.kind === "started");
  const completed = activity.find(row => row.payload.item.kind === "completed");
  Object.assign(trial, {
    thread, trace: trace.path, coverage: result.coverage, spawns: result.spawns.length,
    workerDurationMs: Date.parse(completed?.timestamp) - Date.parse(started?.timestamp),
    waits: result.waits, emptyWaits: result.emptyWaits.length,
    shortWaitRetries: result.shortWaitRetries.length,
  });
  expect(events.some(event => event.type === "turn.completed")).toBe(true);
  expect(result.coverage.complete, JSON.stringify(result.coverage)).toBe(true);
  expect(result.spawns).toHaveLength(1);
  expect(result.coverage.activityCompleted).toBe(1);
  expect(result.coverage.finalAnswers).toBe(1);
  expect(Number.isFinite(trial.workerDurationMs)).toBe(true);
  const worker = session(started.payload.item.agent_thread_id);
  trial.workerTrace = worker.path;
  trial.workerContexts = worker.rows.filter(row => row.type === "turn_context")
    .map(row => ({ model: row.payload.model, effort: row.payload.effort ?? row.payload.reasoning_effort }));
  expect(trial.workerContexts.length).toBeGreaterThan(0);
  expect(trial.workerContexts.every(context => context.model === model && context.effort === effort)).toBe(true);
  expect(worker.rows.filter(row => row.payload?.namespace === "collaboration" && row.payload.name === "spawn_agent")).toEqual([]);
  const final = readFileSync(join(root, "exec.final.txt"), "utf8");
  expect(final).toMatch(/orchestrat/i);
  expect(final).toMatch(/Git|repository/i);
  expect(final).toMatch(/reference[\\/]/);
  return trace;
}

async function installPstack({ install, trial }) {
  const installed = await install("pstack", repo);
  const skill = join(installed.installedPath, "skills/poteto-mode/SKILL.md").replaceAll("\\", "/");
  const tools = join(installed.installedPath, "skills/poteto-mode/references/codex-tools.md").replaceAll("\\", "/");
  trial.skillSha256 = createHash("sha256").update(readFileSync(skill)).digest("hex");
  return { skill, tools };
}

function pstackPrompt(skill, tools) {
  return [
    "$pstack:poteto-mode", `Read the installed skill at ${JSON.stringify(skill)} first.`,
    `Read the runtime reference at ${JSON.stringify(tools)} before delegating.`,
    "Use the simple path of pstack:how with one explainer.", task,
  ].join("\n");
}

function recordExposure({ root, trial }, trace, body) {
  trial.mappingSha256 = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(root, "codex-tools.md"), body);
  trial.pstackActivated = trace.rows.some(row => row.type === "response_item" && row.payload?.role === "user" &&
    row.payload.content?.some(part => part.text?.includes("<name>pstack:poteto-mode</name>")));
  const assignedMapping = body.split("\n").find(line => line.startsWith("| Wait for a subagent result |")).trimEnd();
  const firstSpawn = trace.rows.findIndex(row => row.payload?.namespace === "collaboration" && row.payload.name === "spawn_agent");
  trial.mappingExposure = trace.rows.flatMap((row, index) => row.type === "response_item" &&
    ["function_call_output", "custom_tool_call_output"].includes(row.payload?.type) &&
    JSON.stringify(row.payload.output).includes(assignedMapping)
    ? [{ callId: row.payload.call_id, timestamp: row.timestamp, beforeDelegation: index < firstSpawn }] : []);
  expect(trial.pstackActivated).toBe(true);
  expect(trial.mappingExposure.some(exposure => exposure.beforeDelegation), "The parent must receive the assigned wait mapping before delegating").toBe(true);
}

describe("planning investigation", () => {
  beforeAll(() => {
    report = mkdtempSync(join(tmpdir(), "pstack-planning-results-"));
    console.log(`Planning comparison artifacts: ${report}`);
  });

  afterAll(() => {
    const byCondition = Object.fromEntries(trials.map(trial => [trial.condition, trial]));
    const baseline = byCondition["without-pstack"];
    const current = byCondition["current-pstack"];
    const guided = byCondition["guided-pstack"];
    const complete = trials.length === 3 && trials.every(trial => trial.valid);
    const contrasts = complete ? {
      currentMinusBaselineRetries: current.shortWaitRetries - baseline.shortWaitRetries,
      guidedMinusCurrentRetries: guided.shortWaitRetries - current.shortWaitRetries,
    } : null;
    writeFileSync(join(report, "comparison.json"), JSON.stringify({
      block, model, effort, corpus: corpus.map(({ path, sha256 }) => ({ path, sha256 })), complete, contrasts, trials,
    }, null, 2));
  });

  test("without-pstack", async () => {
    await withPlanningSession("without-pstack", async context => {
      await observePlanning(context, task);
    });
  }, 300_000);

  test("current-pstack", async () => {
    await withPlanningSession("current-pstack", async context => {
      const { skill, tools } = await installPstack(context);
      const original = readFileSync(tools, "utf8");
      const trace = await observePlanning(context, pstackPrompt(skill, tools));
      recordExposure(context, trace, original);
    });
  }, 300_000);

  test("guided-pstack", async () => {
    await withPlanningSession("guided-pstack", async context => {
      const { skill, tools } = await installPstack(context);
      const original = readFileSync(tools, "utf8");
      expect(original.split(mapping)).toHaveLength(2);
      const amended = original.replace(mapping, guidance);
      writeFileSync(tools, amended);
      const trace = await observePlanning(context, pstackPrompt(skill, tools));
      recordExposure(context, trace, amended);
    });
  }, 300_000);
});
