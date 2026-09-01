#!/usr/bin/env bash
# M3 — IDLE COST of the running PixelMarch, from the OS. Dev-only: nothing ships
# it, nothing imports it, deleting it breaks nothing.
#
# It answers the question task-5 exists for: how much work does the app do per
# minute when NOBODY IS TOUCHING IT? Two numbers per process:
#   reads/min     read syscalls (/proc/<pid>/io syscr). The brain_* IPC commands
#                 serve the GUI process's own note store, so a poller that walks
#                 the store shows up here and nowhere else. It counts EVERY read
#                 the process makes, not just brain reads — a proxy, and a good
#                 one only because the deltas are enormous. Keep the workload
#                 identical across before/after or the number means nothing.
#   cpu_ticks/min utime+stime from /proc/<pid>/stat, in clock ticks.
#
# CONDITIONS THAT MUST HOLD or this is noise (see BigBrain note
# scout-measure-harness): window visible and focused, nothing typed for the whole
# window, same workspace/pane count before and after, devtools closed, and the
# same brain corpus — the note count/bytes printed below is part of the result,
# because a bigger store inflates the reads on its own.
#
# Usage:  scripts/dev/idle-cost.sh [seconds]     (default 60)
set -u

SECS="${1:-60}"

GUI=$(pgrep -af pixelmarch | awk '!/--host/ && !/idle-cost/ {print $1; exit}')
HOST=$(pgrep -af 'pixelmarch --host' | awk '{print $1; exit}')
if [ -z "${GUI:-}" ]; then echo "no pixelmarch GUI process found" >&2; exit 1; fi

reads() { awk '/syscr/{print $2}' "/proc/$1/io" 2>/dev/null || echo 0; }
cpu()   { awk -F')' '{split($2,a," "); print a[12]+a[13]}' "/proc/$1/stat" 2>/dev/null || echo 0; }

BRAIN="$(dirname "$(readlink -f "/proc/$GUI/exe")")/brain"

r0=$(reads "$GUI"); c0=$(cpu "$GUI")
h0=$(reads "${HOST:-$GUI}"); hc0=$(cpu "${HOST:-$GUI}")
sleep "$SECS"
r1=$(reads "$GUI"); c1=$(cpu "$GUI")
h1=$(reads "${HOST:-$GUI}"); hc1=$(cpu "${HOST:-$GUI}")

per_min() { echo $(( ($2 - $1) * 60 / SECS )); }

echo "window            ${SECS}s"
if [ -d "$BRAIN" ]; then
  echo "brain notes/bytes $(find "$BRAIN" -name '*.md' | wc -l) / $(du -sb "$BRAIN" | cut -f1)"
else
  echo "brain notes/bytes (no brain dir at $BRAIN)"
fi
echo "GUI  pid $GUI   reads/min=$(per_min "$r0" "$r1")  cpu_ticks/min=$(per_min "$c0" "$c1")"
if [ -n "${HOST:-}" ]; then
  echo "HOST pid $HOST   reads/min=$(per_min "$h0" "$h1")  cpu_ticks/min=$(per_min "$hc0" "$hc1")"
else
  echo "HOST             not running (no 'pixelmarch --host' process)"
fi
