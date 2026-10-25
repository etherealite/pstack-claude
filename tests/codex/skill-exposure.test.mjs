import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { analyzeSkillExposure, catalogSkillFiles, formatSkillExposure } from "../../tools/codex/lib/skill-exposure.mjs";

const a = "This distinctive instruction belongs only to skill A and is long enough to identify.";
const b = "This distinctive instruction belongs only to skill B and is long enough to identify.";
const shared = "This shared instruction appears in both skills and cannot identify either source.";
const files = [
  { path: "skills/a/SKILL.md", sha256: "a", body: `# A\n${a}\n${shared}\n` },
  { path: "skills/b/SKILL.md", sha256: "b", body: `# B\n${b}\n${shared}\n` },
];
const row = payload => ({ type: "response_item", timestamp: "2026-10-25T00:00:00Z", payload });

test("reports content delivered before and after delegation with linked call evidence", () => {
  const report = analyzeSkillExposure([
    row({ type: "function_call", name: "exec_command", call_id: "read-a", arguments: '{"cmd":"cat skills/a/SKILL.md"}' }),
    row({ type: "function_call_output", call_id: "read-a", output: JSON.stringify({ output: files[0].body.replaceAll("\n", "\r\n") }) }),
    row({ type: "function_call", namespace: "collaboration", name: "spawn_agent" }),
    row({ type: "custom_tool_call_output", call_id: "partial-b", output: [{ type: "text", text: b }] }),
  ], files);
  expect(report.files[0].exposures[0]).toMatchObject({ match: "full-content", beforeDelegation: true, callId: "read-a", tool: "exec_command", rowIndex: 1 });
  expect(report.files[1].exposures[0]).toMatchObject({ match: "unique-lines", matchedLines: [2], beforeDelegation: false });
  expect(formatSkillExposure(report)).toContain("skills/a/SKILL.md");
});

test("paths in commands, user messages, and shared excerpts do not prove exposure", () => {
  const report = analyzeSkillExposure([
    row({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `echo '${a}' skills/a/SKILL.md` }) }),
    row({ type: "message", role: "user", content: [{ text: files[1].body }] }),
    row({ type: "function_call_output", output: shared }),
  ], files);
  expect(report.files.every(file => file.exposures.length === 0)).toBe(true);
  expect(formatSkillExposure(report)).toContain("No identifiable skill content");
});

test("catalog includes source skills, references, and generated prompt shortcuts", () => {
  const catalog = catalogSkillFiles(fileURLToPath(new URL("../../plugins/pstack/", import.meta.url)));
  expect(catalog.some(file => file.path === "skills/interrogate/SKILL.md")).toBe(true);
  expect(catalog.some(file => file.path === "skills/poteto-mode/references/codex-tools.md")).toBe(true);
  expect(catalog.some(file => file.path === ".codex-plugin/prompts/interrogate.md")).toBe(true);
  expect(catalog.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
});
