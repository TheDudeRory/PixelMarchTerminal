# IPC surface

Commands are Tauri `invoke` calls; events are emitted from Rust and consumed with `listen`.
`src/lib/ipc.ts` is the typed wrapper: one exported function per command/event, so a
command name only ever appears as a string literal in one place. New calls belong there.

**Where the code actually stands (checked 2026-07-21).** The wrapper is the norm, not the
rule: ~27 modules import it and it covers 52 commands, but these files still call `invoke`
or `listen` directly and always have —

| file | what it calls raw |
|---|---|
| `MacroEditor.tsx` | macro CRUD, device/audio, `screen_pick` — a second wrapper module in all but location |
| `ScreenshotGallery.tsx`, `ScreenshotThumb.tsx`, `ScreenshotCrop.tsx` | screenshot read/OCR/delete/retention/crop, `screenshot-pruned` |
| `ScreenshotOverlay.tsx` | `screenshot-taken` |
| `SnipWindow.tsx` | `snip_source`, `snip_close_all`, `screenshot_save_crop` |
| `VoiceWindow.tsx` | `set_compact` |

Those are **out of scope** for the task that wrote this paragraph and are not going to
vanish because a doc says they should; treat the table as the to-do list it is. Do not
read the sentence above as "already true everywhere" — it was written as an absolute for
years while this list grew, which is exactly how a doc stops being worth reading.

> This file documents the surfaces below. It is **not** the full list — macros,
> hotkeys, screenshots, BigBrain and sysmon are not written up yet. The
> authoritative registry is the `invoke_handler` in `src-tauri/src/lib.rs`.

## Commands (frontend → Rust)

### PTY (`src-tauri/src/pty/mod.rs`)
| Command | Args | Returns | Purpose |
|---|---|---|---|
| `pty_spawn` | `opts: SpawnOpts` | `string` (pty id) | Spawn a shell for a pane |
| `pty_write` | `id, data` | — | Send keystrokes to a pty |
| `pty_resize` | `id, rows, cols` | — | Resize a pty |
| `pty_pause` | `id` | — | Flow control: host stops reading this pty (child blocks once its buffer fills). Sent when a pane's render queue backs up. No-op on a host that predates flow control |
| `pty_resume` | `id` | — | Flow control: host resumes reading this pty, once the render queue drains |
| `pty_close` | `id` | — | Tree-kill a pane's process group |

`SpawnOpts = { rows, cols, shell?, args?, cwd?, startupCommand?, env? }` (camelCase).
The startup command is applied as shell args (`powershell -NoExit -Command …`, `cmd /K …`,
`bash -c "…; exec bash"`, `wsl … -- bash -lic "…"`), which is reliable — typing it into the pty
races the shell's line editor and gets swallowed.

### Persistence & files (`src-tauri/src/state.rs`)
| Command | Args | Returns | Purpose |
|---|---|---|---|
| `load_state` | — | `string \| null` | Read `pixelmarch.json` next to the exe |
| `save_state` | `json` | — | Atomic write (temp + rename) |
| `state_path` | — | `string` | Path of the state file |
| `write_text` | `path, content` | — | Overwrite a file (scrollback dump) |
| `append_text` | `path, content` | — | Append to a file (log-to-file) |
| `logs_dir` | — | `string` | Portable `logs/` dir (created on demand) |
| `backup_corrupt_state` | — | `string \| null` | Move an unparseable state file to `.corrupt-<ts>` |

### Shells (`src-tauri/src/shells.rs`)
| Command | Returns | Purpose |
|---|---|---|
| `detect_shells` | `ShellInfo[]` | Available shells: `{ id, label, path, args }` |

### Voice-To-Text (`src-tauri/src/voice/`)
| Command | Args | Returns | Purpose |
|---|---|---|---|
| `voice_get_settings` / `voice_set_settings` | — / `new: VoiceSettings` | `VoiceSettings` / — | `voice-settings.json` next to the exe |
| `voice_list_mics` | — | `string[]` | Input devices for the mic picker |
| `voice_status` | — | `VoiceStatus` | `{ built, model_present, model_id, model_file, ptt_hotkey }` — `built=false` means the exe was compiled without the `voice` feature |
| `voice_models_status` | — | `VoiceModelInfo[]` | Per-model `{ present, size_bytes, expected_size, complete, selected, url }` |
| `voice_model_download` | `id` | — | Starts a background download; progress arrives as events. HTTPS-only, verified against a pinned size + sha256, written `.part` → rename |
| `voice_model_import` | `id` | `string \| null` | Native picker for a `.bin` you already have; `null` = cancelled |
| `voice_show_window` / `voice_hide_window` / `set_compact` | — / `compact` | — | The voice pill window |

No speech model ships with the app — `voice/models.rs` owns the catalog, the
single `ggml-<id>.bin` path formula, and the installer the settings panel drives.

### Updates (`src-tauri/src/update.rs`)
| Command | Args | Returns | Purpose |
|---|---|---|---|
| `update_configured` | — | `boolean` | False when the checkout has no upstream branch to pull from — the UI disables the check instead of pretending |
| `check_update` | — | `UpdateCheck` | `git fetch`, then `{status:"available",info}` / `{status:"upToDate"}` / `{status:"blocked",reason}` — a checkout that cannot update itself in place (no git, no upstream, detached HEAD), which is NOT the same as being current |
| `apply_update` | — | — | `git pull --ff-only`, `npm ci` (only if the lockfile moved), `npm run build`, `cargo build` — emitting `update-progress` per output line — then stop the terminal host and relaunch the rebuilt binary. Takes **no arguments**: the upstream is read from the checkout, never accepted from the frontend |
| `app_version` | — | `string` | The running build's version, bare (`"0.1.37"`, no leading `v`). Defined in `src-tauri/src/lib.rs:26`, not `update.rs`, but it is `CARGO_PKG_VERSION` from the same crate |

PixelMarch runs out of its own git checkout (`state::repo_root`), so an update is
a pull and a rebuild rather than a downloaded exe swap. There is no update server,
no `latest.json`, no signature and no sha256 in this path any more; the trust
anchor is whoever can push to the checkout's `origin`, because an update **builds
what it pulled**. `update_configured` is false when the branch has no upstream.

All five of these (including the `update-progress` listen) go through `src/lib/ipc.ts` —
`updateConfigured`, `appVersion`, `checkUpdate`, `applyUpdate`, `onUpdateProgress`, with
the `UpdateCheck` / `UpdAvailable` / `UpdateProgressEvent` types beside them. `SettingsModal.tsx`
re-exports the two types its message formatters take. `src/lib/ipc.test.ts` pins the command
names and that `applyUpdate` sends no arguments, since TypeScript cannot check a string literal against Rust.

## Events (Rust → frontend)

| Event | Payload | Purpose |
|---|---|---|
| `pty://data` | `{ id, data }` | Terminal output; `data` is base64 raw bytes (keeps partial UTF-8 intact), coalesced over ~16 ms |
| `pty://exit` | `{ id, code }` | Child exited; `code` is the real exit code (`null` if unknown) |
| `voice-ptt` | `"down" \| "up"` | Push-to-talk key edge |
| `voice-capture` | `{ samples, seconds }` | Capture stats for the pill |
| `voice-model` | `"loading" \| "ready" \| "error"` | Whisper model load state; the settings panel re-reads `voice_status` on it |
| `voice-model-progress` | `{ id, downloaded, total, status, error }` | Install progress: `start`/`progress`/`verifying`/`done`/`error` |
| `update-progress` | `{ step, steps, command, line }` | One line of build output during `apply_update`, throttled to ~60 ms. There is no byte count and no percentage: a build has no knowable total, so `step`/`steps` is the only progress that is true |
| `voice-transcript` | `string` | Formatted transcript for the focused terminal |
| `voice-done` | — | Transcription finished on every path (including "no model"), so the pill resets |

## Plugins

`single-instance` (second launch focuses the window), `notification` (exit alerts),
`global-shortcut` (`Ctrl+Alt+`` ` `` summon/hide), `opener`.
