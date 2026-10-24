import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const input = () => readFileSync(0, "utf8");

if (args[0] === "--version") {
  console.log("codex-cli fixture");
} else if (args[0] === "fixture-echo") {
  console.log(JSON.stringify({ args, input: input(), cwd: process.cwd(), home }));
  console.error("fixture stderr");
} else if (args[0] === "fixture-fail") {
  console.error("fixture command failed");
  process.exitCode = 7;
} else if (args[0] === "fixture-sleep") {
  setTimeout(() => {}, 30_000);
} else if (args[0] === "login") {
  if (process.env.FAKE_CODEX_LOGIN_FAIL === "1") {
    process.exitCode = 1;
  } else {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ key: input() }));
  }
} else if (args[0] === "plugin" && args[1] === "marketplace") {
  console.log(JSON.stringify({ added: args[3] }));
} else if (args[0] === "plugin" && args[1] === "add") {
  console.log(JSON.stringify({ installedPath: join(home, "plugins", "fixture"), plugin: args[2] }));
} else if (args[0] === "exec") {
  const thread = "12345678-1234-1234-1234-123456789abc";
  const output = args[args.indexOf("--output-last-message") + 1];
  writeFileSync(join(process.cwd(), "request.json"), JSON.stringify({ args, prompt: input(), home, authenticated: existsSync(join(home, "auth.json")) }));
  writeFileSync(output, "scripted reply\n");
  const sessions = join(home, "sessions", "2026", "10", "19");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-fixture-${thread}.jsonl`), [
    { type: "session_meta", payload: { id: thread } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  console.log(JSON.stringify({ type: "thread.started", thread_id: thread }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  console.error(`Unsupported fixture command ${JSON.stringify(args)}`);
  process.exitCode = 2;
}
