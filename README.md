# PixelMarch Terminal

Multi-workspace terminal manager. Tauri 2 (Rust) + React/Vite frontend.

Runs from source: the runtime profile is `<repo>/data` (see `src-tauri/src/state.rs`),
so models, workspaces, hotkeys, macros and screenshots all live in this checkout.

## Build & run

```sh
bash scripts/run.sh            # release: build what changed, then launch
bash scripts/run.sh --debug    # debug profile: builds fast, runs slower
bash scripts/run.sh --dev      # tauri dev: vite HMR for frontend work
bash scripts/run.sh --check     # report toolchain + build state only
```

Needs `git`, `node`, `npm`, `cargo`. Linux system deps: `bash scripts/linux-setup.sh`
(add `--voice` for the whisper/cpal build deps — the `voice` feature is on by default;
build with `--no-default-features` to skip libclang + CMake).

Packaging: `bash scripts/package-linux.sh` emits `dist-zip/pixelmarch-<version>-linux-<arch>.zip`.

## Layout

- `src-tauri/` — Rust: PTY, host sidecar, macros (KeyForge), voice, OCR, screenshots, BigBrain, licensing client
- `src/` — React frontend (xterm.js, zustand)
- `scripts/` — build/run/package
- `docs/` — `ipc.md` (frontend↔Rust commands), `linux.md`
- `packaging/`, `legal/` — inputs for the zip

The in-app updater does `git pull` + rebuild (`src-tauri/src/update.rs`); point this
repo at a remote before using it.
