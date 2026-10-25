# Codex tool mapping for pstack

Use the tools exposed by this Codex session. Tool names and capabilities vary by host.

## Tool actions

| pstack / Claude action | Codex equivalent |
|------------------------|------------------|
| File, shell, URL, or web work | The session's file, shell, and browsing tools. |
| Invoke a skill (the `Skill` tool, `/command`) | Load its `SKILL.md` through the session's skill mechanism. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `spawn_agent`, using the fields its session schema supports. |
| Wait for a subagent result | Track required agents and their delivered results. When independent work is finished, wait only while a required agent is running or its result is pending delivery: use `wait_agent` with `timeout_ms: 60000`, returning early when an agent reports. Once all required results have arrived, synthesize or finish. |
| Free a finished subagent slot | `close_agent`, when the session exposes it. |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `update_plan`, when exposed. Otherwise use poteto-mode's [task-tracking fallback](../SKILL.md#platform-adaptation). |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Use an available question tool when the current mode permits it. Otherwise ask in chat. |

If the Codex host gates subagents behind `multi_agent`, enable it in `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

When dispatch is unavailable, follow poteto-mode's [Subagents policy](../SKILL.md#subagents).

A thread-limit rejection is a capacity error, so model-slug fallbacks do not apply. Stop spawning after the first capacity rejection. Free a finished slot before retrying when the host exposes a lifecycle tool. Without one, do not assume completion frees the slot.

## Subagent policy

`spawn_agent` already runs concurrently with your turn, so `run_in_background: true` needs no separate flag. Replace Claude's registered pstack agent types with instruction pointers in the child brief:

- `poteto-agent`: read [poteto-mode](../SKILL.md) in full first.
- `comment-sicko`: read [poteto-mode/references/agents/comment-sicko.md](agents/comment-sicko.md) in full first.
- `thermo-nuclear-review-subagent` and `thermo-nuclear-code-quality-review-subagent`: read [thermo-nuclear-review](../../thermo-nuclear-review/SKILL.md) or [thermo-nuclear-code-quality-review](../../thermo-nuclear-code-quality-review/SKILL.md) in full first, respectively. Review only the diff and file contents supplied in the brief.

Preserve a role's read-only scope through the host's controls or the child brief. Apply configured model and effort settings through supported dispatch fields, respecting the host's context-inheritance restrictions.

## Model names

Skills name Claude defaults (a single-role default for code/prose/judgment, a worker model for feature and refactoring code, plus a diverse-model panel for diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not resolve on Codex. Substitute your configured Codex models:

- Single-model roles: your primary Codex model (for example `gpt-6-sol`).
- Roles that default to the Claude worker model (`feature, refactoring`): your fast Codex code model (for example `gpt-6-sol`).
- Roles that default to the strongest Claude model (`strongest judgment`): your strongest Codex model (for example `gpt-6-astra`).
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial signal comes from model diversity, so use the distinct Codex models available to you. A good default panel on ChatGPT is `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`. If only one model family is reachable, vary reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs.

## Session routing hook

[setup-pstack](../../setup-pstack/SKILL.md#other-runtimes) owns the Codex sheet path, hook setting, and how model rows load. Its step 4 describes hook trust and lifecycle.

A skills-only installation does not include plugin hooks. Request `poteto-mode` explicitly or add a standing instruction to `AGENTS.md` in that case.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver.

| Skill or driver named in pstack | On Codex |
|---------------------------------|----------|
| `run` | Run the app through the session's shell or app-driving tools. |
| Project UI driver | Use the session's UI automation. The driver policy governs a manual handoff. |
| `plugin-dev:skill-development` | Use the installed `writing-for-agents` skill. |
| `loop` | Use an available recurring-task facility or repeat the step at the workflow's cadence. |

When these workflows create or locate project skills, use Codex's project-skill location in place of `.claude/skills/`.

## Per-skill notes

The common mappings above apply to every row. These rows also select the generated Codex preambles.

| Skill | On Codex |
|-------|----------|
| `interrogate` | Common mappings. |
| `setup-pstack` | See [Other runtimes](../../setup-pstack/SKILL.md#other-runtimes). |
| `no-comments` | See [Subagent policy](#subagent-policy). |
| `thermos` | See [Subagent policy](#subagent-policy). |
| `teach` | Use the session's image-generation tool. |
| `create-verification-skill` | Use the project-skill location above. |
| `maintain-verification-skill` | Use the project-skill location above. |
| `create-formal-verification-skill` | Use the project-skill location above. |
| `maintain-formal-verification-skill` | Use the project-skill location above. |
| `babysit` | See the `loop` and question mappings above. |
| `automate-me` | See the skill-authoring mapping above. |
| `architect` | Common mappings. |
| `arena` | Common mappings. |
| `how` | Common mappings. |
| `reflect` | Pass the session digest allowed by [step 1](../../reflect/SKILL.md#1-locate-the-active-transcript) instead of using its Claude transcript finder. |
| `swarm` | Common mappings. |
| `why` | Discover MCPs from the tools exposed to the session rather than Claude configuration or `claude mcp list`. |

## Vendored scripts

The bundled scripts run unchanged on Codex. Run `worktree-audit.mjs` with `node`. Keep the `reflect` skill installed beside `poteto-mode` for the audit's transcript-walker import. Checkpoint storage is documented in [Resume storage](resume-storage.md).

## Instructions file

Where a pstack skill says "your instructions file", use project `AGENTS.md` and the global `AGENTS.md` in the Codex home directory defined by [setup-pstack](../../setup-pstack/SKILL.md#other-runtimes).
