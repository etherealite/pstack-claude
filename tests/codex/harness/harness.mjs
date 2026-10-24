import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export async function withCodex(callback, { prefix = "pstack-codex-live-", command = ["codex"], env: sourceEnv = process.env } = {}) {
  if (!/^[\w.-]+$/.test(prefix)) throw new Error("Invalid Codex live artifact prefix");
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "codex");
  const work = join(root, "work");
  const marketplace = join(root, "marketplace");
  const auth = join(home, "auth.json");
  const sourceAuth = join(sourceEnv.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  const apiKey = sourceEnv.CODEX_API_KEY || sourceEnv.OPENAI_API_KEY;
  const env = { ...sourceEnv, CODEX_HOME: home };
  const [executable, ...commandArgs] = command;
  let failed = true;
  console.log(`Codex artifacts: ${root}`);

  async function run(label, args, input, { timeout = 30_000 } = {}) {
    if (!/^[\w.-]+$/.test(label)) throw new Error("Invalid Codex live artifact label");
    const stdoutFile = openSync(join(root, `${label}.stdout.log`), "w");
    const stderrFile = openSync(join(root, `${label}.stderr.log`), "w");
    const chunks = [];
    let error;
    let result;
    try {
      result = await new Promise((resolve) => {
        const child = spawn(executable, [...commandArgs, ...args], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
        const timer = setTimeout(() => {
          error = new Error(`Timed out after ${timeout}ms`);
          child.kill();
        }, timeout);
        child.stdout.on("data", (chunk) => {
          chunks.push(chunk);
          writeSync(stdoutFile, chunk);
        });
        child.stderr.on("data", (chunk) => writeSync(stderrFile, chunk));
        child.on("error", (cause) => { error = cause; });
        child.stdin.on("error", (cause) => { error ||= cause; });
        child.on("close", (status, signal) => {
          clearTimeout(timer);
          resolve({ status, signal });
        });
        child.stdin.end(input);
      });
    } finally {
      closeSync(stdoutFile);
      closeSync(stderrFile);
    }
    writeFileSync(join(root, `${label}.result.json`), JSON.stringify({ ...result, error: error?.message }));
    if (error || result.status !== 0) throw new Error(`codex ${label} failed; see ${root}`, { cause: error });
    return Buffer.concat(chunks).toString("utf8");
  }

  async function install(pluginName, marketplaceRoot) {
    const catalog = JSON.parse(readFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    await run("marketplace-add", ["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
    return JSON.parse(await run("plugin-add", ["plugin", "add", `${pluginName}@${catalog.name}`, "--json"]));
  }

  async function exec(prompt, { label = "exec", multiAgent = false, timeout = 180_000, model = sourceEnv.PSTACK_CODEX_LIVE_MODEL || "gpt-6-luna", effort = "xhigh" } = {}) {
    await authenticate();
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
      "--disable", "hooks", multiAgent ? "--enable" : "--disable", "multi_agent", "--enable", "skip_host_skill_discovery",
      "-c", 'approval_policy="never"', "-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
      "-C", work, "--output-last-message", join(root, `${label}.final.txt`),
    ];
    if (process.platform === "win32") args.push("-c", 'windows.sandbox="unelevated"');
    args.push("-");
    return run(label, args, prompt, { timeout });
  }

  function session(threadId) {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId)) throw new Error("Invalid Codex thread ID");
    function find(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const found = find(path);
          if (found) return found;
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
          return path;
        }
      }
    }
    const path = find(join(home, "sessions"));
    if (!path) throw new Error(`No rollout for Codex thread ${threadId}; see ${root}`);
    return { path, rows: readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
  }

  async function authenticate() {
    if (existsSync(auth)) return;
    if (apiKey) {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [...commandArgs, "login", "--with-api-key"], { cwd: work, env, stdio: ["pipe", "ignore", "ignore"] });
        let loginError;
        const timer = setTimeout(() => { loginError = new Error("Codex API key login timed out"); child.kill(); }, 30_000);
        child.on("error", () => { loginError = new Error("Codex API key login failed"); });
        child.stdin.on("error", () => { loginError = new Error("Codex API key login failed"); });
        child.on("close", (status) => {
          clearTimeout(timer);
          if (!loginError && status === 0) resolve();
          else reject(loginError || new Error("Codex API key login failed"));
        });
        child.stdin.end(apiKey);
      });
    } else {
      if (!existsSync(sourceAuth)) throw new Error("Codex live test requires auth.json, CODEX_API_KEY, or OPENAI_API_KEY");
      copyFileSync(sourceAuth, auth);
    }
  }

  try {
    mkdirSync(home);
    mkdirSync(work);
    mkdirSync(join(marketplace, ".agents", "plugins"), { recursive: true });
    mkdirSync(join(marketplace, "plugins"));
    const version = (await run("version", ["--version"])).trim();
    writeFileSync(join(root, "provenance.json"), JSON.stringify({ version, platform: process.platform, arch: process.arch, runtime: process.version, createdAt: new Date().toISOString() }, null, 2));
    const result = await callback({ root, home, work, marketplace, run, install, exec, session });
    failed = false;
    return result;
  } finally {
    rmSync(auth, { force: true });
    if (!failed && sourceEnv.PSTACK_CODEX_LIVE_KEEP !== "1") {
      if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith(prefix)) throw new Error(`Unexpected cleanup path: ${root}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
