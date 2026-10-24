import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeNativePlugin(marketplace, marker) {
  const pluginName = "testplug";
  const plugin = join(marketplace, "plugins", pluginName);
  const skillPath = "skills/native-live-check/SKILL.md";
  mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
  mkdirSync(join(plugin, "skills", "native-live-check"), { recursive: true });
  const skill = [
    "---",
    "name: native-live-check",
    "description: Native plugin skill invocation check.",
    "---",
    "",
    `Reply with exactly this text: ${marker}`,
    "Then stop. Do not invoke any other skill or tool.",
    "",
  ].join("\n");
  writeFileSync(join(plugin, skillPath), skill);
  writeFileSync(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: pluginName, version: "0.0.1", description: "Native plugin loading fixture", skills: "./skills/",
  }));
  writeFileSync(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "codex-live-fixture",
    interface: { displayName: "Codex live fixture" },
    plugins: [{
      name: pluginName,
      source: { source: "local", path: "./plugins/testplug" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL", products: ["CODEX"] },
      category: "Developer Tools",
    }],
  }));
  return { pluginName, skill, skillPath };
}
