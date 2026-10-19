# Develop pstack locally on Windows

Edit and commit in the plugin repository. When you want to try a change in Codex, export that commit to a separate snapshot and install it through Codex's local marketplace commands. Editing files, switching branches, and refreshing Codex then leave the selected snapshot unchanged.

This guide belongs to this fork's orphan `docs/local-development` branch. These directions are for our fork and are not intended for upstream. Read the guide from the plugin checkout without a separate worktree:

```powershell
git show docs/local-development:README.md
```

To edit the guide, switch a clean checkout to `docs/local-development`, commit the documentation changes, and return to your implementation branch. A separate documentation worktree is optional.

The [official plugin packaging guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually) describes local marketplaces and copied installations. It also explains that marketplace refresh can refresh configured plugins. The extra snapshot below is our development convention. It keeps the marketplace source independent of an unfinished working tree.

| Workflow | When edits can reach Codex | Use |
| --- | --- | --- |
| Junctions into the working tree | Immediately through the linked paths | Retired |
| Copied install from the working tree | When Codex copies or refreshes the source | Disposable tests |
| Copied install from a committed snapshot | When you explicitly promote a commit | Daily development |
| Git marketplace pinned to a commit | When you explicitly select another commit | Shared builds that have been pushed |

## Prepare the checkout

Run these commands in PowerShell if you do not already have the fork.

```powershell
git clone https://github.com/etherealite/pstack-claude.git
Set-Location pstack-claude
git remote add upstream https://github.com/michael-denyer/pstack-claude.git
git fetch origin docs/local-development
git branch --track docs/local-development origin/docs/local-development
```

`origin` is our fork. `upstream` supplies releases. Keep implementation changes on an implementation branch and changes to these directions on `docs/local-development`.

## Export the commit you want to try

Run this block from the plugin repository root. Run the repository checks appropriate to your change, then commit it locally. You do not need to push it. The archive includes committed files only. Uncommitted changes and untracked files stay out of Codex.

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$ref = 'HEAD'
$codexRoot = if ($env:CODEX_HOME) {
	[IO.Path]::GetFullPath($env:CODEX_HOME)
} else {
	Join-Path $env:USERPROFILE '.codex'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'plugins/pstack/.codex-plugin/plugin.json'))) {
	throw 'Run this from the plugin repository root, not the documentation worktree.'
}
git status --short
$revision = git rev-parse --verify "$ref^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the commit.' }
$snapshotRoot = Join-Path $codexRoot 'plugin-dev/pstack'
$snapshotName = $revision.Substring(0, 12) + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$snapshot = Join-Path $snapshotRoot $snapshotName
New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
$archive = Join-Path $snapshotRoot ($snapshotName + '.zip')
git archive --format=zip "--output=$archive" $revision .agents/plugins/marketplace.json plugins/pstack
if ($LASTEXITCODE -ne 0) { throw 'Snapshot export failed.' }
Expand-Archive -LiteralPath $archive -DestinationPath $snapshot
[IO.File]::WriteAllText((Join-Path $snapshot 'REVISION'), $revision)
Remove-Item -LiteralPath $archive
Write-Output "Snapshot: $snapshot"
Write-Output "Commit: $revision"
```

Treat snapshots as immutable. Each promotion creates a fresh directory outside the working tree and the installed cache. No junctions, hardlinks, version bumps, or same-volume setup are needed. Keep this PowerShell session open for installation.

To try a release or roll back, change `$ref = 'HEAD'` to a commit or tag and rerun the export block. The selected commit must contain the Codex marketplace catalog and plugin manifest.

## Retire a linked installation

Skip this section if your installed plugin already contains regular copies. On this machine, the inspected CLI 0.163.0 installation used `pstack/0.9.93` and contained no links. Do not assume the cache directory is named `local`. Inspect the actual version directory and its children.

If you still use the old junction setup, close the desktop app and other Codex sessions first. In a separate PowerShell window, move the whole linked version directory from `$codexRoot/plugins/cache/pstack-claude/pstack` into `$codexRoot/plugin-dev-backups` with a unique backup name. Move the directory itself. Do not recursively delete its linked contents or edit target files.

Leave backups alone until the copied installation works. Let Codex create and manage the replacement cache in the next section. Never create links inside it.

## Promote the snapshot into Codex

Finish active Codex work before replacing an installation. Use a separate PowerShell window for promotion. If this is a new window, set `$snapshot` to the full path printed by the export block.

First inspect the registration. Save the old root path if you want to restore it later.

```powershell
codex plugin marketplace list --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace inspection failed.' }
```

If `pstack-claude` is already registered, remove its registration. This leaves the working repository and Git remotes alone. A different source cannot replace an existing registration with the same name.

```powershell
codex plugin marketplace remove pstack-claude
if ($LASTEXITCODE -ne 0) { throw 'Marketplace removal failed.' }
```

Register the snapshot and install a normal copy. Skip the removal block on a first installation.

```powershell
codex plugin marketplace add $snapshot --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed.' }
$install = codex plugin add pstack@pstack-claude --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
$installedPath = [IO.Path]::GetFullPath($install.installedPath)
Write-Output "Installed copy: $installedPath"
Get-Content -LiteralPath (Join-Path $snapshot 'REVISION')
```

Run both commands on each promotion, including when the manifest version has not changed. Registration selects the source. `plugin add` copies the plugin into the cache. Do not edit version fields or cache contents to force an update.

If registration or installation fails, register the previous snapshot root again and rerun `plugin add`. Remove the failed registration first if it exists. Keep previous snapshots for rollback. `codex plugin marketplace upgrade` updates Git marketplace snapshots and is not the local promotion command.

Restart the desktop app and open a new chat after promotion. Check `/hooks` and trust changed hooks if Codex requests it. File checks do not establish whether an existing chat has reloaded its instructions.

## Verify the selected build

Run this from the plugin checkout after promotion, in the same PowerShell session as the install block.

```powershell
codex plugin marketplace list --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace inspection failed.' }
$listing = codex plugin list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Plugin inspection failed.' }
$plugin = $listing.installed | Where-Object pluginId -eq 'pstack@pstack-claude'
if (-not $plugin -or -not $plugin.enabled) { throw 'Pstack is not installed and enabled.' }
if ([IO.Path]::GetFullPath($plugin.source.path) -ne [IO.Path]::GetFullPath((Join-Path $snapshot 'plugins/pstack'))) {
	throw 'Pstack is not using the selected snapshot.'
}
$plugin | Select-Object pluginId, version, enabled, source
$links = @(Get-Item -LiteralPath $installedPath -Force) + @(Get-ChildItem -LiteralPath $installedPath -Force -Recurse)
if ($links | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint -or $_.LinkType -eq 'HardLink' }) {
	throw 'The installed plugin contains links.'
}
$sourceSkill = Join-Path $snapshot 'plugins/pstack/skills/poteto-mode/SKILL.md'
$installedSkill = Join-Path $installedPath 'skills/poteto-mode/SKILL.md'
if ((Get-FileHash -LiteralPath $sourceSkill).Hash -ne (Get-FileHash -LiteralPath $installedSkill).Hash) {
	throw 'The installed skill does not match the snapshot.'
}
Write-Output 'The selected snapshot is installed as regular copies.'
```

The registration must resolve to the snapshot directory, including when inspected from the working repository. The CLI build tested here reports the manifest version, such as `0.9.93`. The official desktop guide also describes a `local` cache label. Use `installedPath` from the CLI result instead of constructing either path yourself.

Continue editing and switching branches in the plugin repository. Codex keeps using the selected snapshot until the next promotion. Read `REVISION` in the registered marketplace root to identify that build.

Verified with Codex CLI 0.163.0, Git 2.53.0, and Windows PowerShell on October 19, 2026. The export, registration, install, and verification blocks ran in an isolated `CODEX_HOME`. Same-version promotion replaced the installed skill, and rollback restored its original bytes. The app server's `plugin/list` also selected the registered snapshot when given the working repository in `cwds`, with no marketplace load errors. Restart the desktop app to check skill availability and hook trust in a new chat.

## Test unfinished work separately

For experiments with uncommitted files, register the plugin checkout as the marketplace source inside a temporary `CODEX_HOME`. Codex installs its own regular copy into that home's plugin cache. The waiting test uses this path without an extra source staging copy. The native invocation smoke test creates a temporary marketplace because its plugin is a generated fixture.

Do not register the working tree in your everyday Codex home. Continue using committed snapshots for the everyday installation.

An isolated home has separate plugin configuration and credentials. Keep credentials out of snapshots and source control. The existing live test handles this isolation and removes copied credentials when it finishes.

## Run the Codex live test

Run the test from an implementation checkout containing `tests/codex/live.test.mjs`. The documentation branch contains only this guide.

`tests/codex/live.test.mjs` runs one live Codex session to check native plugin installation and skill invocation with a minimal fixture. It follows the [official plugin evaluation example](https://developers.openai.com/cookbook/examples/partners/harness_aware_plugin_evals/harness_aware_plugin_evals) and [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins). It checks an exact random marker stored only in the skill body. This covers plugin discovery and invocation; pstack workflows, delegation, and hooks need separate cases.

The test skips unless explicitly enabled. With `codex` on `PATH`, use `PSTACK_CODEX_LIVE=1 bun test tests/codex/live.test.mjs` in a POSIX shell, or `$env:PSTACK_CODEX_LIVE='1'; bun test tests/codex/live.test.mjs` in PowerShell. It uses an isolated `CODEX_HOME` and copies only `auth.json` from the original `CODEX_HOME` or `~/.codex`, or logs in with `CODEX_API_KEY` or `OPENAI_API_KEY`. Missing credentials or CLI fail an enabled run. The default model is `gpt-6-luna` at `xhigh` effort; `PSTACK_CODEX_LIVE_MODEL` overrides the model.

`PSTACK_CODEX_LIVE_KEEP=1` preserves temporary artifacts, including CLI version, JSONL stdout, stderr, and final reply. Failed runs preserve artifacts even without this setting. Both paths always remove the temporary `auth.json` and leave the original credentials file untouched. Verified on Windows with Codex CLI 0.163.0. The test uses its experimental `skip_host_skill_discovery` feature to exclude host skills and its unelevated Windows sandbox for read-only skill access. CI leaves the live test disabled.

## Run the Codex waiting regression

Use an implementation checkout containing commit `2ac318b` or a later version of the Codex tests. The test code lives on `fix/codex-agent-waiting`.

Run the detector and replay tests without model calls or credentials:

```powershell
bun test tests/codex/wait-trace.test.mjs tests/codex/replay-waits.test.mjs
```

Run the live planning scenario:

```powershell
$env:PSTACK_CODEX_LIVE='1'
$env:PSTACK_CODEX_LIVE_KEEP='1'
$env:PSTACK_CODEX_WAIT_SCENARIO='planning-investigation'
bun test tests/codex/waiting.test.mjs
```

This scenario defaults to `gpt-6.1-sol` at `low` effort. Override the model with `PSTACK_CODEX_LIVE_MODEL` and the effort with `PSTACK_CODEX_WAIT_EFFORT`. It uses the same isolated credentials and artifact cleanup as the smoke test.

The captured planning run reproduced repeated short waits while its explainer was active. The parent made five waits with three timeout-and-retry transitions, and the regression failed on that behavior. Waiting with no active agents remains unreproduced. A live run can choose a different strategy, so a passing attempt does not establish that the behavior is fixed.

Replay the captured failure without another model call:

```powershell
bun tests/codex/replay-waits.mjs tests/codex/fixtures/planning-live.jsonl --short-waits
```

Expect exit code `1`, `shortWaitRetries: 3`, and `emptyWaits: 0`. Exit code `2` means the trace is incomplete. Without `--short-waits`, this fixture exits `0` because it contains no empty waits.

For all scenarios, artifact details, and detector rules, read `tests/codex/README.md` on the implementation branch. You can read it from any checkout containing that branch:

```powershell
git show fix/codex-agent-waiting:tests/codex/README.md
```
