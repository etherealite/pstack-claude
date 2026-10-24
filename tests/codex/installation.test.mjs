import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withCodex } from "./harness/harness.mjs";
import { writeNativePlugin } from "./harness/native-plugin.mjs";

const suite = process.env.PSTACK_CODEX_INSTALL === "1" ? describe : describe.skip;
const repo = fileURLToPath(new URL("../../", import.meta.url));

suite("native Codex plugin installation", () => {
  test("a generated plugin installs its skill source unchanged", async () => {
    await withCodex(async ({ marketplace, install }) => {
      const { pluginName, skill, skillPath } = writeNativePlugin(marketplace, `SKILL-RAN-${randomUUID()}`);
      const installed = await install(pluginName, marketplace);
      expect(readFileSync(join(installed.installedPath, skillPath), "utf8")).toBe(skill);
    });
  }, 300_000);

  test("pstack installs this checkout's poteto-mode skill source unchanged", async () => {
    await withCodex(async ({ install }) => {
      const installed = await install("pstack", repo);
      const skillPath = join("skills", "poteto-mode", "SKILL.md");
      expect(readFileSync(join(installed.installedPath, skillPath), "utf8"))
        .toBe(readFileSync(join(repo, "plugins", "pstack", skillPath), "utf8"));
    });
  }, 300_000);
});
