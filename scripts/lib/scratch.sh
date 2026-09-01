#!/usr/bin/env bash
# scratch.sh — the one place that decides where build scratch goes.
#
# Source it, do not run it:
#   . "$(dirname "$0")/lib/scratch.sh"
#
# Rule: build mirrors, cargo target dirs, staging dirs and worktrees live under a
# TMP root. Never under $HOME — a build must not leave anything in the user's home
# directory, and $HOME is not a scratch volume.
#
# Directory selection, highest priority first:
#   1. --scratch-dir DIR   (parsed by the calling script, exported as PIXELMARCH_SCRATCH_DIR)
#   2. $PIXELMARCH_SCRATCH_DIR
#   3. the per-purpose legacy override, if the caller already had one
#      ($BUILD_DIR for the mirror, $CARGO_TARGET_DIR for the licensed target).
#      Honoured, but announced on stderr, and REFUSED if it points inside $HOME —
#      an inherited variable is not a decision the operator made today.
#   4. $SCRATCH_DEFAULT_ROOT/pixelmarch-<purpose>, announced on stderr if that
#      lands inside $HOME (the operator owns $TMPDIR, so it is allowed — but a
#      build filling up a home directory is never allowed to be silent).
#
# Free space is checked against a per-purpose estimate BEFORE the root is used.
# If the root is too small the build STOPS and asks the operator to choose another
# location explicitly. It never silently falls back to $HOME: a scratch dir the
# operator did not pick is how gigabytes end up somewhere nobody looks.

# SCRATCH_DEFAULT_ROOT — the default root, and the ONLY line to change if the
# project ever picks a different default (e.g. a disk-backed $HOME/.cache dir
# instead of a RAM-backed tmpfs, which is capped at a fraction of RAM). Nothing
# else in the tree hardcodes a scratch root.
SCRATCH_DEFAULT_ROOT="${TMPDIR:-/tmp}"

# scratch_root — print the scratch root (no side effects, no checks).
scratch_root() {
  printf '%s' "${PIXELMARCH_SCRATCH_DIR:-$SCRATCH_DEFAULT_ROOT}"
}

# scratch_legacy_dir <purpose> — the pre-existing env override for <purpose>, if
# the operator set one. These name a full directory, not a root, and they still
# work so nobody has to re-learn a flag. An explicit --scratch-dir beats them.
scratch_legacy_dir() {
  case "$1" in
    build)           printf '%s' "${BUILD_DIR:-}" ;;
    licensed-target) printf '%s' "${CARGO_TARGET_DIR:-}" ;;
  esac
}

# scratch_legacy_var <purpose> — the NAME of that variable, for messages.
scratch_legacy_var() {
  case "$1" in
    build)           printf 'BUILD_DIR' ;;
    licensed-target) printf 'CARGO_TARGET_DIR' ;;
  esac
}

# scratch_in_home <dir> — true when <dir> is $HOME itself or lives under it.
# Compares resolved paths where realpath is available so ~/x/../pixelmarch-build
# and a symlinked $HOME do not sneak past.
scratch_in_home() {
  [ -n "${HOME:-}" ] || return 1
  local d="$1" h="$HOME"
  if command -v realpath >/dev/null 2>&1; then
    d="$(realpath -m "$d" 2>/dev/null || printf '%s' "$d")"
    h="$(realpath -m "$h" 2>/dev/null || printf '%s' "$h")"
  fi
  [ "$d" = "$h" ] && return 0
  case "$d" in "$h"/*) return 0 ;; esac
  return 1
}

# scratch_path <purpose> — print the directory for <purpose>. Does not create it.
# Callers that only need to LOOK for an artifact use this.
#
# A legacy override is honoured but never silently: it prints an stderr line every
# time it is resolved (callers run this in a command substitution, so a subshell
# "announce once" flag would not survive anyway), and it is REFUSED when it
# resolves inside $HOME. An operator typing --scratch-dir is making a choice; a
# BUILD_DIR=~/pixelmarch-build line left in a shell profile years ago is not, and
# that is exactly how this project used to fill up people's home directories.
#
# The default (level 4) is likewise announced when it lands inside $HOME —
# TMPDIR=$HOME/tmp is the operator's call, but it must not be a silent one.
scratch_path() {
  local purpose="$1" legacy
  legacy="$(scratch_legacy_dir "$purpose")"
  if [ -z "${PIXELMARCH_SCRATCH_DIR:-}" ] && [ -n "$legacy" ]; then
    local var; var="$(scratch_legacy_var "$purpose")"
    if scratch_in_home "$legacy"; then
      echo >&2
      echo "REFUSING A SCRATCH DIRECTORY INSIDE YOUR HOME DIRECTORY." >&2
      echo "  \$$var=$legacy  (legacy override, inherited from your environment)" >&2
      echo >&2
      echo "Builds do not write to \$HOME any more. Unset \$$var to use the default" >&2
      echo "$(scratch_root)/pixelmarch-$purpose, or pick a root under \$HOME on purpose" >&2
      echo "(both take a ROOT — pixelmarch-$purpose is appended to it):" >&2
      echo "  --scratch-dir $HOME/scratch          (on the script that supports it)" >&2
      echo "  PIXELMARCH_SCRATCH_DIR=$HOME/scratch  (any script)" >&2
      return 1
    fi
    echo "using \$$var=$legacy (legacy override; --scratch-dir wins over it)" >&2
    printf '%s' "$legacy"
    return 0
  fi

  local dir; dir="$(scratch_root)/pixelmarch-$purpose"
  if scratch_in_home "$dir"; then
    local src='$TMPDIR'
    [ -n "${PIXELMARCH_SCRATCH_DIR:-}" ] && src='$PIXELMARCH_SCRATCH_DIR'
    echo "scratch directory is inside your home directory: $dir (from $src)" >&2
  fi
  printf '%s' "$dir"
}

# scratch_free_mb <dir> — free space in MiB on the filesystem holding <dir>
# (or its nearest existing parent, since <dir> may not exist yet).
scratch_free_mb() {
  local d="$1"
  while [ -n "$d" ] && [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  [ -n "$d" ] || d=/
  df -Pk "$d" 2>/dev/null | awk 'NR==2{printf "%d", int($4/1024)}'
}

# scratch_ensure <purpose> <required-mb> — check space, mkdir -p, print the path.
# Exits non-zero with instructions when the root is too small.
scratch_ensure() {
  local purpose="$1" need_mb="$2"
  local dir; dir="$(scratch_path "$purpose")" || return 1
  local free_mb; free_mb="$(scratch_free_mb "$dir")"

  if [ -z "$free_mb" ]; then
    echo "cannot read free space on $dir (df failed) — refusing to guess." >&2
    scratch_explain "$need_mb"
    return 1
  fi

  if [ "$free_mb" -lt "$need_mb" ]; then
    echo >&2
    echo "NOT ENOUGH SPACE FOR THE BUILD SCRATCH DIRECTORY." >&2
    echo "  wanted: $dir" >&2
    echo "  needs:  ${need_mb} MiB    free: ${free_mb} MiB" >&2
    echo >&2
    echo "Stopping instead of falling back to your home directory." >&2
    scratch_explain "$need_mb"
    return 1
  fi

  mkdir -p "$dir" || return 1
  printf '%s' "$dir"
}

# scratch_explain <required-mb> — how to pick another scratch location.
scratch_explain() {
  echo "Pick somewhere with at least ${1} MiB free and say so explicitly:" >&2
  echo "  --scratch-dir /path/with/space          (on the script that supports it)" >&2
  echo "  PIXELMARCH_SCRATCH_DIR=/path/with/space  (any script)" >&2
  echo >&2
  echo "A larger tmpfs also works:  sudo mount -o remount,size=16G /tmp" >&2
}

# scratch_parse_arg <arg> — returns 0 and exports PIXELMARCH_SCRATCH_DIR when <arg>
# is --scratch-dir=DIR. Scripts handle the two-token "--scratch-dir DIR" form in
# their own arg loop; this covers the = form so each one does not repeat it.
scratch_parse_arg() {
  case "$1" in
    --scratch-dir=*) export PIXELMARCH_SCRATCH_DIR="${1#--scratch-dir=}"; return 0 ;;
  esac
  return 1
}

# scratch_set <dir> — validate and record an explicit --scratch-dir choice.
scratch_set() {
  [ -n "$1" ] || { echo "--scratch-dir needs a directory" >&2; return 2; }
  export PIXELMARCH_SCRATCH_DIR="$1"
}
