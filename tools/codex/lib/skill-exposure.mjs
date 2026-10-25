import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function catalogSkillFiles(plugin) {
  const files = [];
  function walk(directory, relative) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const body = readFileSync(join(directory, entry.name), "utf8");
        files.push({ path, body, sha256: createHash("sha256").update(body).digest("hex") });
      }
    }
  }
  walk(join(plugin, "skills"), "skills");
  walk(join(plugin, ".codex-plugin/prompts"), ".codex-plugin/prompts");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const normalize = text => text.replaceAll("\r\n", "\n").trim();
function outputText(output) {
  if (typeof output === "string") {
    try { return outputText(JSON.parse(output)); } catch { return output; }
  }
  if (Array.isArray(output)) return output.map(outputText).join("\n");
  if (output && typeof output === "object") return Object.values(output).map(outputText).join("\n");
  return "";
}

// Measures content delivered to the parent, not filesystem access or comprehension.
export function analyzeSkillExposure(rows, files) {
  const owners = new Map();
  for (const file of files) for (const line of new Set(normalize(file.body).split("\n"))) {
    if (line.length < 40) continue;
    if (!owners.has(line)) owners.set(line, new Set());
    owners.get(line).add(file.path);
  }
  const calls = new Map();
  const firstSpawn = rows.findIndex(row => row.payload?.namespace === "collaboration" && row.payload.name === "spawn_agent");
  const evidence = files.map(({ path, sha256 }) => ({ path, sha256, exposures: [] }));
  rows.forEach((row, rowIndex) => {
    const p = row.payload;
    if (row.type !== "response_item" || !p) return;
    if (["function_call", "custom_tool_call"].includes(p.type)) calls.set(p.call_id, p);
    if (!["function_call_output", "custom_tool_call_output"].includes(p.type)) return;
    const output = normalize(outputText(p.output));
    const lines = new Set(output.split("\n"));
    files.forEach((file, index) => {
      const body = normalize(file.body);
      const full = body.length > 0 && output.includes(body);
      const matchedLines = body.split("\n").flatMap((line, i) =>
        owners.get(line)?.size === 1 && lines.has(line) ? [i + 1] : []);
      if (!full && !matchedLines.length) return;
      const call = calls.get(p.call_id);
      evidence[index].exposures.push({
        rowIndex, timestamp: row.timestamp, callId: p.call_id,
        tool: call?.name, arguments: call?.arguments ?? call?.input,
        match: full ? "full-content" : "unique-lines", matchedLines,
        beforeDelegation: firstSpawn < 0 ? null : rowIndex < firstSpawn,
      });
    });
  });
  return {
    scope: "Parent tool responses only. Content matches show exposure, not comprehension or guaranteed filesystem reads. Shared or transformed excerpts may be unidentifiable.",
    files: evidence,
  };
}

export function formatSkillExposure(report) {
  const observed = report.files.filter(file => file.exposures.length);
  return ["# Parent skill content exposure", "", report.scope, "",
    ...observed.flatMap(file => [`- ${file.path}`, ...file.exposures.map(item =>
      `  - ${item.match}; source lines ${item.matchedLines.join(", ") || "all"}; trace row ${item.rowIndex}; call ${item.callId}; before delegation: ${item.beforeDelegation}`)]),
    ...(observed.length ? [] : ["No identifiable skill content found in parent tool responses."]), "",
    "Files without identifiable exposure:", ...report.files.filter(file => !file.exposures.length).map(file => `- ${file.path}`), "",
  ].join("\n");
}
