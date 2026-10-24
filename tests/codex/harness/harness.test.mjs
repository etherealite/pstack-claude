import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withCodex } from "./harness.mjs";

const command = [process.execPath, fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url))];
const thread = "12345678-1234-1234-1234-123456789abc";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

async function fixture(callback, env = {}) {
  const source = realpathSync(mkdtempSync(join(tmpdir(), "pstack-codex-harness-test-")));
  let artifacts;
  try {
    await callback({
      source,
      run: (body, overrides = {}) => withCodex(async (context) => {
        artifacts = context.root;
        return body(context);
      }, {
        command,
        env: { ...process.env, CODEX_HOME: source, CODEX_API_KEY: "", OPENAI_API_KEY: "", PSTACK_CODEX_LIVE_KEEP: "", ...env, ...overrides },
      }),
    });
  } finally {
    for (const path of [artifacts, source].filter(Boolean)) {
      if (dirname(path) !== realpathSync(tmpdir()) || !basename(path).startsWith("pstack-codex-")) throw new Error(`Unexpected cleanup path: ${path}`);
      rmSync(path, { recursive: true, force: true });
    }
  }
}

test("the harness runs commands and installs plugins in an isolated home without credentials", async () => {
  await fixture(async ({ source, run }) => {
    let artifacts;
    await run(async ({ root, home, work, marketplace, run, install }) => {
      artifacts = root;
      expect(home).not.toBe(source);
      expect(existsSync(join(source, "auth.json"))).toBe(false);
      expect(json(join(root, "provenance.json"))).toMatchObject({ version: "codex-cli fixture", platform: process.platform });
      const output = await run("echo", ["fixture-echo", "two words"], "input\n");
      expect(JSON.parse(output)).toEqual({ args: ["fixture-echo", "two words"], input: "input\n", cwd: work, home });
      expect(readFileSync(join(root, "echo.stdout.log"), "utf8")).toBe(output);
      expect(readFileSync(join(root, "echo.stderr.log"), "utf8")).toContain("fixture stderr");
      expect(json(join(root, "echo.result.json"))).toMatchObject({ status: 0, signal: null });
      writeFileSync(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "fixture-market" }));
      expect(await install("testplug", marketplace)).toEqual({ installedPath: join(home, "plugins", "fixture"), plugin: "testplug@fixture-market" });
      expect(json(join(root, "marketplace-add.stdout.log"))).toEqual({ added: marketplace });
      expect(existsSync(join(home, "auth.json"))).toBe(false);
    });
    expect(existsSync(artifacts)).toBe(false);
    expect(readdirSync(source)).toEqual([]);
  });
});

test("exec forwards the prompt and model settings and session finds the nested rollout", async () => {
  await fixture(async ({ run }) => {
    let artifacts;
    await run(async ({ root, home, work, exec, session }) => {
      artifacts = root;
      const output = await exec("a scripted prompt", { label: "custom", multiAgent: true, model: "fixture-model", effort: "low" });
      const request = json(join(work, "request.json"));
      expect(request).toMatchObject({ prompt: "a scripted prompt", home, authenticated: true });
      expect(request.args).toEqual([
        "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
        "--disable", "hooks", "--enable", "multi_agent", "--enable", "skip_host_skill_discovery",
        "-c", 'approval_policy="never"', "-m", "fixture-model", "-c", 'model_reasoning_effort="low"',
        "-C", work, "--output-last-message", join(root, "custom.final.txt"),
        ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []), "-",
      ]);
      expect(readFileSync(join(root, "custom.stdout.log"), "utf8")).toBe(output);
      expect(readFileSync(join(root, "custom.final.txt"), "utf8")).toBe("scripted reply\n");
      expect(json(join(home, "auth.json"))).toEqual({ key: "fixture-api-key" });
      const trace = session(thread);
      expect(trace.path).toBe(join(home, "sessions", "2026", "10", "19", `rollout-fixture-${thread}.jsonl`));
      expect(trace.rows).toEqual([
        { type: "session_meta", payload: { id: thread } },
        { type: "event_msg", payload: { type: "task_complete" } },
      ]);
      expect(() => session("../invalid")).toThrow("Invalid Codex thread ID");
      expect(() => session("00000000-0000-0000-0000-000000000000")).toThrow("No rollout");
    }, { CODEX_API_KEY: "fixture-api-key", PSTACK_CODEX_LIVE_KEEP: "1" });
    expect(existsSync(artifacts)).toBe(true);
    expect(existsSync(join(artifacts, "codex", "auth.json"))).toBe(false);
    for (const file of readdirSync(artifacts).filter((name) => name.endsWith(".log"))) {
      expect(readFileSync(join(artifacts, file), "utf8")).not.toContain("fixture-api-key");
    }
  });
});

test("a callback failure retains evidence and removes copied credentials without changing their source", async () => {
  await fixture(async ({ source, run }) => {
    const credentials = '{"fixture":"copied-auth"}';
    writeFileSync(join(source, "auth.json"), credentials);
    let artifacts;
    await expect(run(async ({ root, home, exec }) => {
      artifacts = root;
      await exec("fixture");
      expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(credentials);
      throw new Error("fixture callback failed");
    })).rejects.toThrow("fixture callback failed");
    expect(existsSync(join(artifacts, "exec.result.json"))).toBe(true);
    expect(existsSync(join(artifacts, "codex", "auth.json"))).toBe(false);
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe(credentials);
  });
});

test("a nonzero CLI exit preserves stderr and exit status", async () => {
  await fixture(async ({ run }) => {
    let artifacts;
    await expect(run(async ({ root, run }) => {
      artifacts = root;
      await run("failure", ["fixture-fail"]);
    })).rejects.toThrow("codex failure failed");
    expect(json(join(artifacts, "failure.result.json"))).toMatchObject({ status: 7 });
    expect(readFileSync(join(artifacts, "failure.stderr.log"), "utf8")).toContain("fixture command failed");
  });
});

test("a timed out CLI command records the timeout and retains its artifacts", async () => {
  await fixture(async ({ run }) => {
    let artifacts;
    await expect(run(async ({ root, run }) => {
      artifacts = root;
      await run("timeout", ["fixture-sleep"], undefined, { timeout: 100 });
    })).rejects.toThrow("codex timeout failed");
    expect(json(join(artifacts, "timeout.result.json"))).toMatchObject({ error: "Timed out after 100ms" });
  });
});

test("failed API key login stops before exec and leaves no credential artifact", async () => {
  await fixture(async ({ run }) => {
    let artifacts;
    await expect(run(async ({ root, exec }) => {
      artifacts = root;
      await exec("fixture");
    })).rejects.toThrow("Codex API key login failed");
    expect(existsSync(join(artifacts, "exec.stdout.log"))).toBe(false);
    expect(existsSync(join(artifacts, "codex", "auth.json"))).toBe(false);
  }, { CODEX_API_KEY: "fixture-api-key", FAKE_CODEX_LOGIN_FAIL: "1" });
});
