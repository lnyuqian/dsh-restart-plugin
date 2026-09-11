# DSH Restart Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/lnyuqian/dsh-restart-plugin)](https://github.com/lnyuqian/dsh-restart-plugin) [![GitHub last commit](https://img.shields.io/github/last-commit/lnyuqian/dsh-restart-plugin)](https://github.com/lnyuqian/dsh-restart-plugin)

🌏 [English](README_EN.md) · [简体中文](README.md)

One-click restart for DeepSeek Harness Web (`127.0.0.1:3080`): a single sidebar button, a 10-second countdown, and the whole "kill old process → boot a fresh instance → self-check → reload the original page" chain runs itself. It turns "open a terminal, remember the steps, gamble on luck" into "click once, wait 10 s, read the result".

- **No popup windows** — wscript silently launches the restart, no PowerShell console ever appears on the desktop
- **No terminal work** — no shell / Task Manager / manual PID hunting / typed commands
- **No new tab** — the restart boots with `--no-open`, the original tab auto-reloads at the end

## The pain: restarting without this button

DSH Web is a resident host process — plugin edits, config changes and new bundles only take effect after a restart, and "restarting well" is often the answer to any weird state. But every restart currently involves a manual chain:

1. Open a terminal or Task Manager and reverse-look-up the host PID listening on 3080;
2. Kill it with `Stop-Process` (the PID changes every time; killing the wrong one is risky);
3. Find the launcher script and boot the service again;
4. Wait a few seconds and poll the port until it listens;
5. Verify a plugin route actually loaded (e.g. `/_dsh/dsh-restart/state`) before calling the restart "successful";
6. Manually reload the browser page, perhaps accepting an unwanted new tab.

That is 5-8 steps across several windows with **zero feedback** in between — you never know which step it is on, or whether it failed. More steps means more ways to break, and every failure starts over from scratch.

## The solution: one click does it all

This plugin collapses the whole chain into one sidebar button:

![Sidebar bottom "settings" and "restart" buttons (expanded)](docs/sidebar-restart-button.png)

- **Dual-state button**: in the expanded sidebar it sits right of "Settings" as [↻ Restart]; in the collapsed rail it becomes a round ↻ icon above the settings gear, syncing and animating with the sidebar in real time;
- **Click and go**: triggers a 10-second countdown; page text dims to light-grey as in-progress feedback (the button itself keeps its vivid color);
- **Fully automatic**: a scheduled task silently kills the old process → boots a fresh instance → self-checks (3080 listening + `GET /_dsh/dsh-restart/state` + `GET /`);
- **Original page wrap-up**: after a successful self-check the original tab auto-reloads and a green "✅ Restart OK" toast appears top-right; on failure the button turns red for a one-click retry;
- **Models can trigger it too**: just say "restart" in the conversation (`dsh_restart` tool) — handy when the current turn needs to wrap up.

## ✨ Features

- Dual-state sidebar button (expanded text / collapsed icon), survives React re-renders, no drift on collapse/expand
- 10 s countdown + page-text dimming + button state machine (restarting / failed-retry)
- Silent launch: **no popup window, no terminal, no new tab**; original page auto-reloads
- Self-check driven: port + plugin route double verification, toast only on success, retry on failure
- Conversation trigger: `dsh_restart` tool (agent side)

## 🚀 Installation

The plugin has **two parts**, both required:

1. **The plugin package** (this repo) — the client sidebar button plus the host `/_dsh/dsh-restart/state|trigger` routes and the `dsh_restart` tool;
2. **The restart script chain** — the actual "kill → boot → self-check" work lives in 3 local scripts (`.ps1` / `.vbs` / `.bat`) plus 1 scheduled task, **not shipped in the npm package**; deployable templates are provided under `docs/setup/`.

> **Path convention**: `InstallDir` (the script deployment directory) and all command examples below are generic — substitute your own local paths. `dsh plugin --profile web` commands act on the DSH web profile (`~/.dsh/profiles/web`).

### Prerequisites

| Item | Requirement |
|---|---|
| OS | **Windows only** (host end depends on `schtasks` / `wscript` / PowerShell; Linux / macOS not supported) |
| DSH Web | `@deepseek-ai/dsh` installed and `dsh web` runnable (0.1.0-rc.x) |
| Node.js | ≥ 24.11 (`package.json` engines; the Node shipped with DSH is fine) |
| Permissions | Current user may create scheduled tasks (default for an ordinary user's own tasks) |
| Optional | None (the self-check probe uses this plugin's own `/_dsh/dsh-restart/state` route; no third-party plugin is required) |

### Step 1: register the plugin package

```powershell
# Option A: clone and register via the pnpm link: protocol (recommended
#           if you want to tweak code / host constants later)
git clone https://github.com/lnyuqian/dsh-restart-plugin.git
dsh plugin --profile web add link:.\dsh-restart-plugin

# Option B: install directly from GitHub without cloning
dsh plugin --profile web add git+https://github.com/lnyuqian/dsh-restart-plugin.git
```

`dsh plugin --profile web <subcommand>` is equivalent to running `pnpm <subcommand>` in `~/.dsh/profiles/web`; `add link:<dir>` registers a local directory as a dependency of that profile via pnpm's `link:` protocol. After registering:

1. Stop the running dsh web;
2. Start it again with `dsh web`;
3. Open `http://127.0.0.1:3080` and hard-refresh with **Ctrl+Shift+R**.

You should now see: the restart button in the sidebar, `http://127.0.0.1:3080/_dsh/dsh-restart/state` returning `{"ok":true,...}`, and a `dsh_restart` tool in the tool list. **Clicking the button / calling the tool still fails at this point** — the scheduled task does not exist yet; continue with Step 2.

> If the button does not appear (client bundle not rebuilt): run `pnpm run dev:web` in the DSH source tree (or the equivalent build command) to rebuild the web artifacts, then restart.

### Step 2: deploy the restart script chain (one-shot)

```powershell
cd dsh-restart-plugin
powershell -ExecutionPolicy Bypass -File docs\setup\install.ps1 `
  -InstallDir "$env:USERPROFILE\.dsh-restart" -Seconds 10
```

`install.ps1` does three things automatically:

1. Copies the 3 templates from `docs/setup/` into `-InstallDir` and fills every placeholder with your real paths — `.ps1` is saved **UTF-8 with BOM** (readable by Windows PowerShell 5.1), `.vbs` / `.bat` as **GBK** (so cmd/wscript parse CJK paths correctly on a Chinese-locale system);
2. Registers the scheduled task (default name `dsh-web-restart-20s`, action `wscript.exe "…\restart-dsh-web-silent.vbs"`; wscript's silent launch guarantees no console window);
3. Patches the constants at the top of `lib/index.js` (`LIVE` / `STATUS` / `TASK` / `SECONDS` / `cwd`, plus the path text inside the `dsh_restart` description) to your paths, backing the original up as `lib/index.js.bak`.

Useful parameters: `-InstallDir` (where the scripts live), `-Seconds` (countdown seconds, default 10), `-TaskName` (scheduled task name), `-SkipIndexJsPatch` (do not touch index.js), `-PluginDir` (repo root; auto-detected).

<details>
<summary><b>Step 2 (alternative): manual deployment</b></summary>

**（1) Copy the templates and replace the placeholders** in the 3 files from `docs/setup/`:

| Template | Placeholders |
|---|---|
| `restart-dsh-web.ps1` | `__LOG_FILE__`, `__STATUS_FILE__`, `__LIVE_FILE__`, `__START_BAT__` |
| `restart-dsh-web-silent.vbs` | `__PS1_FILE__`, `__SECONDS__` |
| `dsh-web-restart-start.bat` | `__DSH_CMD__`, `__LOG_FILE__` |

Save with the right encoding: `.ps1` as UTF-8 with BOM, `.vbs` / `.bat` as GBK (system ANSI).

**（2) Register the scheduled task**:

```powershell
schtasks /Create /F /TN "dsh-web-restart-20s" /TR "wscript.exe \"C:\path\to\restart-dsh-web-silent.vbs\"" /SC ONCE /ST 00:00
```

**（3) Fix the `lib/index.js` path constants** (remember `\` must be written `\\` in JS strings):

| Constant | Meaning | Rule |
|---|---|---|
| `LIVE` | live state marker file (client polls restart progress) | must equal `$live` in the script |
| `STATUS` | self-check status log | must equal `$status` in the script |
| `TASK` | scheduled task name | must equal the one used in `schtasks /Create` |
| `SECONDS` | countdown seconds (informational only) | keep consistent with `-Seconds` in the vbs |
| `cwd` (inside `triggerRestart`) | working dir for `schtasks /Run` | any existing directory |

</details>

### Step 3: verify

```powershell
# host route mounted
Invoke-RestMethod http://127.0.0.1:3080/_dsh/dsh-restart/state

# fire one full restart (same as clicking the button)
schtasks /Run /TN "dsh-web-restart-20s"
# after the countdown, inspect the self-check result
Get-Content "$env:USERPROFILE\.dsh-restart\dsh-web-restart-status.txt" | Select-Object -Last 12
# expected last line: self-check verdict: SUCCESS
```

In the browser: click "Restart" in the sidebar → page text dims for 10 s → the original tab auto-reloads → green "✅ Restart OK" toast top-right; on failure the button turns red and can be retried.

> **Self-check probe**: the template probes `GET /_dsh/dsh-restart/state` by default (this plugin's own route, always present while the host runs); a 401/403 on `GET /` (login auth) counts as the server answering, not as failure — only a total lack of an HTTP response is a failure.

### Uninstall

```powershell
dsh plugin --profile web remove dsh-restart-plugin
schtasks /Delete /TN "dsh-web-restart-20s" /F
# remove the -InstallDir directory; restart dsh web + hard refresh
```

<details>
<summary><b>Installation FAQ</b></summary>

| Symptom | Cause & fix |
|---|---|
| Button / tool reports "scheduled task does not exist" | Step 2 was skipped, or `TASK` in `lib/index.js` does not match the registered task name |
| Countdown / paths disagree | `-Seconds` in the vbs, `SECONDS` in `lib/index.js`, `$delay` in the ps1 must agree; the live marker path (ps1 `$live` and index.js `LIVE`) must be identical or the page cannot read restart state |
| `link:` points at an old path | If you moved the plugin directory, re-run `dsh plugin --profile web add link:<new path>`; otherwise the next `pnpm install` re-links the old `link:` record in `package.json` |
| Scheduled task creation fails | Run as a normal user (not `/RU SYSTEM`), or use `/F` to overwrite the same-named task |

</details>

## 🔁 How it works

```mermaid
flowchart LR
  U[User clicks "Restart" in sidebar<br/>or says "restart" to the model] --> T[dsh_restart tool<br/>POST /_dsh/dsh-restart/trigger]
  T --> S[schtasks /Run fires the scheduled task]
  S --> W[wscript silently launches PowerShell]
  W --> C{10 s countdown<br/>page text dims}
  C --> K[Kill the old host on 3080]
  K --> B[Boot a fresh dsh web with --no-open]
  B --> P[Self-check: 3080 listening<br/>GET /_dsh/dsh-restart/state + GET /]
  P --> R{success?}
  R -- success --> X[Original tab auto-reloads<br/>green "Restart OK" toast]
  R -- failed --> F[Button turns red, retry]
```

1. The user asks for a restart (clicks the button, or the model calls `dsh_restart`).
2. The scheduled task `dsh-web-restart-20s` fires (wscript silent launch, no PowerShell window).
3. Page text dims to light-grey while the restart button stays vivid, shows "Restarting…" with a spinning icon; the model replies in one short sentence and ends the turn immediately.
4. When the countdown ends, the script: kills the old host on 127.0.0.1:3080 → boots a fresh instance with `--no-open` (no new tab) → self-checks (3080 listening + `GET /_dsh/dsh-restart/state` + `GET /`).
5. The original page polls for `done+success`, auto-reloads and shows a "Restart OK" toast top-right (auto-dismisses after ~4 s); on failure the button turns red with "Restart failed · retry".
6. If asked about the result afterwards, the status file can be reported (default `InstallDir\dsh-web-restart-status.txt`).

## 🧩 Components

| Part | Path | Description |
|---|---|---|
| Restart script | deploy dir `restart-dsh-web.ps1` (template: `docs/setup/`) | single entry: writes live markers during countdown, kills → boots → self-checks → writes verdict |
| Silent launcher | deploy dir `restart-dsh-web-silent.vbs` (template: `docs/setup/`) | wscript wrapper, never shows a PowerShell window; edit the countdown seconds here |
| Scheduled task | `dsh-web-restart-20s` | fired via `schtasks /Run /TN "dsh-web-restart-20s"` (Interactive only); action points at the silent launcher; name kept for historical reasons, rename freely |
| Boot script | deploy dir `dsh-web-restart-start.bat` (template: `docs/setup/`) | boots the fresh instance with `--no-open`, so no new browser tab; the original page reloads itself |
| Live marker | `InstallDir\.dsh-restart-live.json` | `state=countdown/stopping/booting/done`, `deadline`, `success` verdict; path decided by Step 2, must match `LIVE` in `lib/index.js` |
| Status log | `InstallDir\dsh-web-restart-status.txt` | per-step timeline + final `self-check verdict: SUCCESS/FAILED` |
| Persistent plugin | this repo | host: `GET/POST /_dsh/dsh-restart/state|trigger` routes + `dsh_restart` tool; client: dual-state sidebar restart button, text-dim feedback, auto-reload + toast on success. Linked into `~/.dsh/profiles/web` bundles |

## 🛠️ Development & Build

- **Layout**: `lib/index.js` (host: routes + `dsh_restart` tool), `lib/client.js` (client: sidebar button + countdown UI, zero-dependency DOM implementation).
- **Host changes** (routes/tool/constants): **restart dsh web** to take effect.
- **Client changes**: take effect through the DSH plugin channel — the client bundle is mounted via the profile dependency; with `pnpm run dev:web` running in the DSH source tree hot-reload applies automatically, otherwise follow the rebuild/restart flow in Step 1.
- **No standalone build**: the package has no build step of its own; the client injection (`dsh.client`) and bundle patch (`cordis.patch.yml`) are composed with the profile.
- **Tests**: no automated tests yet — self-check manually per the verification list above: the `/_dsh/dsh-restart/state` route, the sidebar button, the `dsh_restart` tool, and the full restart chain.

## 🔐 Security

- The host routes sit behind a **trust fence**: only loopback sources (`127.0.0.1` / `::1`) with a `Host` of `127.*` / `localhost` / `[::1]` are accepted, and `POST /trigger` additionally requires a same-origin `Origin`; non-local or cross-site requests get `403`.
- The trigger path uses the system scheduled task (`schtasks /Run`) with fixed task name and arguments — no shell concatenation, no command-injection surface.
- The client injects only into the web platform and runs only in the local `http://127.0.0.1:3080` page context.

## 🖥️ Platform Support

| Item | Requirement |
|---|---|
| OS | **Windows only**: the host end hard-depends on `schtasks.exe`, `wscript.exe` and PowerShell — **Linux / macOS not supported** (no equivalent mechanism; the one-click restart chain cannot work without these components) |
| Windows version | Developed and verified on **Windows 11 + Google Chrome**; Windows 10 ships all required components (Task Scheduler / wscript / PowerShell) and is expected to work, though not individually verified |
| Browser | Verified on **Windows 11 + Google Chrome**; Chromium-based (Edge etc.) works too (client uses only standard DOM APIs; the browser side itself is platform-agnostic) |
| DSH Web | Sidebar positioning relies on the CSS Modules class names of the current dsh web build; selectors may need adjustment after DSH upgrades |

## 📋 Changelog

- **v0.1.0** (2026-08)
  - Initial release: dual-state sidebar restart button + 10 s countdown + page-text dim feedback + original-tab auto-reload with "Restart OK" toast; `dsh_restart` tool; host routes `/_dsh/dsh-restart/state|trigger`.
  - Installation docs: README "Installation" section plus deployable templates under `docs/setup/` with the one-shot `install.ps1` (registers the scheduled task, patches `lib/index.js` constants).
  - Docs generalized: components table and command examples no longer contain author-machine paths.

## Usage

- **Page button**: expanded sidebar — "Restart" right of the settings button; collapsed rail — the ↻ icon above the settings gear.
- **Conversation trigger**: just say "restart" to the model (`dsh_restart` tool).
- **Manual trigger**: `schtasks /Run /TN "dsh-web-restart-20s"`.
- **Change the countdown**: edit `-Seconds 10` in `restart-dsh-web-silent.vbs` in the deploy dir, and keep `SECONDS` in `lib/index.js` (and the description text) in sync. If you overwrite the action with `schtasks /Change /TR`, keep `wscript.exe "…\restart-dsh-web-silent.vbs"` — do not point it back at powershell.exe (the window would come back).

## Notes

- The ongoing agent turn must have finished before the countdown ends (the SOP is fixed: the tool returns and the model immediately closes the turn with one short sentence).
- The restart briefly drops the current web session; the original page auto-reconnects and reloads — no new tab.
- The success toast is carried across the reload via `sessionStorage`, shown only in the original tab, and cleared after consumption.
- The persistent plugin takes effect after restart; if the client bundle fails to build, the button/toast are missing but the `dsh_restart` tool and the self-check log still work.

## 🔗 Ecosystem

- [awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin): curated list of DSH plugins
- [dshfind plugin market](https://dshfind.com/zh/plugins): third-party plugin market (public repos under the GitHub topic `dsh-plugin`)

## License

[MIT](LICENSE)