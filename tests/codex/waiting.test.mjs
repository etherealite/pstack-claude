import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withCodex } from "./harness/harness.mjs";
import { analyzeWaitTrace } from "./wait-trace.mjs";

const suite = process.env.PSTACK_CODEX_LIVE === "1" ? describe : describe.skip;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const scenarios = {
  "planning-investigation": {
    prompt: "Does this mode say anything about planning projects that might require multiple different orchestration sessions for a projec? What does it say about plans that are big enough to take weeks or more an split into multiple orchestrations? How is the planning information stored? Is it in the git repo? In Github issues?\n\nUse the simple path of the $pstack:how workflow. Assign the document reading and explanation to one explainer. The parent presents that explanation and should not duplicate the explainer's document investigation.",
    model: "gpt-6.1-sol", effort: "low",
  },
  "no-agents": {
    prompt: "Read alpha.txt yourself and report its release identifier and retry limit. Do this directly without delegating to subagents.",
    model: "gpt-6-luna", effort: "xhigh", expectedSpawns: 0,
  },
  "completed-agents": {
    prompt: "Delegate alpha.txt and beta.txt to exactly two readers, one file each. Each reader reports the release identifier and retry limit in its assigned file, without further delegation. While they read, independently calculate the sum of numbers.txt yourself using the shell. Collect both reports and the sum into one final answer.",
    model: "gpt-6-luna", effort: "xhigh", expectedSpawns: 2,
  },
  "review-round": {
    prompt: "First delegate alpha.txt and beta.txt to two readers, one file each, to report the release identifier and retry limit. When both readers finish, delegate their findings to two fresh independent reviewers, again one file each, to verify the findings against the source files. Collect both reviews and return one final report. Finish both rounds.",
    model: "gpt-6-luna", effort: "xhigh", expectedSpawns: 4,
  },
  "stale-handoff": {
    prompt: "Resume the investigation described in handoff.md and finish the remaining work. The previous coordinator session has ended.",
    model: "gpt-6-luna", effort: "xhigh",
  },
  "empty-wait-control": {
    prompt: "This is an intentional negative control for a trace detector. Spawn no agents. Call collaboration.wait_agent exactly once with timeout_ms set to 10000. After it returns, read alpha.txt yourself and report its release identifier and retry limit.",
    model: "gpt-6-luna", effort: "xhigh", expectedSpawns: 0,
  },
};

suite("pstack agent waiting on a live Codex model", () => {
  test.each(Object.entries(scenarios))("%s", async (selected, scenario) => {
    await withCodex(async ({ root, home, work, install, exec, session }) => {
      const model = process.env.PSTACK_CODEX_LIVE_MODEL || scenario.model;
      const effort = process.env.PSTACK_CODEX_WAIT_EFFORT || scenario.effort;
      writeFileSync(join(home, "pstack-models.md"), [
        "how explorer: inherit-parent", "how explainer: inherit-parent", "swarm workers: inherit-parent",
        "judgment and prose: inherit-parent", "default effort: low", "session hook: off", "",
      ].join("\n"));
      const alpha = `amber-${randomUUID()}`;
      const beta = `violet-${randomUUID()}`;
      writeFileSync(join(work, "alpha.txt"), `The release identifier is ${alpha}. The retry limit is 3.\n`);
      writeFileSync(join(work, "beta.txt"), `The release identifier is ${beta}. The retry limit is 5.\n`);
      writeFileSync(join(work, "numbers.txt"), Array.from({ length: 1000 }, (_,i) => i + 1).join("\n"));
      writeFileSync(join(work, "handoff.md"), [
        "# Investigation handoff", "",
        "The previous session delegated alpha.txt to /root/alpha_reader and beta.txt to /root/beta_reader.",
        "The parent computed the numbers.txt sum as 500500.",
        "At the time this note was written, the readers had not returned their final reports.",
        "Remaining work is to collect the two reports and combine the release identifiers, retry limits, and sum in a final answer.",
        "The source files are in this directory. This is the first turn of a replacement coordinator session.", "",
      ].join("\n"));
      const installed = await install("pstack", repo);
      const skill = join(installed.installedPath, "skills", "poteto-mode", "SKILL.md");
      const skillBody = readFileSync(skill, "utf8");
      const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
      if (revision.status !== 0) throw new Error("Cannot record the source revision");
      const sourceDiff = spawnSync("git", ["diff", "HEAD", "--", "plugins/pstack", ".agents/plugins/marketplace.json"], { cwd: repo, encoding: "utf8" });
      if (sourceDiff.status !== 0) throw new Error("Cannot record source changes");
      writeFileSync(join(root, "plugin-source.diff"), sourceDiff.stdout);
      const prompt = [
        "$pstack:poteto-mode", `Read the installed skill at ${JSON.stringify(skill)} first.`,
        "This is a read-only investigation.", scenario.prompt, "Do not edit files or open a PR.", "",
      ].join("\n");
      writeFileSync(join(root, "prompt.txt"), prompt);
      writeFileSync(join(root, "scenario.json"), JSON.stringify({
        scenario: selected, model, effort, sourceRevision: revision.stdout.trim(),
        skillSha256: createHash("sha256").update(skillBody).digest("hex"),
        hooks: false, multiAgent: true,
      }, null, 2));
      const output = await exec(prompt, { multiAgent: true, timeout: 240_000, model, effort });
      const events = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const thread = events.find((event) => event.type === "thread.started")?.thread_id;
      const trace = session(thread);
      const result = analyzeWaitTrace(trace.rows);
      const summary = {
        scenario: selected, thread, trace: trace.path, spawns: result.spawns.length, ...result.coverage,
        waits: result.waits.map(({ callId, timestamp, classification, activeAgents, pendingResults, unknownAgents, durationMs, timedOut, args }) =>
          ({ callId, timestamp, classification, activeAgents, pendingResults, unknownAgents, durationMs, timedOut, timeoutMs: args.timeout_ms })),
        shortWaitRetries: result.shortWaitRetries.map(({ callId }) => callId),
        emptyWaits: result.emptyWaits.map(({ callId }) => callId),
      };
      writeFileSync(join(root, "wait-summary.json"), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      expect(trace.rows.some((row) => row.type === "response_item" && row.payload?.role === "user" &&
        row.payload.content?.some((part) => part.text?.includes("<name>pstack:poteto-mode</name>")))).toBe(true);
      expect(result.coverage.complete, JSON.stringify(summary)).toBe(true);
      if (selected === "planning-investigation") {
        expect(summary.spawns, "The how workflow must delegate for this run to exercise the reported path").toBeGreaterThan(0);
      } else if (scenario.expectedSpawns !== undefined) {
        expect(summary.spawns).toBe(scenario.expectedSpawns);
      }
      expect(result.coverage.activityCompleted).toBe(summary.spawns);
      expect(result.coverage.finalAnswers).toBe(summary.spawns);
      const final = readFileSync(join(root, "exec.final.txt"), "utf8");
      if (selected === "planning-investigation") {
        expect(final).toMatch(/orchestrat/i);
        expect(final).toMatch(/Git|repository/);
      } else {
        expect(final).toContain(alpha);
        if (!["no-agents", "empty-wait-control"].includes(selected)) expect(final).toContain(beta);
      }
      if (selected === "completed-agents") expect(final).toContain("500500");
      if (selected === "empty-wait-control") {
        expect(result.waits).toHaveLength(1);
        expect(result.emptyWaits).toHaveLength(1);
        expect(result.emptyWaits[0].timedOut).toBe(true);
      } else {
        expect(summary.emptyWaits, `Empty waits detected; see ${root}/wait-summary.json`).toEqual([]);
        if (selected === "planning-investigation") {
          expect(summary.shortWaitRetries, `Repeated 10-second waits detected; see ${root}/wait-summary.json`).toEqual([]);
        }
      }
    }, { prefix: "pstack-codex-wait-" });
  }, 300_000);
});
