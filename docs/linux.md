# Linux — build, package, run

> **Note.** The runtime profile is no longer "next to the binary": PixelMarch runs
> from its checkout and everything it writes lives in `<repo>/data`
> (`state::state_dir`). The self-update `.new`/`.old` swap described below is gone —
> updates are `git pull` + a rebuild. The packaging and dependency sections are
> unchanged and still current.

Developer-facing. The doc that ships to users is `packaging/INSTALL.txt` (it goes
in the zip); keep the runtime-dependency lists in the two files in step.

Everything below was re-verified on this box (CachyOS, KDE **Wayland** session,
WebKitGTK 2.52.5) on 2026-07-21.

---

## Build

```bash
bash scripts/linux-build.sh              # install missing deps, then build
bash scripts/linux-build.sh --no-deps    # build only, never touch system packages
bash scripts/linux-build.sh --deps-only  # install deps and stop
bash scripts/linux-build.sh --no-voice   # --no-default-features (skip whisper/cpal)
bash scripts/linux-build.sh --bundle     # also emit deb/rpm/AppImage
bash scripts/linux-build.sh --clean      # wipe the build mirror first
```

Dependency install is **on by default** (`--no-deps` opts out). There is no
`--deps` or `--voice` flag — older notes that mention them are stale.
Output: `dist-bin/pixelmarch`. `npm run pack:linux` is `linux-build.sh --no-deps`.

### The three things that make this checkout special

1. **Builds happen in a scratch mirror, never in `$HOME`.** When the checkout
   sits on a filesystem that cannot host `node_modules`/`target`
   (vfat/exfat/ntfs/cifs/9p/vboxsf — this one is a VeraCrypt vfat volume),
   `linux-build.sh` rsyncs the tree to a scratch directory and builds there,
   then copies the binary back to `dist-bin/`. `node_modules`, `dist`, `exe`
   and `src-tauri/target` are excluded so they stay local to the mirror; `.git`
   is deliberately **not** excluded, because `src-tauri/build.rs` shells out to
   git to stamp the commit sha and without it every build reports "unknown".

   `scripts/lib/scratch.sh` owns where scratch goes, highest priority first:
   `--scratch-dir DIR` > `$PIXELMARCH_SCRATCH_DIR` > the per-purpose legacy
   variable (`$BUILD_DIR` for the mirror, `$CARGO_TARGET_DIR` for the licensed
   target) > `${TMPDIR:-/tmp}/pixelmarch-<purpose>`. It checks free space first
   and **refuses with rc=1**, printing the override command, when the root is
   too small — it never falls back to `$HOME`. That refusal is the designed
   behaviour, not a bug: on this box `/tmp` is a tmpfs with ~2 GiB free and the
   mirror asks for 15 GiB, so a plain `linux-build.sh` correctly stops and asks
   for `--scratch-dir /some/disk/path`. Delete that directory when you are done.

2. **pacman's rustup ships no toolchain.** `cargo` exists but every invocation
   errors. `linux-build.sh:84-89` runs `rustup default stable` when
   `rustup show active-toolchain` comes up empty. And because rustup puts
   binaries in `~/.cargo/bin` — which a non-login shell often lacks —
   `:95-97` sources `~/.cargo/env` and prepends the directory to `PATH`.

3. **The `voice` feature is ON by default** (`src-tauri/Cargo.toml:22`), so
   `libclang` **and** `cmake` are hard build dependencies (whisper-rs).
   `linux-build.sh:106-109` fails fast with that advice; `--no-voice` builds
   without them. No speech model ships — the app downloads one on demand, see
   `src-tauri/src/voice/models.rs`.

Build-time packages (Arch names, from `linux-build.sh:62-67`): `base-devel git
curl wget file webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg patchelf
xdotool libx11 libxrandr libxi libxtst libxfixes libxcb wayland pipewire dbus
alsa-lib xdg-utils libpulse nodejs npm rustup`, plus `clang cmake` for voice.
apt/dnf equivalents live in the same function and in `scripts/linux-setup.sh`.

---

## Package a release zip

```bash
npm run zip:linux                        # scripts/package-linux.sh
bash scripts/package-linux.sh --no-build --out /tmp   # package an existing binary
```

Produces `dist-zip/pixelmarch-<version>-linux-<arch>.zip` from an **allow-list**
of seven files — `pixelmarch` (the launcher, from
`packaging/pixelmarch-launcher.sh`), `pixelmarch-bin` (the real binary),
`INSTALL.txt`, `LICENSE.txt`, `THIRD-PARTY-LICENSES.txt`, `pixelmarch.desktop`,
`pixelmarch.png`.

**Why the binary is not called `pixelmarch` in the zip.** `./pixelmarch` is a
POSIX-sh wrapper that runs the fresh-install checks — exec bit, writable extract
dir, glibc/libstdc++ floor, missing `.so`s mapped to a pacman/apt/dnf command,
XWayland on a Wayland session — and then `exec`s `pixelmarch-bin`. Because it
execs, `current_exe()` is still the binary and its parent is still the extract
directory, so the portable profile layout (`state.rs:13-16`) is unchanged. It
also owns `--install-desktop` / `--uninstall-desktop`, which is how the
`.desktop` entry gets a correct absolute `Exec=`: `packaging/pixelmarch.desktop`
ships as a template with `@EXEC@`/`@ICON@` placeholders, never a baked-in path.
`--check` runs the checks and exits.

Never widen that into an exclude-list, and never package the developer's live
profile directory — the folder the app runs from (settings with
absolute host paths, `brain/` notes, personal screenshots, ~300 MB of
`ggml-*.bin`). `package-linux.sh` refuses to run if its staging directory is
non-empty, and re-checks the staged tree for `*.json`/`*.bin`/`*.exe`/`brain/`
before zipping. It removes the staging directory once the zip is written, so a
second run does not trip its own not-empty guard.

### Verified end-to-end (2026-07-21)

Built with `scripts/package-linux.sh --no-deps`, unzipped into an empty
directory outside the repo, and launched:

* zip contained exactly the six files above (5.7 MB); `ldd` reported no missing
  libraries;
* the fresh profile it created was genuinely fresh — `voice-settings.json` had
  the defaults (`F8`, `base.en-q8_0`, no window position), not this box's
  values (`Pause`, `base.en`, x/y set); `pixelmarch.json` contained no
  `/home` or `/run/media` path;
* no `ggml-*.bin` present, and the app started anyway;
* the first-run welcome appeared, and its button deep-linked to
  **Settings → Voice-To-Text**, which showed "Speech models (0/3 installed)"
  with Download/Browse per model rather than a silent no-op;
* clicking **Download** streamed progress and installed
  `ggml-base.en-q8_0.bin` (81 781 811 bytes, sha256
  `a4d4a076…8c87e`, matching Hugging Face's published LFS etag). The missing-model
  warning cleared without a restart and the section became "1/3 installed".

The one deviation from a true clean-machine run: another PixelMarch was already
running on this box, and `tauri-plugin-single-instance` (`lib.rs:237-244`) would
have handed the launch to it, so the test instance was started under
`dbus-run-session`. Everything else was the real unzipped artifact.

---

## Running

**From the checkout: `bash scripts/run.sh`.** That is the normal way to start
PixelMarch now — it checks the toolchain, rebuilds only what changed, and
launches the result. `--dev` gives vite HMR for frontend work, `--debug` a fast
Rust relink, and no flag a release build. `--check` reports the toolchain, where
the profile and the target dir are, and whether the built binary is still
current, without building anything.

It refuses to launch when a copy is already running, and that refusal is worth
knowing about: Tauri's single-instance plugin keys on the bundle identifier,
which every build shares, so a second start hands its arguments to the first and
exits. The window that surfaces is the OLD build — which looks exactly like a
change that did nothing.

**X11 or XWayland is required.** `src-tauri/src/main.rs:14-22` sets
`GDK_BACKEND=x11` and `WEBKIT_DISABLE_DMABUF_RENDERER=1` before GTK
initialises, because WebKitGTK 2.52 plus the appindicator tray under Wayland
dies with `Error 71 (Protocol error) dispatching to Wayland display` and the
window never appears. Both are only set when unset, so you can override them.
On a pure-Wayland system with no XWayland the app cannot start.

**glibc floor.** The release binary's highest symbol versions are `GLIBC_2.39`
and `GLIBCXX_3.4.31` (GCC 13), so it runs on Ubuntu 24.04+, Debian 13+, Fedora
40+ and rolling distros, and **cannot load at all** on Ubuntu 22.04 (2.35),
Debian 12 (2.36) or RHEL/Alma 9 (2.34). No package install fixes that; the only
options there are building from source or an older baseline. The zip launcher
checks this with `ldd --version` and says so plainly instead of letting the
dynamic linker fail.

Runtime packages, and what each one costs you if it is missing (the app degrades
with an error, never silently):

| package | what it unlocks |
|---|---|
| `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `alsa-lib` | required — these are direct `DT_NEEDED` links, the app will not start without them |
| `libayatana-appindicator` | the tray icon only. `dlopen`-ed, not linked; a tray failure is non-fatal (`lib.rs:352-353` just logs it) so the app starts fine without it |
| `pulseaudio` / `pactl` | per-app volume macros, mute-output-while-dictating (`macros/audio.rs`, `voice/sysaudio.rs`) |
| `xdotool` / `libxdo` | synthetic keyboard + mouse input from macros (enigo) |
| X11 / XWayland | required on a Wayland session (see above) — and window/pixel macros (`macros/window.rs`, `macros/sys.rs`) are X11-only by design |

**The extract directory must be writable by the user.** `state.rs:13-16` puts
every persisted file next to the binary — `pixelmarch.json`,
`voice-settings.json`, `hotkeys/`, `macros/`, `brain/`, `screenshots/`, the host
`.port`/`.pid`/`.token` files, downloaded `ggml-*.bin`, the `webview/` XDG
redirect and the self-update `.new`/`.old` swap. Unpacking into `/opt` leaves the
app unable to save anything. The launcher tests writability and warns.

GUI-launched processes inherit the systemd user `PATH`, which has no
`~/.local/bin`, so pane startup commands like `claude` used to fail with
"command not found"; `pty/mod.rs` now prepends `~/.local/bin` and `~/bin`.

---

## Known-open gaps

Honest list. **Do not treat any of these as done.**

* **Wayland-native is unsupported.** See above — XWayland only.
* **Multi-monitor enumeration is not RandR-backed.** `src-tauri/Cargo.toml:122`
  does declare `x11rb = { features = ["randr"] }` — and its comment says that is
  what makes multi-monitor work — but no code uses it. `macros/window.rs:652-676`
  still takes the X-screen-roots fallback, and its comment there claims the
  feature is not enabled (stale on both counts; correct it when that code is next
  touched). Observed here: two connected outputs at the kernel level
  (`DP-3`, `HDMI-A-1`), while the X display reports a single 1920×1080 screen
  and an app window legitimately sat at x=2280 — i.e. outside the only
  "monitor" the app would report. So a multi-head layout reads as one screen,
  and monitor-N granularity is **not** available. Screenshots go through `xcap`,
  not this path.
* **Update signing is absent.** Integrity is a server-published sha256 only
  (`update.rs` module doc). A compromised or MITM'd server can serve a matching
  hash; the real fix is Ed25519/minisign verified against a key baked into the
  binary.
* **The updater does no OS/arch asset selection.** `latest.json` names one URL,
  so a Linux install would happily download and swap in a Windows exe. Point
  Linux builds at a Linux-only update endpoint until this is fixed. (Since
  `update.rs`, a release build with no `PIXELMARCH_UPDATE_URL` baked in has no
  update server at all and says so, rather than polling localhost.)
* **Self-update never replaces the launcher.** `update.rs` swaps
  `current_exe()`, which is `pixelmarch-bin` — the `./pixelmarch` wrapper
  script, `pixelmarch.desktop` and `INSTALL.txt` from the zip stay at the
  version they were extracted at. A fix to the launcher itself (new dependency
  check, new distro package name) only reaches users through a full re-download
  of the zip.
* **`--bundle` output is unverified.** deb/rpm/AppImage have never been produced
  on this box. The zip is the supported Linux artifact today.
