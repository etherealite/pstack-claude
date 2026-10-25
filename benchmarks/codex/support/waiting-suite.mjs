import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { analyzeWaitTrace, assessWaits } from "../../../tools/codex/lib/wait-trace.mjs";
import { analyzeSkillExposure, catalogSkillFiles, formatSkillExposure } from "../../../tools/codex/lib/skill-exposure.mjs";
import { formatWaitingReport } from "./waiting-report.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const model = process.env.PSTACK_CODEX_LIVE_MODEL || "gpt-6.1-sol";
const effort = process.env.PSTACK_CODEX_WAIT_EFFORT || "low";
const panel = [
  { model: "gpt-6.1-sol", effort: "xhigh" },
  { model: "gpt-6-astra", effort: "medium" },
  { model: "gpt-6-luna", effort: "max" },
];
const reviewerSettings = panel.map(({ model, effort }) => `${model} @${effort}`).join(", ");
const task = [
  "Please organize an independent three-person mathematical review of these two claims, then give me your consolidated verdict with proofs or counterexamples and corrected exact counts where needed.",
  "Claim A. Among the integers from 1 through 10^12, exactly 132057411984 are divisible by exactly three of the primes 2, 3, 5, 7, 11, 13, 17, 19, 23, 29.",
  "Claim B. The number of binary strings of length 100 with exactly 30 ones and no adjacent ones, including across the boundary from position 100 back to position 1, is binomial(71,30) = 95846086442150951368. Positions are labeled; rotations are distinct.",
  "Launch all three reviewers before synthesizing their findings. Each independently reviews BOTH claims and must not delegate further. Use these reviewer model and reasoning-effort pairs: " + reviewerSettings + ".",
  "As findings arrive, consolidate agreements and investigate disagreements. Your final verdict needs all three reviewers' results. Mathematical correctness is the scope; no repository or external sources are needed.",
].join("\n");

export function assertExpectedNumberSmokeCheck(answer) {
  const normalized = answer.replaceAll("\\,", "").replaceAll(",", "");
  expect(normalized).toMatch(/\b132057411984\b/);
  expect(normalized).toMatch(/\b79068200083062153040\b/);
}

export function defineWaitingTests({ withSession, workerMode, control = false, mailboxCondition = "silent" }) {
  const condition = control ? "without-pstack" : "current-pstack";
  test(condition, async () => {
    const report = mkdtempSync(join(tmpdir(), "pstack-review-results-"));
    const trial = { block: randomUUID(), condition, model, effort, panel, workerMode, mailboxCondition,
      taskSha256: createHash("sha256").update(task).digest("hex"), valid: false };
    console.log(`Review benchmark artifacts: ${report}`);
    try {
      await withSession(async runtime => {
        const { root, work, home, install, exec, session } = runtime;
        trial.artifacts = root;
        trial.workerControl = runtime.workerControl;
        trial.initialWorkspaceFiles = readdirSync(work);
        expect(trial.initialWorkspaceFiles).toEqual([]);
        const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
        const diff = spawnSync("git", ["diff", "HEAD", "--", "plugins/pstack", ".agents/plugins/marketplace.json"], { cwd: repo, encoding: "utf8" });
        expect(revision.status).toBe(0);
        expect(diff.status).toBe(0);
        trial.sourceRevision = revision.stdout.trim();
        writeFileSync(join(root, "plugin-source.diff"), diff.stdout);
        let prompt = task;
        let skillFiles = [];
        let body;
        if (!control) {
          writeFileSync(join(home, "pstack-models.md"), [
            `interrogate reviewers: ${reviewerSettings}`, `default effort: ${effort}`, "session hook: off", "",
          ].join("\n"));
          const installed = await install("pstack", repo);
          const skill = join(installed.installedPath, "skills/interrogate/SKILL.md").replaceAll("\\", "/");
          const tools = join(installed.installedPath, "skills/poteto-mode/references/codex-tools.md");
          trial.skillSha256 = createHash("sha256").update(readFileSync(skill)).digest("hex");
          skillFiles = catalogSkillFiles(installed.installedPath);
          body = readFileSync(tools, "utf8");
          prompt = ["$pstack:interrogate", `Use the installed workflow at ${JSON.stringify(skill)} for this mathematical review.`, task].join("\n");
        }
        writeFileSync(join(root, "prompt.txt"), prompt);
        const output = await exec(prompt, { multiAgent: true, timeout: 480_000, model, effort });
        const events = output.trim().split(/\r?\n/).map(JSON.parse);
        const thread = events.find(event => event.type === "thread.started")?.thread_id;
        const trace = session(thread);
        const exposure = { trace: trace.path, ...analyzeSkillExposure(trace.rows, skillFiles) };
        const inventory = join(root, "skill-exposure.json");
        writeFileSync(inventory, JSON.stringify(exposure, null, 2));
        writeFileSync(join(root, "skill-exposure.md"), formatSkillExposure(exposure));
        trial.skillExposure = { report: inventory, observedFiles: exposure.files.filter(file => file.exposures.length).map(file => file.path) };
        const result = analyzeWaitTrace(trace.rows);
        const activity = trace.rows.filter(row => row.type === "event_msg" && row.payload?.item?.type === "SubAgentActivity");
        const starts = activity.filter(row => row.payload.item.kind === "started");
        trial.thread = thread;
        trial.trace = trace.path;
        trial.facts = result;
        trial.expectations = result.waits.map(wait => ({ callId: wait.callId,
          requiredAgents: starts.map(start => start.payload.item.agent_path) }));
        trial.assessment = assessWaits(result, trial.expectations);
        expect(events.some(event => event.type === "turn.completed")).toBe(true);
        expect(result.coverage.complete, JSON.stringify(result.coverage)).toBe(true);
        expect(result.spawns).toHaveLength(3);
        expect(starts).toHaveLength(3);
        expect(result.coverage.activityCompleted).toBe(3);
        trial.workers = starts.map(start => {
          const item = start.payload.item;
          const completed = activity.find(row => row.payload.item.kind === "completed" && row.payload.item.agent_thread_id === item.agent_thread_id);
          const worker = session(item.agent_thread_id);
          return {
            path: item.agent_path, trace: worker.path,
            startedAt: start.timestamp, completedAt: completed?.timestamp,
            durationMs: Date.parse(completed?.timestamp) - Date.parse(start.timestamp),
            contexts: worker.rows.filter(row => row.type === "turn_context")
              .map(row => ({ model: row.payload.model, effort: row.payload.effort ?? row.payload.reasoning_effort })),
            messageObserved: trace.rows.some(row => row.payload?.type === "agent_message" && row.payload.author === item.agent_path),
            ordinaryMessages: result.messages.filter(message => message.author === item.agent_path && message.kind === "ordinary_message").length,
            finalAnswerObserved: result.messages.some(message => message.author === item.agent_path && message.kind === "final"),
            spawnedMore: worker.rows.some(row => row.payload?.namespace === "collaboration" && row.payload.name === "spawn_agent"),
          };
        });
        for (const worker of trial.workers) {
          expect(Number.isFinite(worker.durationMs)).toBe(true);
          expect(worker.messageObserved).toBe(true);
          if (workerMode === "controlled") expect(worker.finalAnswerObserved).toBe(true);
          if (mailboxCondition === "ordinary-message") {
            expect(worker.ordinaryMessages).toBe(runtime.workerControl.progressMessages.length);
          }
          expect(worker.spawnedMore).toBe(false);
          expect(worker.contexts.length).toBeGreaterThan(0);
          expect(worker.contexts.every(context => context.model === worker.contexts[0].model && context.effort === worker.contexts[0].effort)).toBe(true);
        }
        const observedPanel = trial.workers.map(worker => `${worker.contexts[0].model} @${worker.contexts[0].effort}`).sort();
        expect(observedPanel).toEqual(panel.map(({ model, effort }) => `${model} @${effort}`).sort());
        trial.workerOverlapMs = Math.min(...trial.workers.map(worker => Date.parse(worker.completedAt))) -
          Math.max(...trial.workers.map(worker => Date.parse(worker.startedAt)));
        expect(trial.workerOverlapMs).toBeGreaterThan(0);
        const final = readFileSync(join(root, "exec.final.txt"), "utf8");
        assertExpectedNumberSmokeCheck(final);
        trial.expectedNumberSmokeCheck = "passed";

        if (!control) {
          trial.mappingSha256 = createHash("sha256").update(body).digest("hex");
          writeFileSync(join(root, "codex-tools.md"), body);
          trial.pstackActivated = trace.rows.some(row => row.type === "response_item" && row.payload?.role === "user" &&
            row.payload.content?.some(part => part.text?.includes("<name>pstack:interrogate</name>")));
          const assignedMapping = body.split("\n").find(line => line.startsWith("| Wait for a subagent result |")).trimEnd();
          const firstSpawn = trace.rows.findIndex(row => row.payload?.namespace === "collaboration" && row.payload.name === "spawn_agent");
          const firstWait = trace.rows.findIndex(row => row.payload?.namespace === "collaboration" && row.payload.name === "wait_agent");
          trial.mappingExposure = trace.rows.flatMap((row, index) => row.type === "response_item" &&
            ["function_call_output", "custom_tool_call_output"].includes(row.payload?.type) &&
            JSON.stringify(row.payload.output).includes(assignedMapping)
            ? [{ callId: row.payload.call_id, timestamp: row.timestamp, beforeDelegation: index < firstSpawn,
              beforeFirstWait: firstWait < 0 ? null : index < firstWait }] : []);
          expect(trial.pstackActivated).toBe(true);
          expect(trial.mappingExposure.some(exposure => exposure.beforeDelegation), "The parent must receive the assigned wait mapping before delegating").toBe(true);
        }
        trial.valid = true;
      }, { prefix: "claim-notes-", env: { ...process.env, PSTACK_CODEX_LIVE_KEEP: "1" } });
    } catch (error) {
      trial.valid = false;
      trial.error = String(error);
      throw error;
    } finally {
      writeFileSync(join(report, "run.json"), JSON.stringify({ complete: trial.valid, observation: trial }, null, 2));
      writeFileSync(join(report, `${condition}.json`), JSON.stringify(trial, null, 2));
      const summary = formatWaitingReport(trial);
      writeFileSync(join(report, `${condition}.txt`), summary + "\n");
      console.log(summary);
    }
  }, 540_000);
}
