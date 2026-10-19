# Develop pstack locally on Windows

Use a local checkout of `etherealite/pstack-claude` as Codex's plugin source. Directory junctions expose edits under `skills`, `hooks`, and the other plugin directories without reinstalling.

This guide belongs to this fork's orphan `docs/local-development` branch. It shares no history with the plugin branches. Keep it in a separate worktree so that checking out documentation does not remove the files your running plugin uses. These instructions are maintained for this fork and are not intended for an upstream contribution.

The setup was tested with Codex CLI 0.163.0, Git 2.53.0, and Windows PowerShell on NTFS. It modifies Codex's cache directly and is a development workaround. The [official plugin instructions](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli) describe the supported copied installation.

## Clone the fork

Run these commands in PowerShell. Use a writable directory on the same NTFS volume as your Codex home, because the root files use hardlinks.

```powershell
git clone https://github.com/etherealite/pstack-claude.git
Set-Location pstack-claude
git remote add upstream https://github.com/michael-denyer/pstack-claude.git
```

`origin` points to our fork. `upstream` is available for fetching releases. Leave the plugin checkout on `main`, a development branch, or a release checkout.

## Register the local marketplace

Stop other Codex sessions before replacing their installed plugin files. Keep this PowerShell session open for the following steps.

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$pluginRoot = Join-Path $repo 'plugins/pstack'
$codexRoot = if ($env:CODEX_HOME) {
	[IO.Path]::GetFullPath($env:CODEX_HOME)
} else {
	Join-Path $env:USERPROFILE '.codex'
}
$cacheRoot = Join-Path $codexRoot 'plugins/cache/pstack-claude/pstack'
$local = Join-Path $cacheRoot 'local'
if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot '.codex-plugin/plugin.json'))) {
	throw 'Run this from the plugin repository root, not the documentation worktree.'
}
if (Test-Path -LiteralPath $local) {
	throw 'A local install already exists. Inspect it before reinstalling.'
}
codex plugin marketplace list --json
```

If `pstack-claude` is already registered, remove that registration before adding the checkout. This changes Codex's marketplace registration, not the Git remotes.

```powershell
codex plugin marketplace remove pstack-claude
```

Register the checkout and install a regular copy first.

```powershell
codex plugin marketplace add $repo --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed.' }
$install = codex plugin add pstack@pstack-claude --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
```

## Link the installed contents

Keep the cache's `local` directory as a regular directory. In the tested Codex build, making the version directory itself a junction caused Codex to report the plugin as uninstalled.

The following block preserves the copied install outside the cache. It creates junctions for the plugin's top-level directories and hardlinks for its top-level files.

```powershell
$installedPath = [IO.Path]::GetFullPath($install.installedPath)
if ([IO.Path]::GetDirectoryName($installedPath) -ne [IO.Path]::GetFullPath($cacheRoot)) {
	throw 'The installed plugin is outside the expected cache directory.'
}
$installedItem = Get-Item -LiteralPath $installedPath -Force
if ($installedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
	throw 'The installed directory is already a link. Inspect it before proceeding.'
}
if ((Test-Path -LiteralPath $local) -and $installedPath -ne [IO.Path]::GetFullPath($local)) {
	throw 'The local cache directory already exists.'
}
$backupRoot = Join-Path $codexRoot 'plugin-dev-backups'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backup = Join-Path $backupRoot ('pstack-copy-' + [Guid]::NewGuid().ToString('N'))
Move-Item -LiteralPath $installedPath -Destination $backup
New-Item -ItemType Directory -Path $local | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $pluginRoot -Force) {
	$link = Join-Path $local $entry.Name
	if ($entry.PSIsContainer) {
		New-Item -ItemType Junction -Path $link -Target $entry.FullName | Out-Null
	} else {
		New-Item -ItemType HardLink -Path $link -Target $entry.FullName | Out-Null
	}
}
Write-Output "Copied install preserved at: $backup"
```

The active cache path ends in `pstack/local`. Codex recognizes `local` as an installation label. Leave the version fields in the checkout's manifests unchanged.

If link creation fails, move the partial `local` directory outside the cache and move the preserved copy back to `$installedPath`. Inspect the paths first. Move the directory itself; do not recursively delete its linked contents.

## Verify the installation

```powershell
$listing = codex plugin list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Plugin inspection failed.' }
$plugin = $listing.installed | Where-Object pluginId -eq 'pstack@pstack-claude'
if (-not $plugin -or -not $plugin.enabled -or $plugin.version -ne 'local') {
	throw 'Pstack is not installed and enabled under the local label.'
}
$plugin | Select-Object pluginId, version, enabled
Get-Item -LiteralPath (Join-Path $local 'skills') -Force |
	Select-Object LinkType, Target | Format-List
```

Expect `pstack@pstack-claude`, version `local`, and `enabled` set to `True`. The `skills` entry must be a junction into this checkout.

To check that new files and edits appear through the installed path, run this temporary-file check. It removes its probe when finished.

```powershell
$probeName = '.codex-link-check-' + [Guid]::NewGuid().ToString('N') + '.tmp'
$sourceProbe = Join-Path $pluginRoot "skills/$probeName"
$cacheProbe = Join-Path $local "skills/$probeName"
try {
	[IO.File]::WriteAllText($sourceProbe, 'created')
	if ([IO.File]::ReadAllText($cacheProbe) -ne 'created') { throw 'New file is not visible.' }
	[IO.File]::WriteAllText($sourceProbe, 'edited')
	if ([IO.File]::ReadAllText($cacheProbe) -ne 'edited') { throw 'Edit is not visible.' }
	Write-Output 'New files and edits are visible through the installed path.'
} finally {
	if (Test-Path -LiteralPath $sourceProbe) { Remove-Item -LiteralPath $sourceProbe }
}
```

Restart Codex and open a new chat. Confirm that pstack's skills are available. Inspect and trust the session-start hook through `/hooks` if Codex requests it. These filesystem checks do not prove that an existing chat has reloaded its instructions.

## Edit and switch releases

Edit files under `plugins/pstack` in the plugin checkout. Junctions expose changes and new files inside existing linked directories immediately. A new chat or reload is still needed for instructions, skill metadata, or hooks already loaded by Codex.

Keep the checkout at the same absolute path. You can switch plugin branches or releases there without changing the `local` cache path. Keep documentation checkouts in a separate worktree.

Root files such as `models.json` and `README.md` use hardlinks. Git checkouts and editors that replace files can break their connection to the cache. After a checkout, relink each root file by removing only its cache file and creating a new hardlink to the checkout. New top-level files or directories also need links. Edits inside the linked `skills` and `hooks` directories do not need this step.

Avoid plugin reinstall, upgrade, or uninstall commands while this setup is active. Those operations can replace the linked installation. To return to the copied installation, stop Codex, move the whole `local` directory outside the cache, and restore the preserved copy to its original installed path.

## Edit these directions separately

From the plugin checkout, create a documentation worktree after fetching the branch from our fork.

```powershell
git fetch origin docs/local-development
git worktree add ../pstack-local-dev-docs docs/local-development
```

Edit and commit this guide in that worktree. Push `docs/local-development` only to `origin`. Keep its history separate from the plugin branches and upstream.

## Run the Codex live test

Run the test from the plugin checkout containing `tests/codex/live.test.mjs`. The documentation worktree contains only this guide.

`tests/codex/live.test.mjs` runs one live Codex session to check native plugin installation and skill invocation with a minimal fixture. It follows the [official plugin evaluation example](https://developers.openai.com/cookbook/examples/partners/harness_aware_plugin_evals/harness_aware_plugin_evals) and [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins). It checks an exact random marker stored only in the skill body. This covers plugin discovery and invocation; pstack workflows, delegation, and hooks need separate cases.

The test skips unless explicitly enabled. With `codex` on `PATH`, use `PSTACK_CODEX_LIVE=1 bun test tests/codex/live.test.mjs` in a POSIX shell, or `$env:PSTACK_CODEX_LIVE='1'; bun test tests/codex/live.test.mjs` in PowerShell. It uses an isolated `CODEX_HOME` and copies only `auth.json` from the original `CODEX_HOME` or `~/.codex`, or logs in with `CODEX_API_KEY` or `OPENAI_API_KEY`. Missing credentials or CLI fail an enabled run. The default model is `gpt-6-luna` at `xhigh` effort; `PSTACK_CODEX_LIVE_MODEL` overrides the model.

`PSTACK_CODEX_LIVE_KEEP=1` preserves temporary artifacts, including CLI version, JSONL stdout, stderr, and final reply, but always removes the copied credentials. Verified on Windows with Codex CLI 0.163.0. The test uses its experimental `skip_host_skill_discovery` feature to exclude host skills and its unelevated Windows sandbox for read-only skill access. CI leaves the live test disabled.
