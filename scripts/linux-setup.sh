#!/usr/bin/env bash
# linux-setup.sh — dev/CI build-env bootstrap for PixelMarch on Debian/Ubuntu + Fedora.
#
# This is a BUILD-ENV script. Clients never run it — they get a prebuilt
# AppImage/deb/rpm + the in-app self-updater. Use it on your dev box, a Linux VM,
# or the CI Linux runner to get `npm run tauri dev` / `npm run pack` working.
#
# Usage:
#   ./scripts/linux-setup.sh            # install all system deps (+ rust/node if missing)
#   ./scripts/linux-setup.sh --voice    # also install whisper-rs build deps (clang/cmake)
#   ./scripts/linux-setup.sh --build     # after deps, run a portable build to verify
#   ./scripts/linux-setup.sh --voice --build
#   ./scripts/linux-setup.sh --build --scratch-dir DIR   # scratch root (default $TMPDIR)
#
# Targets: Ubuntu 24.04+ / Debian 13+ / Fedora 39+ (all ship webkit2gtk-4.1, which
# Tauri 2 requires; Ubuntu 22.04 has only 4.0 — upgrade or backport before using).

set -euo pipefail

WANT_VOICE=0
WANT_BUILD=0
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/scratch.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --voice) WANT_VOICE=1 ;;
    --build) WANT_BUILD=1 ;;
    --scratch-dir)   scratch_set "${2:-}" || exit 2; shift ;;
    --scratch-dir=*) scratch_parse_arg "$1" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# --- Detect package manager --------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  PM="apt"
elif command -v dnf >/dev/null 2>&1; then
  PM="dnf"
else
  echo "No supported package manager (apt/dnf) found. Install deps manually — see linux-build.md." >&2
  exit 1
fi
echo "==> Package manager: $PM"

# --- Package lists per distro -------------------------------------------------
if [ "$PM" = "apt" ]; then
  BASE="build-essential curl wget file pkg-config ca-certificates git"
  # Tauri 2 core (WebKitGTK + GTK + tray + svg)
  TAURI="libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf"
  # X11/XCB/Wayland — enigo (libxdo), arboard + xcap (xcb / PipeWire portal)
  GUI="libxdo-dev libx11-dev libxrandr-dev libxi-dev libxtst-dev libxfixes-dev \
       libxcb1-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev \
       libwayland-dev libpipewire-0.3-dev"
  # D-Bus (notify-rust, zbus) + ALSA (cpal)
  SVC="libdbus-1-dev libasound2-dev"
  # Runtime helpers for testing macros on a desktop VM (xdg-open, pactl)
  RUNTIME="xdg-utils pulseaudio-utils"
  VOICE="clang libclang-dev cmake"
else # dnf / Fedora
  BASE="gcc gcc-c++ make curl wget file pkgconf-pkg-config ca-certificates git"
  TAURI="webkit2gtk4.1-devel gtk3-devel libayatana-appindicator-gtk3-devel librsvg2-devel patchelf"
  GUI="libxdo-devel libX11-devel libXrandr-devel libXi-devel libXtst-devel libXfixes-devel \
       libxcb-devel wayland-devel pipewire-devel"
  SVC="dbus-devel alsa-lib-devel"
  RUNTIME="xdg-utils pulseaudio-utils"
  VOICE="clang clang-devel cmake"
fi

pm_install() {
  if [ "$PM" = "apt" ]; then
    $SUDO apt-get install -y --no-install-recommends $1
  else
    $SUDO dnf install -y $1
  fi
}

echo "==> Refreshing package index"
if [ "$PM" = "apt" ]; then $SUDO apt-get update -y; else $SUDO dnf makecache -y || true; fi

echo "==> Installing base build tooling"
pm_install "$BASE"

echo "==> Installing Tauri 2 core libraries"
pm_install "$TAURI"

echo "==> Installing X11 / XCB / Wayland stack"
pm_install "$GUI"

echo "==> Installing D-Bus + ALSA"
pm_install "$SVC"

echo "==> Installing runtime test helpers (best-effort)"
pm_install "$RUNTIME" || echo "   (runtime helpers optional — continuing)"

if [ "$WANT_VOICE" -eq 1 ]; then
  echo "==> Installing --features voice build deps (clang/cmake)"
  pm_install "$VOICE"
fi

# --- Rust toolchain ----------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Installing Rust via rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
else
  echo "==> Rust already present: $(cargo --version)"
fi

# --- Node.js (frontend build) ------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 22 LTS"
  if [ "$PM" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO dnf install -y nodejs
  fi
else
  echo "==> Node already present: $(node --version)"
fi

echo
echo "==> System deps installed."
echo "    Display server note: enigo/arboard/xcap/notify-rust need a running"
echo "    desktop session (X11 or Wayland). Headless VMs will error at runtime."
echo "    Test BOTH sessions — log into an Xorg session to exercise the X11 paths."

# --- Optional build verification --------------------------------------------
if [ "$WANT_BUILD" -eq 1 ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  echo "==> Verifying build in $REPO_ROOT"
  cd "$REPO_ROOT"
  # linux-build.sh owns the scratch directory rules (nothing in $HOME) and the
  # in-tree/mirror decision; deps are already installed by the time we get here.
  bash scripts/linux-build.sh --no-deps --bundle
  echo "==> Build finished. Bundles under dist-bin/bundle/ (deb/rpm/AppImage)."
fi

echo "==> Done."
