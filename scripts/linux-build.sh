#!/usr/bin/env bash
# linux-build.sh — one-shot native Linux build of PixelMarch on THIS machine.
# Arch/CachyOS (pacman) first-class, with apt/dnf handled too. No Docker.
#
# Usage:
#   bash scripts/linux-build.sh              # build (installs missing deps)
#   bash scripts/linux-build.sh --no-deps    # skip dep install, just build
#   bash scripts/linux-build.sh --deps-only  # install deps and stop
#   bash scripts/linux-build.sh --bundle     # also produce deb/rpm/AppImage
#   bash scripts/linux-build.sh --clean      # wipe the mirror before building
#   bash scripts/linux-build.sh --scratch-dir DIR   # scratch root (default $TMPDIR)
#
# Output: dist-bin/pixelmarch next to the repo (plus dist-bin/bundle/ with --bundle).
#
# Scratch: when the checkout cannot host node_modules/target the repo is mirrored
# to $TMPDIR/pixelmarch-build and built there. scripts/lib/scratch.sh picks the
# root and checks free space; the older $BUILD_DIR override still names the mirror
# directly, --scratch-dir wins over it, and a $BUILD_DIR inside $HOME is refused.
#
# .git comes along to the mirror too — src-tauri/build.rs shells out to git to
# stamp the binary with the commit sha, and without it every build says "unknown".
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/scratch.sh

# The mirror is a full copy of the checkout plus node_modules plus a cargo target
# built with tauri. Measured at 12 GiB on this box with room to grow, so
# the check asks for 15 GiB before it will start. Note tmpfs is RAM-backed and a
# default /tmp is usually a fraction of RAM, so it will often NOT fit this — that
# is exactly the case scratch_ensure stops on instead of picking somewhere else.
SCRATCH_MB=15360

WANT_DEPS=1
DEPS_ONLY=0
WANT_BUNDLE=0
WANT_CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-deps)   WANT_DEPS=0 ;;
    --deps-only) DEPS_ONLY=1 ;;
    --bundle)    WANT_BUNDLE=1 ;;
    --clean)     WANT_CLEAN=1 ;;
    --scratch-dir)   scratch_set "${2:-}" || exit 2; shift ;;
    --scratch-dir=*) scratch_parse_arg "$1" ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || { echo "Linux only — run this on the Linux box." >&2; exit 1; }

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

if command -v pacman >/dev/null 2>&1; then   PM=pacman
elif command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then     PM=dnf
else PM=none
fi

# --- System dependencies ------------------------------------------------------
install_deps() {
  case "$PM" in
    pacman)
      # Arch splits little: base-devel covers gcc/make/pkgconf; webkit2gtk-4.1
      # is the Tauri 2 requirement (NOT the legacy webkit2gtk 4.0 package).
      local pkgs="base-devel git curl wget file
        webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg patchelf
        libx11 libxrandr libxi libxtst libxfixes libxcb wayland pipewire
        dbus xdg-utils
        nodejs npm rustup"
      echo "==> pacman: installing build deps"
      # shellcheck disable=SC2086
      $SUDO pacman -S --needed --noconfirm $pkgs
      ;;
    apt|dnf)
      echo "==> Delegating to scripts/linux-setup.sh ($PM)"
      bash scripts/linux-setup.sh
      ;;
    *)
      echo "No pacman/apt/dnf found — install deps by hand, then re-run with --no-deps." >&2
      exit 1
      ;;
  esac

  # pacman's rustup ships no toolchain; without this cargo exists but errors out.
  if command -v rustup >/dev/null 2>&1; then
    rustup show active-toolchain >/dev/null 2>&1 || {
      echo "==> rustup: installing stable toolchain"
      rustup default stable
    }
  fi
}

if [ "$WANT_DEPS" -eq 1 ]; then install_deps; fi
if [ "$DEPS_ONLY" -eq 1 ]; then echo "==> deps done."; exit 0; fi

# rustup/rustc land in ~/.cargo/bin, which a non-login shell may not have on PATH.
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *) PATH="$HOME/.cargo/bin:$PATH" ;; esac

for c in node npm cargo git; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "missing: $c — run: bash scripts/linux-build.sh (without --no-deps)" >&2; exit 1; }
done
pkg-config --exists webkit2gtk-4.1 2>/dev/null || {
  echo "missing: webkit2gtk-4.1 dev files — install them (Arch: pacman -S webkit2gtk-4.1)" >&2
  exit 1; }

# --- Build off the volume when it cannot host node_modules/target -------------
SRC="$PWD"
OUT="$PWD"
FSTYPE="$(df -PT . 2>/dev/null | awk 'NR==2{print $2}')"
case "$FSTYPE" in
  vfat|exfat|msdos|ntfs|ntfs3|fuseblk|vboxsf|fuse.vmhgfs-fuse|vmhgfs|cifs|smbfs|9p)
    # Resolve before deleting: scratch_path refuses a legacy $BUILD_DIR inside
    # $HOME, and --clean must not rm a directory the build itself would reject.
    if [ "$WANT_CLEAN" -eq 1 ]; then
      CLEAN_DIR="$(scratch_path build)" || exit 1
      rm -rf "$CLEAN_DIR"
    fi
    WORK="$(scratch_ensure build "$SCRATCH_MB")" || exit 1
    echo "==> Mirroring the checkout to $WORK and building there."
    # node_modules, dist, target and the live profile stay local to the mirror;
    # --delete keeps the mirror honest about deleted sources without nuking them.
    rsync -a --delete \
      --exclude node_modules --exclude dist --exclude exe \
      --exclude src-tauri/target \
      "$SRC"/ "$WORK"/
    cd "$WORK"
    ;;
  *)
    if [ "$WANT_CLEAN" -eq 1 ]; then rm -rf node_modules dist src-tauri/target; fi
    ;;
esac

echo "==> Installing npm deps"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

ARGS=()
if [ "$WANT_BUNDLE" -eq 0 ]; then ARGS+=(--no-bundle); fi

echo "==> Building (bundle=$WANT_BUNDLE)"
npm run tauri -- build "${ARGS[@]}"

# Where cargo actually put the binary. Not necessarily src-tauri/target: a
# .cargo/config.toml above the repo redirects target-dir off the veracrypt
# volume (too small for a 7G target dir), so ask cargo instead of assuming.
TARGET_DIR="$(cd src-tauri && cargo metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')" \
  || TARGET_DIR="src-tauri/target"
BIN="$TARGET_DIR/release/pixelmarch"
[ -f "$BIN" ] || BIN="$TARGET_DIR/release/PixelMarch"
if [ -f "$BIN" ]; then
  mkdir -p "$OUT/dist-bin"
  cp -f "$BIN" "$OUT/dist-bin/pixelmarch"
  # Not redundant, and allowed to fail: some filesystems take the mode from the
  # mount rather than from chmod.
  chmod +x "$OUT/dist-bin/pixelmarch" 2>/dev/null || true
  echo "==> built $OUT/dist-bin/pixelmarch"
else
  echo "==> build finished but no binary under $TARGET_DIR/release — see output above" >&2
  exit 1
fi

if [ "$WANT_BUNDLE" -eq 1 ]; then
  BUNDLE="$TARGET_DIR/release/bundle"
  if [ -d "$BUNDLE" ] && [ "$OUT" != "$PWD" ]; then
    mkdir -p "$OUT/dist-bin/bundle"
    cp -rf "$BUNDLE"/. "$OUT/dist-bin/bundle"/
    echo "==> bundles copied to $OUT/dist-bin/bundle (deb/rpm/AppImage)"
  else
    echo "==> bundles under $BUNDLE"
  fi
fi

if [ ! -x "$OUT/dist-bin/pixelmarch" ]; then
  echo "==> the copy is not executable — run it from the build dir instead:"
  echo "    $BIN"
fi
