#!/bin/sh
# PixelMarch launcher — ships in the release zip as ./pixelmarch.
#
# The real binary is pixelmarch-bin next to this script. This wrapper exists so
# that a fresh-install failure prints something a human can act on instead of a
# dynamic-linker backtrace:
#
#   * restores the exec bit if a GUI extractor dropped it
#   * checks the glibc / libstdc++ floor and names the distros that meet it
#   * turns "libwebkit2gtk-4.1.so.0 => not found" into one copy-pasteable
#     pacman/apt/dnf command
#   * warns when the extract directory is not writable (all app state lives
#     next to the binary) and when a Wayland session has no XWayland
#
# It then exec's the binary, so the process the app sees is the real one —
# current_exe() is <extract dir>/pixelmarch-bin and the portable profile still
# lands in <extract dir>.
#
# Extra commands (everything else is passed straight through to the app):
#   ./pixelmarch --install-desktop     add an application-menu entry + icon
#   ./pixelmarch --uninstall-desktop   remove them
#   ./pixelmarch --check               run the checks and exit, do not launch
set -u

# --- Where am I ---------------------------------------------------------------
# Resolve symlinks so a ~/bin/pixelmarch symlink still finds pixelmarch-bin.
# The hop cap is what stops a symlink cycle (ln -s a b; ln -s b a) from spinning
# here forever: without it the launcher hangs instead of failing.
self="$0"
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 20 ]; then
    printf 'pixelmarch: %s\n' "symlink loop resolving $0 (still a symlink after 20 hops, last: $self) — point it straight at the launcher." >&2
    exit 1
  fi
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *)  self="$(dirname "$self")/$link" ;;
  esac
done
HERE="$(cd "$(dirname "$self")" && pwd)"
BIN="$HERE/pixelmarch-bin"
ICON="$HERE/pixelmarch.png"
APP_NAME="PixelMarch"

say()  { printf '%s\n' "$*"; }
warn() { printf 'pixelmarch: %s\n' "$*" >&2; }
die()  { printf 'pixelmarch: %s\n' "$*" >&2; exit 1; }

[ -f "$BIN" ] || die "pixelmarch-bin is missing from $HERE — extract the whole zip, not just this file."

# --- Distro family ------------------------------------------------------------
# arch | debian | fedora | unknown — decides which package names we print.
# /etc/os-release is READ, never sourced: sourcing it would define NAME, VERSION,
# HOME_URL and friends in this shell, and one day one of those names collides
# with something here. We only want ID and ID_LIKE.
family=unknown
if [ -r /etc/os-release ]; then
  os_ids="$(while IFS= read -r osline || [ -n "$osline" ]; do
    case "$osline" in
      ID=*|ID_LIKE=*)
        osval="${osline#*=}"
        printf '%s ' "$(printf '%s' "$osval" | tr -d "\"'")"
        ;;
    esac
  done < /etc/os-release)"
  for id in $os_ids; do
    case "$id" in
      arch|archlinux|cachyos|manjaro|endeavouros) family=arch;   break ;;
      debian|ubuntu|linuxmint|pop)               family=debian; break ;;
      fedora|rhel|centos|nobara|almalinux)       family=fedora; break ;;
    esac
  done
fi

pkg_for() { # pkg_for <soname> -> package name for $family (empty if unknown)
  case "$1" in
    libwebkit2gtk-4.1.so.*|libjavascriptcoregtk-4.1.so.*)
      case $family in arch) echo webkit2gtk-4.1 ;; debian) echo libwebkit2gtk-4.1-0 ;; fedora) echo webkit2gtk4.1 ;; esac ;;
    libgtk-3.so.*|libgdk-3.so.*)
      case $family in arch) echo gtk3 ;; debian) echo libgtk-3-0 ;; fedora) echo gtk3 ;; esac ;;
    libsoup-3.0.so.*)
      case $family in arch) echo libsoup3 ;; debian) echo libsoup-3.0-0 ;; fedora) echo libsoup3 ;; esac ;;
    libgdk_pixbuf-2.0.so.*)
      case $family in arch) echo gdk-pixbuf2 ;; debian) echo libgdk-pixbuf-2.0-0 ;; fedora) echo gdk-pixbuf2 ;; esac ;;
    libcairo.so.*)
      case $family in arch) echo cairo ;; debian) echo libcairo2 ;; fedora) echo cairo ;; esac ;;
    libglib-2.0.so.*|libgobject-2.0.so.*|libgio-2.0.so.*)
      case $family in arch) echo glib2 ;; debian) echo libglib2.0-0 ;; fedora) echo glib2 ;; esac ;;
    libdbus-1.so.*)
      case $family in arch) echo dbus ;; debian) echo libdbus-1-3 ;; fedora) echo dbus-libs ;; esac ;;
    libxcb.so.*)
      case $family in arch) echo libxcb ;; debian) echo libxcb1 ;; fedora) echo libxcb ;; esac ;;
    libwayland-client.so.*)
      case $family in arch) echo wayland ;; debian) echo libwayland-client0 ;; fedora) echo libwayland-client ;; esac ;;
    libstdc++.so.*|libgcc_s.so.*)
      case $family in arch) echo gcc-libs ;; debian) echo libstdc++6 ;; fedora) echo libstdc++ ;; esac ;;
  esac
}

install_cmd() { # install_cmd <packages...>
  case $family in
    arch)   echo "sudo pacman -S --needed $*" ;;
    debian) echo "sudo apt install $*" ;;
    fedora) echo "sudo dnf install $*" ;;
    *)      echo "install with your package manager: $*" ;;
  esac
}

# --- Version compare (dotted, awk so we need no bash) -------------------------
ver_lt() { # ver_lt A B -> true when A < B
  awk -v a="$1" -v b="$2" 'BEGIN{
    na=split(a,A,"."); nb=split(b,B,".");
    n = (na>nb ? na : nb);
    for(i=1;i<=n;i++){ x=(i<=na?A[i]+0:0); y=(i<=nb?B[i]+0:0);
      if(x<y) exit 0; if(x>y) exit 1 }
    exit 1 }'
}

GLIBC_MIN=2.39
GLIBCXX_MIN=3.4.31

problems=0

# --- 1. exec bit --------------------------------------------------------------
if [ ! -x "$BIN" ]; then
  chmod +x "$BIN" 2>/dev/null || true
  if [ ! -x "$BIN" ]; then
    problems=$((problems + 1))
    warn "pixelmarch-bin is not executable and chmod failed."
    warn "  Extract onto a normal Linux filesystem (a noexec mount or a"
    warn "  vfat/exfat drive cannot mark it runnable), then:  chmod +x '$BIN'"
  fi
fi

# --- 2. the extract directory must be writable --------------------------------
# Everything the app persists (settings, screenshots, brain notes, the webview
# cache) lives next to the binary.
if ! ( : > "$HERE/.pixelmarch-write-test" ) 2>/dev/null; then
  problems=$((problems + 1))
  warn "the folder $HERE is not writable by you."
  warn "  PixelMarch is portable: it keeps ALL of its state next to the binary."
  warn "  Extract somewhere you own (your home directory), or: sudo chown -R \"\$USER\" '$HERE'"
else
  rm -f "$HERE/.pixelmarch-write-test"
fi

# --- 3. glibc floor -----------------------------------------------------------
glibc_ver=""
if command -v ldd >/dev/null 2>&1; then
  glibc_ver="$(ldd --version 2>/dev/null | head -1 | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+' | head -1)"
fi
if [ -n "$glibc_ver" ] && ver_lt "$glibc_ver" "$GLIBC_MIN"; then
  problems=$((problems + 1))
  warn "this system has glibc $glibc_ver; PixelMarch needs $GLIBC_MIN or newer."
  warn "  That is Ubuntu 24.04+, Debian 13+, Fedora 40+, or a rolling distro."
  warn "  Ubuntu 22.04 (2.35), Debian 12 (2.36) and RHEL/Alma 9 (2.34) cannot run"
  warn "  this build at all — no package install fixes it. Build from source there."
fi

# --- 4. libstdc++ floor -------------------------------------------------------
if command -v ldd >/dev/null 2>&1; then
  libcxx="$(ldd "$BIN" 2>/dev/null | awk '/libstdc\+\+\.so/ && $3 ~ /^\// {print $3; exit}')"
  if [ -n "$libcxx" ] && command -v strings >/dev/null 2>&1; then
    have="$(strings -a "$libcxx" 2>/dev/null | grep -oE '^GLIBCXX_[0-9.]+' | sed 's/GLIBCXX_//' \
            | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    if [ -n "$have" ] && ver_lt "$have" "$GLIBCXX_MIN"; then
      problems=$((problems + 1))
      warn "libstdc++ is too old: it provides GLIBCXX_$have, PixelMarch needs GLIBCXX_$GLIBCXX_MIN (GCC 13+)."
      warn "  Update your system's C++ runtime: $(install_cmd "$(pkg_for 'libstdc++.so.6')")"
    fi
  fi
fi

# --- 5. missing shared libraries ----------------------------------------------
if command -v ldd >/dev/null 2>&1; then
  missing="$(ldd "$BIN" 2>/dev/null | awk '/not found/ {print $1}' | sort -u)"
  if [ -n "$missing" ]; then
    problems=$((problems + 1))
    warn "missing system libraries:"
    pkgs=""
    unknown=""
    for so in $missing; do
      p="$(pkg_for "$so")"
      warn "    $so"
      if [ -n "$p" ]; then
        case " $pkgs " in *" $p "*) ;; *) pkgs="$pkgs $p" ;; esac
      else
        unknown="$unknown $so"
      fi
    done
    if [ -n "$pkgs" ]; then
      say ""
      say "Install them with:"
      say "    $(install_cmd $pkgs)"
      say ""
    fi
    if [ -n "$unknown" ]; then
      warn "no package name known here for:$unknown — search your distro's repos."
    fi
    if [ "$family" = unknown ]; then
      warn "distro not recognised; the package names above are Arch/Debian/Fedora spellings."
    fi
  fi
fi

# --- 6. X11 / XWayland --------------------------------------------------------
# The app forces GDK_BACKEND=x11 (main.rs), so a Wayland session needs XWayland.
if [ -z "${DISPLAY:-}" ]; then
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    problems=$((problems + 1))
    warn "Wayland session with no X display: PixelMarch renders through XWayland and"
    warn "  cannot open a window without it. Install XWayland:"
    case $family in
      arch)   warn "    sudo pacman -S --needed xorg-xwayland" ;;
      debian) warn "    sudo apt install xwayland" ;;
      fedora) warn "    sudo dnf install xorg-x11-server-Xwayland" ;;
      *)      warn "    install your distro's xwayland package" ;;
    esac
    warn "  (then log out and back in, so the compositor starts it)"
  else
    warn "no graphical display detected (\$DISPLAY and \$WAYLAND_DISPLAY are both unset)."
  fi
fi

# --- Desktop entry ------------------------------------------------------------
# Generated here, never shipped with a baked-in path: the zip can be extracted
# anywhere, so the only correct Exec= is the one we compute at install time.
apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
# pixelmarch.png is src-tauri/icons/128x128@2x.png — 256x256 pixels despite the
# name. It must land in the size dir that matches its real pixel size, or strict
# theme lookups skip it and the icon cache downscales it.
icon_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
entry="$apps_dir/pixelmarch.desktop"

# Desktop Entry spec: an Exec= holding a path with spaces MUST be quoted, and
# inside those quotes \ " ` $ are reserved and need a backslash — which itself
# has to survive the value-level unescape first, hence the doubling below.
# desktop-file-validate does NOT catch an unquoted path with spaces, so this is
# the only thing standing between "extracted into ~/My Apps/" and a menu entry
# that silently runs the wrong command.
esc_exec() {
  printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/"/\\\\"/g' \
                         -e 's/`/\\\\`/g'     -e 's/\$/\\\\$/g'
}

install_desktop() {
  template="$HERE/pixelmarch.desktop"
  [ -f "$template" ] || die "pixelmarch.desktop is missing from $HERE"
  mkdir -p "$apps_dir" "$icon_dir" || die "cannot create $apps_dir"
  # $HERE/pixelmarch is this launcher, so the menu entry gets the same checks.
  # The path is substituted with printf, never as a sed replacement: a path
  # containing & or | would otherwise be mangled by sed's own metacharacters.
  exec_value="\"$(esc_exec "$HERE/pixelmarch")\""
  : > "$entry" || die "cannot write $entry"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      \#*)        continue ;;
      "Exec=@EXEC@") printf 'Exec=%s\n' "$exec_value" ;;
      "Icon=@ICON@") printf 'Icon=pixelmarch\n' ;;
      *)          printf '%s\n' "$line" ;;
    esac
  done < "$template" >> "$entry" || die "cannot write $entry"
  chmod 644 "$entry"
  if [ -f "$ICON" ]; then
    cp -f "$ICON" "$icon_dir/pixelmarch.png" && chmod 644 "$icon_dir/pixelmarch.png"
    # Older builds of this launcher put the same 256px file under 128x128/.
    rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps/pixelmarch.png"
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps_dir" 2>/dev/null
  say "installed $entry -> $HERE/pixelmarch"
  say "(re-run --install-desktop after moving the folder; the path is baked into the entry)"
  exit 0
}

# rmdir is the entire safety check here: it refuses on a non-empty directory,
# so anything holding another program's files survives untouched. We cannot
# tell whether an EMPTY xdg directory is one --install-desktop created or one
# that already existed, and we do not try to: an empty one holds no user data
# either way, and every installer that wants it back creates it with mkdir -p.
rmdir_if_empty() { [ -d "$1" ] && rmdir "$1" 2>/dev/null; return 0; }

uninstall_desktop() {
  icons_root="${XDG_DATA_HOME:-$HOME/.local/share}/icons"
  rm -f "$entry" "$icon_dir/pixelmarch.png" \
        "$icons_root/hicolor/128x128/apps/pixelmarch.png"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" 2>/dev/null
    # --install-desktop runs update-desktop-database, which writes a
    # mimeinfo.cache; regenerating it on uninstall does not delete it. If no
    # .desktop file is left in the directory then that cache describes nothing
    # — drop it. When other entries are present the cache is theirs, so leave
    # it alone. Only this cache handling belongs in here: without
    # update-desktop-database no cache was ever written, but the directory
    # still needs unwinding, so that rmdir sits outside the branch.
    if [ -d "$apps_dir" ] && ! ls "$apps_dir"/*.desktop >/dev/null 2>&1; then
      rm -f "$apps_dir/mimeinfo.cache"
    fi
  fi
  # install_desktop does mkdir -p on $apps_dir and on the whole 256x256/apps
  # chain, so uninstall unwinds the same directories. Each level stops the
  # moment one is not empty.
  rmdir_if_empty "$apps_dir"
  rmdir_if_empty "$icon_dir"
  rmdir_if_empty "$icons_root/hicolor/256x256"
  rmdir_if_empty "$icons_root/hicolor/128x128/apps"
  rmdir_if_empty "$icons_root/hicolor/128x128"
  rmdir_if_empty "$icons_root/hicolor"
  rmdir_if_empty "$icons_root"
  say "removed $entry"
  say "note: \"Start on login\" is separate — turn it off in the app, or"
  say "      rm -f \"\${XDG_CONFIG_HOME:-\$HOME/.config}/autostart/pixelmarch.desktop\""
  exit 0
}

case "${1:-}" in
  --install-desktop)   install_desktop ;;
  --uninstall-desktop) uninstall_desktop ;;
  --check)
    if [ "$problems" -eq 0 ]; then
      say "$APP_NAME: all checks passed — $BIN is runnable here."
      exit 0
    fi
    warn "$problems problem(s) found; see above."
    exit 1 ;;
esac

if [ "$problems" -gt 0 ]; then
  warn "starting anyway — if it dies immediately, fix the above first."
fi

exec "$BIN" "$@"
