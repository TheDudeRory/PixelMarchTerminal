# PixelMarch

**PixelMarch is a multi-workspace terminal manager for running and supervising swarms of coding agents.** It is a Tauri 2 desktop app: a Rust core owns your terminals, a built-in shared memory service, and a git-backed swarm guard; a React 19 + TypeScript frontend (xterm.js + zustand) gives you the workspaces, panes, and swarm dashboards on top.

It is not a terminal emulator in the usual sense. It is a control surface for a team of CLI agents — Claude Code, Codex, Gemini CLI, OpenCode, Aider, Pi — that share one long-term memory (BigBrain), one task bus, and one set of git-enforced rules, while your actual shell sessions live on in a detached host process that outlives the GUI.

- **Persistent terminals** — sessions run in a detached `--host` process, keyed by pane id. Quit the app, update, crash, restart: the shell reattaches where it left off.
- **BigBrain, embedded** — a localhost HTTP + MCP memory service with per-project markdown notes, a task bus, swarm chat, and agent lifecycle events. One token in the URL is the whole credential.
- **Swarm orchestration** — launch a mission and PixelMarch provisions a grid of role-typed agent panes (coordinator, scout, builders, reviewers), writes the mission and role briefs as brain notes, and watches the swarm for stalls, runaways, and finished cycles.
- **Runs from source** — the checkout *is* the install. State lives in `<repo>/data`, and "update" is `git pull --ff-only` + rebuild. No exe swapping, no app-data dir to hunt.
- **Screenshots + OCR** — per-monitor capture, snip/crop overlays, and terminal-aware OCR that reads colored tracebacks off dark backgrounds.
- **System monitor pane** — CPU, memory, GPU (NVIDIA via NVML), and network sparklines polled from Rust.

---

## Table of contents

- [Quick start](#quick-start)
- [Development](#development)
- [Building and packaging (Linux)](#building-and-packaging-linux)
- [Updating](#updating)
- [Data directory](#data-directory)
- [Architecture](#architecture)
  - [The detached terminal host](#the-detached-terminal-host)
  - [BigBrain](#bigbrain)
  - [Swarm orchestration](#swarm-orchestration)
  - [Screenshots and OCR](#screenshots-and-ocr)
  - [Profiles](#profiles)
- [Keybindings](#keybindings)
- [Linux notes](#linux-notes)
- [Security model](#security-model)
- [Testing](#testing)
- [Repository layout](#repository-layout)
- [License](#license)

---

## Quick start

PixelMarch runs from its source checkout. Everything you need at runtime is on your machine: `git`, `node`/`npm`, and `cargo` — the same toolchain the in-app updater uses.

### Prerequisites

| Requirement | Notes |
|---|---|
| `git`, `node`, `npm` | Checked by *running* them, not `command -v` — a node that can't load its shared libraries after a partial system upgrade fails the check with a hint (`sudo pacman -Syu` on pacman systems). |
| `cargo` (Rust) | First build compiles `webkit2gtk-4.1`-backed Tauri: expect several minutes on a cold target dir. |
| Linux additionally | X11 or XWayland session, `webkit2gtk-4.1` dev files (Tauri 2 requirement — **not** the legacy 4.0 package). See [Linux notes](#linux-notes). |

### Run it

```bash
git clone https://github.com/TheDudeRory/PixelMarchTerminal.git
cd PixelMarchTerminal
bash scripts/run.sh
```

`scripts/run.sh` is the one entry point. It checks the toolchain, builds only what changed (frontend → `dist/`, then cargo), detects a conflicting already-running instance, and launches:

```bash
bash scripts/run.sh            # release build (the only profile with fast-enough PTY + OCR)
bash scripts/run.sh --debug    # debug profile — fast relink, for editing src-tauri/**
bash scripts/run.sh --dev      # tauri dev: vite HMR, for editing src/**
bash scripts/run.sh --rebuild  # force the frontend build even if dist/ looks current
bash scripts/run.sh --no-build # launch what is already built
bash scripts/run.sh --check    # report toolchain + build state, then stop
bash scripts/run.sh -- --host  # pass arguments through to the app
```

On first run a one-time welcome screen appears (it is shown only when no state file exists at all). Your layout, profiles, and settings persist to `data/pixelmarch.json`.

---

## Development

Pick the loop that matches what you are editing — the difference is minutes:

| You are editing | Use | Why |
|---|---|---|
| `src/**` (frontend) | `bash scripts/run.sh --dev` | Vite HMR; no Rust rebuild at all. Rust side is a debug build, so the first start is slow and terminals feel it. |
| `src-tauri/**` (backend) | `bash scripts/run.sh --debug` | Cargo relinks in seconds instead of minutes. |
| nothing (just using it) | `bash scripts/run.sh` | Release is the only profile whose PTY and OCR paths are fast enough to live in. |

Useful details:

- The script asks **cargo** where the target dir is (`cargo metadata`), because `.cargo/config.toml` may redirect `target-dir` off the volume the source lives on. A wrong guess would launch a binary from *before* the build while reporting success.
- `npm ci` runs only when the lockfile is ahead of what is installed.
- Building cargo directly? `--features custom-protocol` is **not** optional: without it the binary silently ignores `dist/` and tries to load the dev server (a window reading "Could not connect to localhost").
- Frontend unit tests: `npm test` (vitest). Rust tests: `cargo test` in `src-tauri/`.
- A second GUI cannot start while one is running (Tauri single-instance, keyed on the bundle identifier). The script detects this and tells you, because the failure mode otherwise reads as "my changes did nothing." The detached `--host` process is *not* a second GUI — it is expected.

---

## Building and packaging (Linux)

Three scripts, each owning one concern:

```bash
./scripts/linux-setup.sh                 # dev/CI build-env bootstrap (Debian/Ubuntu + Fedora)
./scripts/linux-setup.sh --build         # deps, then a portable build to verify

bash scripts/linux-build.sh              # one-shot native build on THIS machine
bash scripts/linux-build.sh --bundle     # also produce deb/rpm/AppImage
bash scripts/linux-build.sh --deps-only  # install deps and stop

bash scripts/package-linux.sh            # fresh release binary + CLEAN zip
bash scripts/package-linux.sh --no-build # package the binary already built
```

- **`linux-setup.sh`** targets Ubuntu 24.04+ / Debian 13+ / Fedora 39+ (all ship `webkit2gtk-4.1`). It is a build-env script for dev boxes and CI — end users never run it.
- **`linux-build.sh`** is Arch/CachyOS (`pacman`) first-class, with `apt`/`dnf` delegated to `linux-setup.sh`. If the checkout sits on a filesystem that cannot host `node_modules`/`target` (FAT/NTFS/exFAT/CIFS/9p…), it mirrors the repo (including `.git` — `build.rs` shells out to git to stamp the binary with the commit sha) to a scratch dir needing ~15 GiB, and builds there. Output: `dist-bin/pixelmarch` next to the repo.
- **`package-linux.sh`** emits `dist-zip/pixelmarch-<version>-linux-<arch>.zip`. It stages an explicit **allow-list** of six small files plus the binary, one `cp` per line — never a directory copy — because the runtime profile holds personal settings, brain notes, and screenshots that must not ship in a release.

Bundle targets are `"all"` in `tauri.conf.json` (deb/rpm/AppImage on Linux, MSIX/NSIS on Windows).

---

## Updating

There is no binary downloader. The app runs from source, so an update is:

```text
git pull --ff-only   →   rebuild what changed   →   relaunch
```

- The updater shells out to the same `git`/`npm`/`cargo` the install used, which is why a box that cannot run `scripts/run.sh` cannot update either.
- Terminals survive an update: they belong to the detached host, not the GUI that is being replaced (see [below](#the-detached-terminal-host)).
- Trust model: updates are only as trustworthy as your git remote's access control. A fast-forward pull from a remote you control.
- `build.rs` stamps each binary with the git commit sha, so you can always tell which build you are running.

---

## Data directory

Everything the app writes lives in one gitignored folder: `<repo>/data`. The whole app — code and state — travels in one directory; a wipe is one `rm -rf data`.

```text
data/
├── pixelmarch.json            # app state: workspaces, layout, profiles, keymap, settings
├── brain/                     # BigBrain notes: <project>/<key>.md
│   └── <project>/
│       ├── project_settings   # the canonical architecture+conventions note
│       ├── mission            # swarm mission (swarm projects)
│       ├── role-<role>        # per-role briefs (swarm projects)
│       └── ...
├── screenshots/               # capture history; never pruned
├── webview/                   # WebKitGTK webview state (redirected here, see Linux notes)
├── pixelmarch-brain.token     # brain credential (mode 0600), minted per launch
├── pixelmarch-brain.url       # ready-to-use base URL, token included
├── pixelmarch-host.pid        # detached host process id
├── pixelmarch-host.port       # host TCP port
└── pixelmarch-host.token      # host protocol credential (mode 0600)
```

The profile location is decided in one place (`src-tauri/src/state.rs: repo_root()`), by walking up from the binary and proving the directory is a PixelMarch checkout (has `src-tauri/Cargo.toml` **and** `package.json`) — not merely a parent of the binary.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ GUI process (Tauri 2 + WebKitGTK)                                        │
│                                                                          │
│  React 19 frontend (src/)                Rust core (src-tauri/src/)      │
│  ┌────────────────────────────┐          ┌────────────────────────────┐  │
│  │ layout store (zustand)     │  invoke  │ ipc surface                │  │
│  │ workspaces ▸ tab groups ▸  │◄────────►│ pty_*  → host client       │  │
│  │ panes (terminal | monitor) │  events  │ screenshots / sysmon       │  │
│  ├────────────────────────────┤          │ profiles / state / shells  │  │
│  │ swarm layer                │          ├────────────────────────────┤  │
│  │ launch · dispatch · health │          │ host.rs    PTY host (lib)  │  │
│  │ mission tree · chat · grid │          │ brain/     BigBrain server │  │
│  ├────────────────────────────┤          │ swarm.rs   git enforcement │  │
│  │ xterm.js panes             │          │ ocr.rs     screenshot OCR  │  │
│  │ tiered: full ↔ headless    │          │ update.rs  git pull+rebuild│  │
│  └────────────────────────────┘          └───────────────┬────────────┘  │
└──────────────────────────────────────────────────────────┼───────────────┘
                                                           │ localhost TCP
                                                           │ (token auth,
                                                           │  length-framed JSON)
┌──────────────────────────────────────────────────────────▼───────────────┐
│ Detached host process  (same binary, --host)                             │
│  owns every PTY / piped-stdio child, ring-buffer replay, flow control;   │
│  also owns BigBrain (port 8734 + fallbacks)                              │
└──────────────────────────────────────────────────────────────────────────┘
```

### The detached terminal host

`src-tauri/src/host.rs` + `hostclient.rs`. Terminals are not children of the GUI; they are children of a sidecar launched as `pixelmarch --host`, detached so it outlives GUI restarts, updates, and crashes.

- **Reconnect, don't respawn.** The GUI proxies every `pty_*` command to the host, keyed by *pane id*. Reopening a pane after a GUI restart attaches to the same running shell (the frontend only had to switch from "spawn → new id" to "open(paneId)").
- **Ring-buffer replay.** On (re)connect the host replays the tail of each session's output, so a reattaching xterm pane is repainted from real data, not blank.
- **Transport.** Localhost TCP, token-authenticated, length-framed JSON. The port and token are written to `data/` on startup; the GUI reads them. The host binds to loopback only.
- **Flow control.** `pty_pause`/`pty_resume`: the GUI pauses the host's read when a terminal's render queue backs up and resumes when it drains, so the child process is throttled to what the terminal can actually paint. Unknown-frame tolerant: a GUI with flow control talking to an older host degrades to always-on.
- **Quit semantics.** *Close all & quit* kills every terminal and stops the host. *Detach quit* exits only the GUI, leaving terminals running for the next launch.
- **One writer thread.** Outbound frames go through a dedicated writer thread: the command side only does a channel push, so one keystroke can never queue behind an open/resize/close on the main thread.

### BigBrain

`src-tauri/src/brain/` — the embedded long-term memory service. It runs **in the host process** (the host owns it even in detach-quit), on loopback, default port **8734** with a small fallback range so a stale listener doesn't block startup.

**Storage.** Notes are plain files: `data/brain/<project>/<key>.md`. Project is the working folder's name; omit it and notes land in the shared `_system`. No database — `recall` is a prefix/AND search over the files, and a note you can `cat` is a note you can diff, grep, and commit.

**Credential.** The token is in the URL itself: `http://127.0.0.1:8734/t/<token>/...`. The token is minted fresh on every launch and written to `data/pixelmarch-brain.token` (mode 0600); `data/pixelmarch-brain.url` is the ready-to-use base. You can also send `X-Brain-Token` as a header to keep the token out of shell history. `GET /version` answers without a token (build stamp + `capabilities`), so any client can identify what it is talking to. It is explicitly *not* a sandbox: a process running as you can read the token file and is therefore trusted.

**API** (one line each; the server serves its own full guide at `GET /info`, with deep-dive sections at `GET /info/<section>`):

```text
GET  /version (no token) · /info · /info/<section> · /projects · /keys?project=
     /recall?project=&(q=|key=) · /memory/<p>/<k>
     /tasks?project=&status=&role=&owner=&mine=&compact=1 · /wait (long-poll)
     /chat?project=&role=&since= · /resets?project= · /reclaims?project=
     /agent-events?project=&since=<seq>   (lifecycle hooks ring buffer)
POST /memory/<p>/<k> (body = note) · /remember · /forget · /forget-project
     /patch (edit ONE note in place) · /replace (bulk sweep, DRY RUN until apply=1)
     /task · /claim · /task-status · /chat · /reset-request · /reclaim-request
     /mcp (JSON-RPC) · /info (override THIS page; empty body restores built-in)
```

**The task bus.** `/task` creates, `/claim` takes (claim collisions come back as `claimed:false` with a reason, not prose), `/task-status` moves a task through its life: `open → claimed → done / approved / changes / blocked`, ending in `merged` or `cancelled`. Builder tasks default to `blocked` until explicitly opened; `/wait` long-polls for a matching task so agents don't busy-poll. File-overlap refusal stops two agents from claiming work that touches the same files. Two statuses are host-side by design: `merged` is posted only by the host after the merge gate runs (an agent-side "merged" is how a builder once self-merged past review), and `cancelled` is a human decision at the mission board.

**MCP.** `brain/mcp.rs` speaks Model Context Protocol (streamable HTTP, POST-only JSON-RPC, protocol version 2025-06-18 with older versions answered in their own terms) on the *same* listener, *behind the same* token — one more path into the same bus, not a second bus. Twelve tools: `tasks_list`, `task_create`, `task_claim`, `task_status`, `note_get`, `note_set`, `note_patch`, `recall`, `chat_send`, `chat_inbox`, `reset_request`, `plan_get`. An agent whose CLI speaks MCP gets typed results; one that doesn't keeps `curl`ing the routes, and the two see the same state note for note. (The tool set is deliberately frozen: the schemas are injected into every turn of every MCP pane, so a new tool has to earn its place.)

**The agent loop it encodes.** ① RECALL before reading code (`project_settings` first — the canonical architecture+conventions note every project keeps — then a topic recall). ② REMEMBER after anything non-obvious: a fact + location (`file:line`), not a saga. Notes outlive context clears; recalling one beats re-reading code to relearn what an agent already wrote down.

The frontend reaches the brain two ways: Tauri commands for in-app UI (no HTTP), and a shared brain *feed* subscription (`lib/ipc.ts`) for live task/notes data — the webview is cross-origin to `:8734`, so no direct fetch from the UI.

### Swarm orchestration

The swarm feature treats **brain notes as the swarm's durable state** and terminals as disposable workers.

**Roles.** Panes in a swarm workspace carry typed roles: `coordinator`, `scout`, `builder-N`, `reviewer-N` (up to 4 reviewers). Roles are assigned at launch but can be changed on any pane afterwards (per-pane "set role" menu) — a pane closed by accident, an agent moved to another CLI, or a human shell promoted to a reviewer all have a way back short of relaunching.

**Launch** (`src/lib/swarmLaunch.ts`, shared by the dialog and the headless CLI — one launch path, two fronts): repo prep → write the mission, `role-*` briefs, protocol sections, and on-complete notes into a fresh BigBrain project → register agents → install the git guard → create the grid workspace whose panes spawn from the notes. The notes written are the swarm; panes and dispatcher only ever read them back.

**Per-CLI capabilities** (`AGENT_CAPS` in `src/lib/swarm.ts`), claimed only when verified against the installed binary:

| capability | meaning |
|---|---|
| `hooks` | CLI fires lifecycle hooks curling the brain on session start / prompt submit / turn end / notification → real turn boundaries instead of PTY-silence guesses (`/agent-events`) |
| `mcp` | CLI loads an MCP config we hand it → typed task bus instead of curl |
| `headless` | CLI runs as a piped-stdio process with a JSON event stream (`-p --input-format stream-json --output-format stream-json`) |

**Headless panes.** A piped-stdio worker has no TUI — its xterm buffer holds raw stream-json. PixelMarch keeps the raw stream (loggable, dumpable, greppable) and renders a **transcript** on top: one row per assistant message, tool call, tool result, turn boundary, error, with token accounting. The control path (`lib/agentStream.ts`) answers "is the turn over" from the stream's `result` object; the transcript path is a second, independent reader over the same bytes.

**Render tiering.** While the **Swarm Summary Grid** is up, the normal layout is unmounted: every pane is demoted to `@xterm/headless` (real buffer, zero renderer), the app pays nothing to display N agents, and one click on a card mounts exactly one full terminal. Tiering is tier-agnostic by design: `tailText(paneId, n)` works on headless panes because they keep a real buffer.

**Watchers** (run for every swarm workspace, active or not):

| watcher | file | catches |
|---|---|---|
| dispatch | `src/lib/swarmDispatch.ts` | host-driven wake strategy: who to wake, with what, when work for that role exists |
| auto-nudge | `src/lib/swarmNudge.ts` | transient API failures (529 / rate limit / 5xx) that abort a turn mid-work: pane output-quiet with an API error at the tail → types "continue". Guard-railed: idle threshold, cooldown, max tries per episode, never nudges a pane whose hooks say it is mid-turn |
| runaway watchdog | `src/lib/swarmRunaway.ts` | local models with no turn budget (LM Studio, ollama) that spiral: pane continuously busy for the window *and* tail unchanged once volatile glyphs (spinners, timers, token counters) are stripped |
| context reset | `src/lib/swarmReset.ts` | stateless-worker resets: an agent that posts `reset-<role>` gets its CLI context wiped (`/clear`, `/new` — per CLI) and re-briefed, so every cycle starts with a fresh context window. All durable state lives in notes, never in the terminal's context |

**Surfaces.** Health strip (per-agent chip: booting/idle/working/stalled, owned task, time since output — fed by the shared brain feed + `terminalPool.lastOutputAt`, no component-local timers), mission tree (live task board rendered from the task bus), chat bar (messages injected into the target agent's terminal *and* mirrored as `chat-*` notes, so replies appear without PTY parsing; split into a durable human↔coordinator channel and agent chatter), and the summary grid.

**Git enforcement.** `src-tauri/src/swarm.rs` enforces the swarm's merge discipline host-side: worktree isolation, a merge gate, hooks, ownership, and stray-change handling — the rules an agent might talk itself out of are enforced by the machine.

### Screenshots and OCR

- **Capture** (`screenshot.rs`): every physical monitor to its own PNG in `data/screenshots/` (millisecond timestamp + monitor index), no stitching. Linux Wayland capture is hand-rolled (`wayland_shot.rs`): KWin's `ScreenShot2` first (no dialog, what Spectacle uses), then the xdg-desktop-portal Screenshot portal once for the whole desktop, cropped per monitor — because xcap's Wayland path fails on Plasma and a rootless XWayland root window cannot see Wayland-native windows.
- **Snip**: one borderless always-on-top overlay per monitor (`snip-<idx>`, `index.html?snip=1`); drag a region to crop, Esc to skip. Post-capture crop editor too. The newest shot is a thumbnail pinned bottom-left; drag it into any text-accepting window to drop its path.
- **OCR** (`ocr.rs`): Windows uses the built-in WinRT engine (`Windows.Media.Ocr`); elsewhere it shells out to `tesseract`. Terminal shots get a pre-pass: OCR engines binarize on *luminance*, and a saturated-red traceback on black is dim by that measure — so the image is rebuilt on max-channel brightness (saturated red reads as white), inverted, contrast-stretched, and upscaled. Multiple scales are merged by vertical position, keeping the fullest reading of each row.
- **Gallery**: paged history grid over the never-pruned `screenshots/` folder, with the same per-shot actions as the thumbnail.

### Profiles

- **Shell detection** (`shells.rs`): Windows offers PowerShell, PowerShell 7, Command Prompt, Git Bash, and every WSL distro; other platforms offer `$SHELL` plus bash/zsh.
- **CLI profiles**: named startup commands (shell, working dir, env) for the agents — the BigBrain block can be written into known agent-config files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `GEMINI.md`, or any path) so any CLI pointed at a repo gets the same memory instructions.
- **Pane profiles**: each pane can carry its own profile; the layout persists per-workspace.

---

## Keybindings

**Global (OS-level, work with the window hidden)** — owned by Rust, editable in Settings:

| shortcut | default | action |
|---|---|---|
| summon/hide | `Ctrl+Alt+`` ` (or `Cmd`) | toggle the main window |
| screenshot | `Ctrl+Alt+S` (or `Cmd`) | capture every monitor |

**In-app** — persisted keymap, editable per action in Settings → Keybinds:

command palette · settings · find in scrollback · about/shortcuts · zoom in / out / reset · split right · split down · new tab · close pane · zoom/restore pane · toggle broadcast · BigBrain · equalize splits · move focus left / right / up / down

---

## Linux notes

- **X11 only (in practice).** `main.rs` forces `GDK_BACKEND=x11` and applies WebKitGTK workarounds; an X11 or XWayland session is required. Under Wayland the app runs as an XWayland client, which is also why screen capture can't use the X11 grab path and instead goes through KWin/portal (see [screenshots](#screenshots-and-ocr)).
- **WebKitGTK 4.1** is the Tauri 2 requirement — not the legacy 4.0 package. Ubuntu 22.04 only has 4.0; upgrade or backport first.
- **Webview state redirection.** `main.rs` redirects the WebKitGTK webview cache/state into `data/webview/` (portable-webview-state) so the profile stays in the one gitignored folder — important when the checkout lives on a small or network volume.
- **Building off-volume.** Checkouts on FAT/NTFS/exFAT/CIFS/9p/VM shared volumes are mirrored to scratch (`scripts/lib/scratch.sh` picks the root and checks free space) before building; `.git` comes along for the commit-sha stamp.

---

## Security model

PixelMarch is a single-user local tool, and its security model says so plainly:

- **Brain + host bind to loopback only.** Both credentials are minted per launch, written `0600` next to the profile. A process running as *you* can read them and is therefore trusted; the token protects against other local users and stray listeners, not against you.
- **MCP has no separate auth code** — it is reached on the brain's own listener, after the token check, so it cannot drift from the rest of the bus.
- **Path containment is canonicalized.** File operations on `screenshots/` (and brain notes) resolve symlinks and `..` *before* the containment check, so a symlink inside the folder pointing anywhere on disk is rejected.
- **Updates** are a `--ff-only` pull from your git remote: the trust boundary is your remote's access control.
- **Swarm git enforcement** is host-side (`swarm.rs`), not advisory.

---

## Testing

- **Rust**: `cd src-tauri && cargo test`. The brain (routes, MCP, patch/replace semantics, token/auth), host protocol (framing, replay, security), swarm guard, and screenshot path containment all carry test suites.
- **Frontend**: `npm test` (vitest).
- The codebase is comment-heavy by design: non-obvious "why" is written down at the site (the brain's `info` text, the host protocol, and the swarm watchers are good examples to read).

---

## Repository layout

```text
├── src/                      # React 19 + TypeScript frontend (Vite)
│   ├── App.tsx               # composition root: panels, overlays, central key handler
│   ├── components/           # BigBrain, swarm (dialog/health/mission/chat/grid/summary),
│   │   │                     # screenshots (gallery/overlay/crop/thumb/snip), settings,
│   │   │                     # profiles, palette, sidebar, toolbar, panes/…
│   ├── lib/                  # ipc.ts (the typed invoke/listen bridge), swarm*.ts,
│   │                         # terminalPool.ts, agentStream/agentTranscript/agentEvents,
│   │                         # persist.ts, layout-tree.ts, profiles, cliProfiles…
│   └── stores/               # zustand: layout (workspaces/panes/keymap), swarmTelemetry
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # entry; --host mode; Linux WebKit/X11 workarounds
│   │   ├── lib.rs            # Tauri app wiring, global shortcuts, tray, commands
│   │   ├── host.rs           # detached PTY session host (TCP, replay, flow control)
│   │   ├── hostclient.rs     # GUI-side client for the host
│   │   ├── pty/              # PTY spawn options; "pty" vs "piped" (headless) modes
│   │   ├── brain/            # BigBrain: notes, task bus, chat, HTTP server, mcp.rs
│   │   ├── swarm.rs          # host-side git enforcement for swarm agents
│   │   ├── screenshot.rs     # per-monitor capture + snip overlay windows
│   │   ├── wayland_shot.rs   # KWin / xdg-portal Wayland capture
│   │   ├── ocr.rs            # WinRT / tesseract OCR + terminal pre-pass
│   │   ├── sysmon.rs         # CPU/mem/GPU(network) metrics (sysinfo + NVML)
│   │   ├── shells.rs         # shell detection (incl. WSL on Windows)
│   │   ├── state.rs          # portable persistence: <repo>/data, atomic IO
│   │   ├── update.rs         # source-based updater: git pull --ff-only + rebuild
│   │   └── notify.rs         # desktop notifications
│   └── tauri.conf.json
├── scripts/
│   ├── run.sh                # THE way to run: build what changed, then launch
│   ├── linux-setup.sh        # build-env bootstrap (Debian/Ubuntu/Fedora)
│   ├── linux-build.sh        # one-shot native build (+ optional bundle)
│   ├── package-linux.sh      # clean release zip
│   └── lib/scratch.sh        # off-volume build mirror logic
├── packaging/                # desktop file, launcher, install notes
├── data/                     # runtime profile (gitignored) — see [Data directory](#data-directory)
└── images/                   # logo/screenshot assets
```

---

## License

MIT — see [LICENSE](LICENSE).
