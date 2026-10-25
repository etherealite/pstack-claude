import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCodex } from "../harness/harness.mjs";
import { createWorkerProxy } from "../harness/controlled-workers.mjs";
import { analyzeWaitTrace } from "../../../tools/codex/lib/wait-trace.mjs";

const localTest = process.env.PSTACK_CODEX_LOCAL === "1" ? test : test.skip;

localTest("installed Codex executes local send_message, wakes while worker active, and receives its later final", async () => {
  await withCodex(async runtime => {
    let requests = 0;
    const proxy = createWorkerProxy({ workerDelays: new Map([["gpt-6.1-sol", 1800]]),
      progressMessages: [{ atMs: 300, text: "Synthetic progress; review still active." }, { atMs: 700, text: "Synthetic second progress." }],
      forward: async (_url, options) => {
        const body = JSON.parse(new TextDecoder().decode(options.body));
        writeFileSync(join(runtime.root, `parent-request-${++requests}.json`), JSON.stringify(body, null, 2));
        for (const message of body.input || []) {
          if (message.type !== "agent_message" || message.author !== "/root/worker" ||
            !message.content?.[0]?.text?.startsWith("Message Type: MESSAGE")) continue;
          expect(message.content.some(part => part.type === "encrypted_content")).toBe(false);
          expect(message.content).toHaveLength(1);
          expect(["Synthetic progress; review still active.", "Synthetic second progress."])
            .toContain(message.content[0].text.split("Payload:\n")[1]);
        }
        const delivered = (body.input || []).some(item => item.type === "agent_message" && item.content?.some(part => part.text?.startsWith("Message Type: FINAL_ANSWER")));
        const item = requests === 1
          ? { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "spawn", arguments: JSON.stringify({ task_name: "worker", message: "Synthetic local worker", model: "gpt-6.1-sol", fork_turns: "none" }) }
          : delivered ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "Local mailbox verified.", annotations: [] }] }
            : { type: "function_call", namespace: "collaboration", name: "wait_agent", call_id: `wait-${requests}`, arguments: JSON.stringify({ timeout_ms: 10000 }) };
        if (requests > 10) throw new Error("Unexpected scripted parent retry");
        item.id = `item-${requests}`;
        item.status = "completed";
        const response = { id: `resp-${requests}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
        const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
    writeFileSync(join(runtime.home, "config.toml"), [
      'model_provider="local"', '[model_providers.local]', 'name="Local scripted provider"',
      `base_url="${proxy.url}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false',
      'supports_websockets=false', 'request_max_retries=0', 'stream_max_retries=0', '',
    ].join("\n"));
    try {
      const output = await runtime.run("local-mailbox", ["exec", "--json", "--skip-git-repo-check", "--enable", "multi_agent",
        "--disable", "hooks", "--enable", "skip_host_skill_discovery", "-c", 'approval_policy="never"', "-m", "gpt-6.1-sol", "-"], "Synthetic local mailbox validation", { timeout: 30000 });
      const thread = output.trim().split(/\r?\n/).map(JSON.parse).find(event => event.type === "thread.started").thread_id;
      const rows = runtime.session(thread).rows;
      const result = analyzeWaitTrace(rows);
      writeFileSync(join(runtime.root, "controlled-workers.json"), JSON.stringify(proxy.control, null, 2));
      writeFileSync(join(runtime.root, "wait-analysis.json"), JSON.stringify(result, null, 2));
      expect(result.coverage).toMatchObject({ ordinaryMessages: 2, finalAnswers: 1, activityCompleted: 1, complete: true });
      const progressWait = result.waits.find(wait => wait.trackedWork === "active" && wait.timedOut === false && wait.nearbyMessages.some(message => message.kind === "ordinary_message"));
      expect(progressWait).toBeDefined();
      const completionIndex = rows.findIndex(row => row.payload?.item?.type === "SubAgentActivity" && row.payload.item.kind === "completed");
      expect(completionIndex).toBeGreaterThan(progressWait.outputRowIndex);
      expect(result.waits.some(wait => wait.rowIndex > progressWait.outputRowIndex && wait.rowIndex < completionIndex && wait.trackedWork === "active")).toBe(true);
      expect(proxy.control.workers[0]).toMatchObject({ phase: "finished" });
      expect(proxy.control.workers[0].acknowledgedCalls).toHaveLength(2);
      expect(proxy.control.workerRequests).toBe(3);
      expect(proxy.control.workerUpstreamRequests).toBe(0);
      expect(proxy.control.workers[0].messageIds).toHaveLength(2);
      expect(proxy.control.observations.some(item => item.hydratedMessages?.length === 2)).toBe(true);
      const rawProgress = rows.filter(row => row.type === "response_item" && row.payload?.type === "agent_message" &&
        row.payload.content?.[0]?.text?.startsWith("Message Type: MESSAGE"));
      expect(rawProgress).toHaveLength(2);
      expect(rawProgress.every(row => row.payload.content.some(part => part.type === "encrypted_content"))).toBe(true);
    } finally { proxy.stop(); }
  }, { prefix: "pstack-local-mailbox-", env: { ...process.env, PSTACK_CODEX_LIVE_KEEP: "1" } });
}, 40000);
