import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withCodex } from "./harness/harness.mjs";
import { writeNativePlugin } from "./harness/native-plugin.mjs";

const suite = process.env.PSTACK_CODEX_LIVE === "1" ? describe : describe.skip;

suite("native Codex plugin on a live model", () => {
  test("an installed plugin skill returns the marker from its body", async () => {
    await withCodex(async ({ root, marketplace, install, exec }) => {
      const marker = `SKILL-RAN-${randomUUID()}`;
      const { pluginName } = writeNativePlugin(marketplace, marker);
      await install(pluginName, marketplace);

      const output = await exec("$native-live-check\n");
      const events = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      const replies = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
      expect(replies.at(-1)?.item.text).toBe(marker);
      expect(readFileSync(join(root, "exec.final.txt"), "utf8").trim()).toBe(marker);
    });
  }, 300_000);
});
