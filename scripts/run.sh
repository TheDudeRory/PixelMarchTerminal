#!/usr/bin/env bash
# run.sh — build this checkout and launch it. THE way to run PixelMarch now that
# the app runs from source (see src-tauri/src/state.rs: the profile is <repo>/data,
# and src-tauri/src/update.rs: updating is `git pull` + a rebuild).
#
# Usage:
#   bash scripts/run.sh              # release: rebuild what changed, then run
#   bash scripts/run.sh --debug      # debug profile — builds far faster, runs slower
#   bash scripts/run.sh --dev        # `tauri dev`: vite HMR, for editing the frontend
#   bash scripts/run.sh --rebuild    # force the frontend build even if dist/ looks current
#   bash scripts/run.sh --no-build   # launch what is already built (fails if nothing is)
#   bash scripts/run.sh --check      # report the toolchain and the build state, then stop
#   bash scripts/run.sh -- --host    # everything after `--` goes to the app
#
# Which mode to use, since the difference is minutes:
#
#   --dev    editing src/**. Vite reloads the page on save; no Rust rebuild at all.
#            The Rust side is a debug build, so the first start is slow and terminals
#            feel it. This is the loop an agent working on the UI wants.
#   --debug  editing src-tauri/**. Cargo relinks in seconds instead of minutes.
#   (none)   actually using the app. Release is the only profile whose PTY and
#            OCR paths are fast enough to live in.
#
# What it does NOT do: touch exe/. That folder is the retired portable install and
# is nobody's business here.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PROFILE=release
MODE=run
FORCE_FRONTEND=0
WANT_BUILD=1
APP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --debug)    PROFILE=debug ;;
    --release)  PROFILE=release ;;
    --dev)      MODE=dev ;;
    --rebuild)  FORCE_FRONTEND=1 ;;
    --no-build) WANT_BUILD=0 ;;
    --check)    MODE=check ;;
    --)         shift; APP_ARGS=("$@"); break ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m==> %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m==> %s\033[0m\n' "$*" >&2; exit 1; }

# ── toolchain ────────────────────────────────────────────────────────────────
# Every one of these is needed by the in-app updater too (it shells out to git,
# npm and cargo), so a box that cannot run this script cannot update either.
# Checked by RUNNING them, not by `command -v`: a node that is on PATH but fails
# to load its shared libraries after a partial system upgrade passes the lookup
# and then breaks the build with an error nobody connects to the toolchain.
missing=0
for tool in git node npm cargo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    warn "$tool is not on PATH"
    missing=1
    continue
  fi
  if ! err=$("$tool" --version 2>&1); then
    warn "$tool is installed but will not run:"
    printf '      %s\n' "$err" >&2
    # The one failure mode worth naming, because the fix is not obvious from the
    # message: a library the binary was linked against has moved on without it.
    if printf '%s' "$err" | grep -q 'shared libraries'; then
      if command -v pacman >/dev/null 2>&1; then
        warn "looks like a partial system upgrade — fix it with:  sudo pacman -Syu"
      else
        warn "looks like a partial system upgrade — reinstall or update $tool"
      fi
    fi
    missing=1
  fi
done
[ "$missing" -eq 0 ] || die "the build toolchain is not usable; nothing was built"

# ── where the build output lands ─────────────────────────────────────────────
# Asked of cargo rather than assumed to be src-tauri/target. `build.target-dir`
# is routinely redirected — this project's own dev box points it off the small
# volume the source lives on — and a guess that is wrong here launches the
# binary from BEFORE the build while reporting success.
target_dir() {
  cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))'
}
TARGET="$(target_dir)"
BIN="$TARGET/$PROFILE/pixelmarch"
case "${OS:-}" in Windows_NT) BIN="$BIN.exe" ;; esac

if [ "$MODE" = check ]; then
  say "checkout:  $ROOT"
  say "profile:   $ROOT/data $([ -f data/pixelmarch.json ] && echo '(has state)' || echo '(empty — first run)')"
  say "target:    $TARGET"
  # "a binary exists" is not the same as "that binary is this code" — the whole
  # point of running from source is that the two agree, so say which it is.
  if [ ! -x "$BIN" ]; then
    say "binary:    $BIN (NOT BUILT)"
  elif [ -n "$(find src src-tauri/src src-tauri/Cargo.toml package.json -newer "$BIN" -print -quit 2>/dev/null)" ]; then
    say "binary:    $BIN (STALE — source has changed since it was built)"
  else
    say "binary:    $BIN (built, current)"
  fi
  say "frontend:  $([ -f dist/index.html ] && echo 'dist/ present' || echo 'dist/ MISSING')"
  say "toolchain: ok"
  exit 0
fi

# ── an already-running copy would swallow this launch ────────────────────────
# Tauri's single-instance plugin keys on the bundle identifier, which is the same
# for every build of PixelMarch. So starting a second one does not start anything:
# it hands its arguments to the first and exits, and the window that comes to the
# front is the OLD build. That reads exactly like "my changes did nothing".
running=""
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -x pixelmarch 2>/dev/null || true); do
    exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    # The detached terminal host is a sidecar, not a second GUI — it is expected.
    if [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- '--host'; then
      continue
    fi
    running="${running}  pid $pid  ${exe:-<unreadable>}"$'\n'
  done
fi
if [ -n "$running" ]; then
  warn "PixelMarch is already running:"
  printf '%s' "$running" >&2
  warn "A second copy cannot start (single-instance): this launch would only raise that window."
  warn "Quit it first — Settings -> \"Close all & quit\" — then run this again."
  exit 1
fi

# ── build ────────────────────────────────────────────────────────────────────
if [ "$WANT_BUILD" -eq 1 ]; then
  # `npm ci` deletes and refetches node_modules, so it runs only when the lockfile
  # is actually ahead of what is installed. Same rule the in-app updater uses.
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    say "npm ci"
    npm ci
  fi

  if [ "$MODE" = dev ]; then
    # tauri dev owns the rest: it starts vite, waits for it, and builds+runs the
    # debug binary against http://localhost:1420 instead of dist/.
    say "npm run tauri dev  (vite HMR; Ctrl-C to stop)"
    exec npm run tauri dev
  fi

  # tsc + vite, ~seconds. Always run it unless dist/ is present and nothing under
  # src/ is newer — the point of running from source is that what you launch is
  # what is in the tree.
  if [ "$FORCE_FRONTEND" -eq 1 ] || [ ! -f dist/index.html ] \
     || [ -n "$(find src index.html vite.config.ts tsconfig.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
    say "npm run build  (frontend -> dist/)"
    npm run build
  else
    say "frontend up to date"
  fi

  # Cargo decides for itself what needs recompiling, so this is a no-op when
  # nothing changed. First build on a cold target dir is minutes (whisper-rs and
  # webkit2gtk); say so rather than let it look hung.
  # `--features custom-protocol` is NOT optional, and its absence is silent: the
  # tauri crate's build script sets cfg(dev) to !custom-protocol, so a plain
  # `cargo build --release` produces a binary that ignores the dist/ we just built
  # and loads devUrl instead — a window reading "Could not connect to localhost".
  # The tauri CLI passes it on `tauri build`; building with cargo directly means
  # asking for it here. `devtools` is the other half of what `tauri build --debug`
  # adds, and is wanted for exactly the profile that is named debug.
  FEATURES=custom-protocol
  if [ "$PROFILE" = debug ]; then FEATURES="$FEATURES,devtools"; fi
  [ -x "$BIN" ] || say "no binary yet — the first build takes several minutes"
  say "cargo build${PROFILE:+ --$PROFILE} --features $FEATURES"
  ( cd src-tauri && if [ "$PROFILE" = release ]; then
      cargo build --release --features "$FEATURES"
    else
      cargo build --features "$FEATURES"
    fi )
elif [ "$MODE" = dev ]; then
  die "--dev builds by definition; drop --no-build"
fi

[ -x "$BIN" ] || die "no binary at $BIN — run without --no-build"

say "launching $BIN"
exec "$BIN" "${APP_ARGS[@]+"${APP_ARGS[@]}"}"
