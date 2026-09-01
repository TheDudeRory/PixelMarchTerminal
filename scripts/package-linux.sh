#!/usr/bin/env bash
# package-linux.sh — build a fresh Linux release binary and emit a CLEAN zip.
#
# Usage:
#   bash scripts/package-linux.sh                 # build, then package
#   bash scripts/package-linux.sh --no-build      # package the binary already built
#   bash scripts/package-linux.sh --no-deps       # build without touching system packages
#   bash scripts/package-linux.sh --clean         # wipe the staging dir first
#   bash scripts/package-linux.sh --out DIR       # write the zip to DIR instead of dist-zip/
#   bash scripts/package-linux.sh --scratch-dir DIR  # scratch root (default $TMPDIR)
#
# Output: dist-zip/pixelmarch-<version>-linux-<arch>.zip
# Staging happens under $TMPDIR/pixelmarch-stage; only the zip lands in the repo.
#
# WHY THIS SCRIPT EXISTS — READ BEFORE EDITING
#   The developer's live runtime profile (the folder the app runs from) holds
#   settings with absolute host paths, brain/ notes and personal screenshots.
#   Copying that folder into the zip ships all of that. So this script NEVER
#   copies a directory wholesale. It stages an
#   explicit ALLOW-LIST of files, one cp per line. If
#   you need something else in the zip, add it to stage() by name — never widen
#   this into an exclude-list, and never `cp -r` a directory that the running
#   app writes into.
#
# Building is delegated to scripts/linux-build.sh — it owns the scratch mirror and
# the toolchain checks. Do not reimplement either here.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
. scripts/lib/scratch.sh

# Staging is six small files plus the binary; a couple hundred MiB is plenty.
STAGE_MB=512

WANT_BUILD=1
OUT_DIR=""
WANT_CLEAN=0
BUILD_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)  WANT_BUILD=0 ;;
    --clean)     WANT_CLEAN=1 ;;
    --out)       OUT_DIR="${2:-}"; [ -n "$OUT_DIR" ] || { echo "--out needs a directory" >&2; exit 2; }; shift ;;
    --out=*)     OUT_DIR="${1#--out=}" ;;
    --scratch-dir)   scratch_set "${2:-}" || exit 2; BUILD_ARGS+=(--scratch-dir "$2"); shift ;;
    --scratch-dir=*) scratch_parse_arg "$1"; BUILD_ARGS+=("$1") ;;
    # everything linux-build.sh understands, passed straight through
    --no-deps|--deps-only|--bundle) BUILD_ARGS+=("$1") ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || { echo "Linux only." >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || {
  echo "missing: python3 — used to write the zip with correct file modes" >&2; exit 1; }

# --- Version + arch -----------------------------------------------------------
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "cannot read version from package.json" >&2; exit 1; }
CARGO_VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
if [ -n "$CARGO_VERSION" ] && [ "$CARGO_VERSION" != "$VERSION" ]; then
  echo "WARNING: package.json says $VERSION but src-tauri/Cargo.toml says $CARGO_VERSION" >&2
fi
ARCH="$(uname -m)"
NAME="pixelmarch-${VERSION}-linux-${ARCH}"

# --- Build --------------------------------------------------------------------
if [ "$WANT_BUILD" -eq 1 ]; then
  echo "==> Building release binary (scripts/linux-build.sh ${BUILD_ARGS[*]:-})"
  bash scripts/linux-build.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
fi

# linux-build.sh builds either in-tree or in its scratch mirror depending on the
# filesystem. Take the newest of the two target dirs. The live profile dir is
# deliberately NOT a candidate: a binary sitting there may be older or from
# another OS entirely.
BIN=""
newest_bin() {
  local best="" cand
  for cand in "$@"; do
    [ -f "$cand" ] || continue
    if [ -z "$best" ] || [ "$cand" -nt "$best" ]; then best="$cand"; fi
  done
  printf '%s' "$best"
}
# scratch_path can REFUSE (rc=1) when a legacy $BUILD_DIR/$CARGO_TARGET_DIR
# resolves inside $HOME. Capture and propagate, or the empty substitution turns
# into a bogus "/src-tauri/target/release/pixelmarch" and the refusal text is
# followed by a confusing "no release binary found".
BIN_ROOT="$(scratch_path build)" || exit 1
# dist-bin/pixelmarch is linux-build.sh's DOCUMENTED output ("Output: dist-bin/
# pixelmarch next to the repo") and the only path that holds the binary when
# CARGO_TARGET_DIR points somewhere else entirely (a licensed target cache) —
# without it a build that just succeeded ends in "no release binary found".
BIN="$(newest_bin \
  "$REPO/dist-bin/pixelmarch" \
  "$REPO/src-tauri/target/release/pixelmarch" \
  "$BIN_ROOT/src-tauri/target/release/pixelmarch")"
[ -n "$BIN" ] || {
  echo "no release binary found — run without --no-build, or build first:" >&2
  echo "  bash scripts/linux-build.sh" >&2
  exit 1; }
echo "==> Using binary $BIN ($(du -h "$BIN" | cut -f1))"

# --- Stage (ALLOW-LIST ONLY) --------------------------------------------------
STAGE_ROOT="$(scratch_ensure stage "$STAGE_MB")" || exit 1
STAGE="$STAGE_ROOT/$NAME"
if [ "$WANT_CLEAN" -eq 1 ]; then rm -rf "$STAGE"; fi
if [ -e "$STAGE" ] && [ -n "$(ls -A "$STAGE" 2>/dev/null)" ]; then
  echo "REFUSING TO PACKAGE: staging dir is not empty: $STAGE" >&2
  echo "  Anything already in there would ship. Inspect it, then re-run with --clean." >&2
  exit 1
fi
mkdir -p "$STAGE"

stage() { # stage <src> <dest-name> <mode>
  [ -f "$1" ] || { echo "missing packaging input: $1" >&2; exit 1; }
  cp -f "$1" "$STAGE/$2"
  # Allowed to fail: the mode may come from the mount. The zip entries carry
  # explicit modes anyway (see the python step below).
  chmod "$3" "$STAGE/$2" 2>/dev/null || true
  echo "    + $2"
}

echo "==> Staging $STAGE"
# NAME-BY-NAME ALLOW-LIST — never cp -r a directory next to the exe. Everything
# the running app writes lives there: webview/{data,cache} (WebKitGTK cookies,
# localStorage, hsts-storage.sqlite — see src-tauri/src/main.rs, which points
# XDG_DATA_HOME/XDG_CACHE_HOME at it) plus the state_dir() children
# (brain/, logs/, screenshots/, *.json, .port/.pid/.token).
# A dev run before packaging fills those; shipping them is a data leak, not
# bloat. They are excluded BY CONSTRUCTION here — do not add a directory copy.
# ./pixelmarch is the launcher script; the real binary ships beside it as
# pixelmarch-bin. current_exe() is still the binary and its parent is still the
# extract directory, so the portable profile layout is unchanged — but a user
# who double-clicks or types ./pixelmarch gets the dependency checks first.
stage "$REPO/packaging/pixelmarch-launcher.sh" pixelmarch               755
stage "$BIN"                                 pixelmarch-bin             755
stage "$REPO/legal/EULA.md"                  LICENSE.txt                644
stage "$REPO/legal/THIRD-PARTY-LICENSES.md"  THIRD-PARTY-LICENSES.txt   644
stage "$REPO/packaging/pixelmarch.desktop"   pixelmarch.desktop         644
stage "$REPO/src-tauri/icons/128x128@2x.png" pixelmarch.png             644

# INSTALL.txt is templated (version/arch), so it is written rather than copied.
[ -f "$REPO/packaging/INSTALL.txt" ] || { echo "missing packaging/INSTALL.txt" >&2; exit 1; }
sed -e "s/@VERSION@/$VERSION/g" -e "s/@ARCH@/$ARCH/g" \
  "$REPO/packaging/INSTALL.txt" > "$STAGE/INSTALL.txt"
chmod 644 "$STAGE/INSTALL.txt"
echo "    + INSTALL.txt"

# --- Paranoia: nothing personal may have slipped in ---------------------------
# A second, independent gate on the allow-list above. If this ever fires, the
# staging step grew a directory copy — fix that, do not relax this check.
BAD="$(find "$STAGE" \( -name '*.json' -o -name '*.bin' -o -name '*.exe' \
  -o -name '*.port' -o -name '*.url' -o -name '*.log' \
  -o -name 'brain' -o -name 'screenshots' -o -name 'logs' -o -name 'webview' \) -print)"
if [ -n "$BAD" ]; then
  echo "CONTAMINATED STAGING DIR — refusing to zip:" >&2
  echo "$BAD" >&2
  exit 1
fi

# --- Zip ----------------------------------------------------------------------
DEST="${OUT_DIR:-$REPO/dist-zip}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
ZIP="$DEST/$NAME.zip"
rm -f "$ZIP"

# Written with python3 rather than `zip` for two reasons: every entry's mode is
# set explicitly rather than read off disk, and the entry list is the allow-list
# again — the zip can only ever contain the seven files named here.
PM_STAGE="$STAGE" PM_ZIP="$ZIP" PM_NAME="$NAME" python3 - <<'PY'
import os, zipfile
stage, zippath, name = os.environ["PM_STAGE"], os.environ["PM_ZIP"], os.environ["PM_NAME"]
entries = [("pixelmarch", 0o755), ("pixelmarch-bin", 0o755),
           ("INSTALL.txt", 0o644), ("LICENSE.txt", 0o644),
           ("THIRD-PARTY-LICENSES.txt", 0o644), ("pixelmarch.desktop", 0o644),
           ("pixelmarch.png", 0o644)]
with zipfile.ZipFile(zippath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for fname, mode in entries:
        src = os.path.join(stage, fname)
        if not os.path.isfile(src):
            raise SystemExit("missing staged file: " + src)
        # Fixed timestamp fields would need a fixed date; keep mtime but drop
        # uid/gid/host info by building the ZipInfo by hand.
        info = zipfile.ZipInfo(f"{name}/{fname}",
                               date_time=zipfile.ZipInfo.from_file(src).date_time)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3                    # unix
        info.external_attr = (mode & 0xFFFF) << 16
        with open(src, "rb") as fh:
            z.writestr(info, fh.read())
print("zip entries:")
with zipfile.ZipFile(zippath) as z:
    for i in z.infolist():
        print(f"  {oct(i.external_attr >> 16)[2:]:>6}  {i.file_size:>10}  {i.filename}")
PY

# The zip is written; the staging copy has no further use. Leaving it behind
# makes the next run without --clean abort on the not-empty guard above (and it
# is a second copy of the binary sitting in scratch).
rm -rf "$STAGE"

echo
echo "==> $ZIP ($(du -h "$ZIP" | cut -f1))"
