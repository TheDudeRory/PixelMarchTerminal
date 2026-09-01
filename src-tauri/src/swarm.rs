//! Host-side swarm enforcement — the git plumbing agents are no longer trusted
//! to run, plus the repo guard that makes the rules stick even when an agent
//! tries anyway.
//!
//! Seen live (finding-builder-continues-after-done): a builder kept working
//! after posting `done`, wrote into a removed worktree, and a full feature
//! landed DIRECTLY on master with no worktree, no review and no coordinator
//! merge. Briefs are prose; prose is not enforcement. So the host now owns the
//! mechanical git steps end to end:
//!
//!   - `swarm_worktree_add`  — the dispatcher creates a task's worktree when the
//!     claim lands; builders never run `git worktree` themselves.
//!   - `swarm_merge_task`    — the dispatcher merges an APPROVED task branch and
//!     reports manifest changes; the coordinator plans and unblocks, it never
//!     merges. Two gates live here, both written after the same incident
//!     (swarm-merge-can-destroy-builder-work): an approval on commit X
//!     authorises merging X ONLY, and a worktree is not removed until the merge
//!     is on HEAD *and* the owning pane has stopped.
//!   - `swarm_guard_install` — marker-managed `pre-commit` AND
//!     `reference-transaction` hooks plus a lock file in the git COMMON dir
//!     (shared by every worktree): while the lock exists, master/main may only
//!     be moved by the host's own git children (`PIXELMARCH_HOST_MERGE` = the
//!     token in a GRANT file that exists only while a host git child is
//!     actually running), and a task worktree may move only its OWN
//!     `swarm/task-<n>` branch.
//!   - `swarm_worktree_owner` — stamps `.pixelmarch-owner` in a task worktree
//!     so the guard can tell one builder's pane from another's.
//!   - `swarm_repo_dirty`    — the dispatcher's tripwire for stray edits landing
//!     in the root checkout while a swarm runs.
//!   - `swarm_park_strays`   — and the host's answer to them: stash the root's
//!     tracked changes out of the way so merges can resume, instead of asking a
//!     human to tidy up before anything can land.
//!   - `swarm_repo_head` / `swarm_branch_tip` — what the dispatcher compares to
//!     catch a master that moved without a host merge, and a `changes` task
//!     whose branch has new commits nobody announced.
//!
//! Why the SECOND hook exists (seen live four times, note
//! breach-builder-2-unbriefed-git-writes): `pre-commit` fires on COMMITS ONLY.
//! `git merge` writes its commit through `pre-merge-commit`, and a fast-forward
//! or a `git reset` writes no commit at all, so none of them ever reached the
//! guard. A pane resumed with a bare "continue" merged an unreviewed branch into
//! master and fast-forwarded ANOTHER builder's live branch, with the guard
//! installed and silent throughout. `reference-transaction` sees every ref
//! update — commit, merge, fast-forward, reset, `branch -f` — and aborting it
//! in the `prepared` state is what actually stops them.
//!
//! The guard is a seatbelt against a confused agent, not a security boundary:
//! anything running as the user can rip the hook out. What it ends is the
//! FAILURE MODE — an agent "helpfully" committing to master because nothing
//! stopped it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde_json::{json, Value};

/// Env var the host sets on its own git children so the guard lets the
/// host-performed merge through. Its VALUE is the token in the GRANT file, and
/// that file exists only while a host git child is actually running.
///
/// It used to be the nonce stored in the lock file for the whole life of the
/// swarm — which is a password sitting in the repo that every agent can read.
/// Seen live: a builder committed straight onto master with the guard armed and
/// both hooks intact, and the only way past them is
/// `PIXELMARCH_HOST_MERGE=$(cat .git/pixelmarch-swarm-lock)`. Nothing running as
/// the user can be locked out for good (the guard is a seatbelt, not a
/// boundary), but a credential that is only valid for the milliseconds the host
/// itself is inside `git` is not one an agent can pick up and reuse.
const HOST_MERGE_ENV: &str = "PIXELMARCH_HOST_MERGE";

const GUARD_BEGIN: &str = "# >>> pixelmarch swarm guard >>>";
const GUARD_END: &str = "# <<< pixelmarch swarm guard <<<";

/// Lock file in the git common dir: present = a swarm is active on this repo.
/// Its content is a human-readable marker and nothing else — deliberately NOT a
/// secret any more (see `HOST_MERGE_ENV`).
const LOCK_NAME: &str = "pixelmarch-swarm-lock";

/// The lock file's first line. Anything non-empty works as the "a swarm is
/// active" signal; this is for whoever finds it in a repo and wonders what it is.
const LOCK_BODY: &str = "pixelmarch swarm active - this repo's master/main and root checkout are the host's while this file exists\n";

/// The rest of the lock file: WHICH process armed the guard, and when that
/// process started.
///
/// This is the whole answer to "can I launch a swarm three seconds after
/// killing the last one". The lock is a FILE, so a `pkill`, a panic or a power
/// cut leaves it behind exactly as a clean shutdown would not — and the launch
/// path used to decide "is a swarm already running here?" from the app's own
/// persisted workspace list, which survives a kill too. Both ghosts agreed, the
/// relaunch skipped its sweep, and the new run started on the dead run's
/// worktrees and branches.
///
/// A pid alone is not enough (pids are recycled, and a low one comes back
/// within minutes of a reboot), so the process START TIME goes in beside it:
/// same pid + same start time is the same process, and nothing else is. A
/// killed host cannot fake either, which is what makes "the owner is gone" a
/// fact the launch can act on instead of a guess it has to be conservative about.
fn lock_body() -> String {
    let pid = std::process::id();
    format!("{LOCK_BODY}pid={pid}\nstart={}\n", proc_start(pid).unwrap_or(0))
}

/// When `pid` started, in seconds since the epoch — `None` if it is not running
/// (or is a corpse nobody collected). Same sysinfo probe `update.rs` uses to
/// tell a live terminal host from a stale pid file.
fn proc_start(pid: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
    let spid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[spid]), true);
    let p = sys.process(spid)?;
    if p.status() == ProcessStatus::Zombie {
        return None;
    }
    Some(p.start_time())
}

/// Who armed the guard on this repo, as read back out of the lock file.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LockOwner {
    pid: u32,
    start: u64,
}

/// Parse the `pid=` / `start=` lines out of a lock file. `None` for a lock
/// written by a build that predates them — which is treated as an owner that
/// cannot be verified, i.e. NOT live, because an unverifiable lock is exactly
/// the leftover this whole mechanism exists to clear.
fn parse_lock_owner(text: &str) -> Option<LockOwner> {
    let field = |k: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(k))
            .and_then(|v| v.trim().parse::<u64>().ok())
    };
    let pid = u32::try_from(field("pid=")?).ok()?;
    Some(LockOwner { pid, start: field("start=").unwrap_or(0) })
}

/// The short-lived host credential: written immediately before a host git child
/// runs, deleted the moment it returns. Absent = there is no value of
/// `PIXELMARCH_HOST_MERGE` that opens the guard.
const GRANT_NAME: &str = "pixelmarch-swarm-grant";

/// One host git child at a time per process, so two threads cannot delete each
/// other's grant file mid-call. Host git calls are short (plumbing, merges), so
/// this costs nothing in practice.
static HOST_GIT: Mutex<()> = Mutex::new(());

/// Written at the top of a task worktree, holding the role that owns it. The
/// `reference-transaction` guard reads it to refuse `builder-2` writing refs in
/// `builder-1`'s tree — which happened, and which no branch-name rule can catch
/// because the ref being moved WAS that worktree's own branch.
const OWNER_FILE: &str = ".pixelmarch-owner";

/// Paths kept out of every worktree's `git status` via the git common dir's
/// `info/exclude` — never the repo's own `.gitignore`, which belongs to the
/// user. `.pixelmarch-owner` matters most: builders run `git add -A`, and a
/// host marker committed onto a task branch would land in the merge.
///
/// The rest are editor/build caches that no repo wants and that a builder's
/// `git add -A` WILL otherwise commit onto a task branch — seen live: a Godot
/// mission with no `.gitignore` put 37 untracked `.godot/` artifacts in front of
/// every agent, one merge away from landing. `info/exclude` is host-side, so a
/// project that deliberately tracks one of these is unaffected: git ignores an
/// exclude rule for a file that is already tracked.
const EXCLUDED: &[&str] = &[
    ".swarm/", ".pixelmarch-owner",
    ".godot/", "node_modules/", "__pycache__/", ".venv/", "target/debug/", "target/release/",
];

/// The managed `pre-commit` block. POSIX sh — git runs hooks through sh
/// everywhere, including Git for Windows. `--git-common-dir` so the same lock
/// gates the root checkout AND every `.swarm/` worktree.
///
/// `reference-transaction` would catch both of these refusals anyway — this hook
/// is the FAST one. It runs before git writes the commit object and before the
/// index churn, so the refusal leaves far less behind than an aborted ref
/// transaction does (see the note on that in `merge_task`).
///
/// Two rules: master/main are the host's, for anyone; and the ROOT checkout is
/// off-limits to a pane carrying a `PIXELMARCH_ROLE`, on ANY branch. The second
/// is why root strays kept happening — a pane that started work in the root
/// instead of its worktree was only stopped if it happened to be on master, so
/// the work accumulated, went uncommitted, and blocked two host merges on a
/// dirty root before anyone noticed (notes salvage-task-9-root-strays,
/// correction-task-12-scope). A human terminal carries no role and is untouched.
const GUARD_BLOCK: &str = r#"# >>> pixelmarch swarm guard >>>
# PixelMarch swarm: while the swarm lock exists, agents commit on swarm/task-<n>
# branches in their own .swarm/ worktree and nowhere else; master/main are the
# host's, and so is the root checkout. Installed and removed by PixelMarch.
pm_common="$(git rev-parse --git-common-dir 2>/dev/null)"
if [ -n "$pm_common" ] && [ -f "$pm_common/pixelmarch-swarm-lock" ]; then
  # The host's grant exists only while PixelMarch itself is inside a git child.
  # No grant file = no value of PIXELMARCH_HOST_MERGE opens this.
  pm_grant=""
  [ -f "$pm_common/pixelmarch-swarm-grant" ] && pm_grant="$(cat "$pm_common/pixelmarch-swarm-grant" 2>/dev/null)"
  if [ -z "$pm_grant" ] || [ "$PIXELMARCH_HOST_MERGE" != "$pm_grant" ]; then
    pm_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
    case "$pm_branch" in
      master|main)
        echo "pixelmarch swarm guard: a swarm is active - direct commits to $pm_branch are blocked." >&2
        echo "commit on your swarm/task-<n> branch in its .swarm/ worktree; the host merges approved tasks." >&2
        exit 1
        ;;
    esac
    if [ -n "$PIXELMARCH_ROLE" ] && [ "$PIXELMARCH_ROLE" != "host" ]; then
      case "$(git rev-parse --absolute-git-dir 2>/dev/null)" in
        */worktrees/*) ;;
        *)
          echo "pixelmarch swarm guard: $PIXELMARCH_ROLE is committing in the ROOT checkout, on $pm_branch." >&2
          echo "the root is the host's while a swarm runs - your work belongs in .swarm/task-<n> on swarm/task-<n>." >&2
          echo "nothing was committed. move the files into your worktree; do not commit them here." >&2
          exit 1
          ;;
      esac
    fi
  fi
fi
# <<< pixelmarch swarm guard <<<"#;

/// The managed `reference-transaction` block — the catch-all `pre-commit` never
/// was. Git runs it for EVERY ref update, and a non-zero exit in the `prepared`
/// state aborts the whole transaction, so this is where a merge, a
/// fast-forward, a `reset --hard` and a `branch -f` are all stopped.
///
/// Only `refs/heads/*` is policed: stash, tags, notes and remote-tracking refs
/// pass untouched, so ordinary builder work (including `git stash`) is
/// unaffected. Three rules, in the order they fire:
///
///   1. the host's own git children (nonce) do anything;
///   2. inside `.swarm/task-<n>`: the owner marker must match `PIXELMARCH_ROLE`,
///      and the only movable branch is `swarm/task-<n>`;
///   3. in the ROOT checkout: master/main are the host's, and a pane carrying a
///      `PIXELMARCH_ROLE` may not move ANY branch there — the root is not its
///      workspace. A human terminal has no role, so it keeps its side branches.
const REFTX_BLOCK: &str = r#"# >>> pixelmarch swarm guard >>>
# PixelMarch swarm: every ref update passes through here while the swarm lock
# exists. pre-commit cannot see a merge, a fast-forward or a reset -- they write
# no commit -- so this hook is what actually holds. Installed by PixelMarch.
[ "$1" = "prepared" ] || exit 0
pm_common="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
[ -n "$pm_common" ] || exit 0
[ -f "$pm_common/pixelmarch-swarm-lock" ] || exit 0
# See the pre-commit block: the grant is written for the duration of one host
# git child and removed again, so outside that window nothing walks past here.
pm_grant=""
[ -f "$pm_common/pixelmarch-swarm-grant" ] && pm_grant="$(cat "$pm_common/pixelmarch-swarm-grant" 2>/dev/null)"
if [ -n "$pm_grant" ] && [ "$PIXELMARCH_HOST_MERGE" = "$pm_grant" ]; then exit 0; fi
pm_deny() {
  echo "pixelmarch swarm guard: $1" >&2
  echo "only the PixelMarch host moves master/main, and a builder moves only its own swarm/task-<n> branch inside its own .swarm/ worktree." >&2
  echo "if you were resumed with a bare 'continue': read your own role-<you> note before any git command." >&2
  echo "the branch did NOT move, but git had already written your index and working tree: this checkout may be dirty now." >&2
  echo "do not try to tidy it - say so in chat and let the host resolve it." >&2
  exit 1
}
pm_gd="$(git rev-parse --absolute-git-dir 2>/dev/null)"
pm_task=""
case "$pm_gd" in
  */worktrees/*) pm_task="${pm_gd##*/}" ;;
esac
if [ -n "$pm_task" ]; then
  pm_owner_file="$(git rev-parse --show-toplevel 2>/dev/null)/.pixelmarch-owner"
  if [ -f "$pm_owner_file" ]; then
    pm_owner="$(cat "$pm_owner_file" 2>/dev/null)"
    if [ -n "$pm_owner" ] && [ -n "$PIXELMARCH_ROLE" ] && [ "$pm_owner" != "$PIXELMARCH_ROLE" ]; then
      pm_deny "$PIXELMARCH_ROLE is writing refs in $pm_task's worktree, which belongs to $pm_owner."
    fi
  fi
fi
while read -r pm_old pm_new pm_ref; do
  case "$pm_ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  # A no-op write moves nothing. git emits one while finishing `worktree add`.
  [ "$pm_old" = "$pm_new" ] && continue
  case "$pm_ref" in
    refs/heads/master|refs/heads/main)
      pm_deny "a swarm is active - $pm_ref is the host's to move." ;;
  esac
  if [ -n "$pm_task" ]; then
    if [ "$pm_ref" != "refs/heads/swarm/$pm_task" ]; then
      pm_deny "$pm_ref is not this worktree's branch (swarm/$pm_task)."
    fi
  elif [ -n "$PIXELMARCH_ROLE" ] && [ "$PIXELMARCH_ROLE" != "host" ]; then
    # `git worktree add .swarm/task-<n> -b swarm/task-<n>` runs from the ROOT and
    # CREATES the branch, which is the one legitimate root ref write a builder
    # makes. Creation is decided by asking whether the ref exists YET -- the old
    # value in the transaction is all-zeros even for a forced update, so it
    # cannot tell a create from an overwrite.
    case "$pm_ref" in
      refs/heads/swarm/*)
        if git rev-parse --verify --quiet "$pm_ref" >/dev/null 2>&1; then
          pm_deny "$pm_ref already exists - a branch that is not yours is not yours to move."
        fi
        continue
        ;;
    esac
    pm_deny "$PIXELMARCH_ROLE is writing $pm_ref in the ROOT checkout - your work belongs in .swarm/task-<n>."
  fi
done
# <<< pixelmarch swarm guard <<<"#;

/// A task key we will put on a command line. Anything else is refused before
/// git ever sees it — these strings come over IPC from the webview.
fn valid_task(task: &str) -> bool {
    task.strip_prefix("task-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Run one git command in `cwd`. Ok(stdout) on exit 0, Err(combined output)
/// otherwise. `host_marked` carries the lock file's nonce, which is what the
/// guard recognises as "this is the host itself" — set on every call that MOVES
/// A REF, because the `reference-transaction` guard refuses ref writes at the
/// root checkout and the host's own worktree bookkeeping happens there.
fn git(cwd: &str, args: &[&str], host_marked: bool) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    // The grant lives exactly as long as this child. `_grant` holds the process
    // lock and deletes the file on drop, including on an early return or a panic
    // inside `output()` — a leaked grant would be the old always-readable
    // credential all over again.
    let _grant = if host_marked {
        let g = HostGrant::mint(cwd);
        cmd.env(HOST_MERGE_ENV, g.token.clone());
        Some(g)
    } else {
        None
    };
    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() {
                Ok(stdout)
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if stderr.is_empty() { stdout } else { format!("{stdout}\n{stderr}").trim().to_string() })
            }
        }
        Err(e) => Err(format!("git {}: {e}", args.join(" "))),
    }
}

/// The repo's git COMMON dir (shared by all worktrees), absolute.
fn git_common_dir(cwd: &str) -> Result<PathBuf, String> {
    let out = git(cwd, &["rev-parse", "--git-common-dir"], false)?;
    let p = PathBuf::from(out.trim());
    Ok(if p.is_absolute() { p } else { Path::new(cwd).join(p) })
}

/// The host's credential for ONE git child: a fresh token written to the grant
/// file in the git common dir, removed again when this value is dropped. Holds
/// `HOST_GIT` for its whole life, so two host git calls never overlap and the
/// file always describes the child that is running right now.
///
/// A repo with no common dir (not a git repo) still yields a grant — with no
/// file to write, the token simply opens nothing, and the caller's git command
/// fails on its own terms.
struct HostGrant {
    token: String,
    path: Option<PathBuf>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl HostGrant {
    fn mint(cwd: &str) -> HostGrant {
        let lock = HOST_GIT.lock().unwrap_or_else(|e| e.into_inner());
        let token = uuid::Uuid::new_v4().simple().to_string();
        let path = git_common_dir(cwd).ok().map(|c| c.join(GRANT_NAME));
        if let Some(p) = &path {
            // Best-effort: an unwritable common dir means the guard simply keeps
            // refusing, which is the safe direction to fail in.
            let _ = std::fs::write(p, format!("{token}\n"));
        }
        HostGrant { token, path, _lock: lock }
    }
}

impl Drop for HostGrant {
    fn drop(&mut self) {
        if let Some(p) = &self.path {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Make sure the host's own artefacts are ignored via `.git/info/exclude` (one
/// file, shared by every worktree) — never the repo's own `.gitignore`, which
/// belongs to the user and would show up as a diff.
fn ensure_swarm_excluded(cwd: &str) {
    let Ok(common) = git_common_dir(cwd) else { return };
    let info = common.join("info");
    let _ = std::fs::create_dir_all(&info);
    let exclude = info.join("exclude");
    let mut cur = std::fs::read_to_string(&exclude).unwrap_or_default();
    let mut changed = false;
    for want in EXCLUDED {
        let bare = want.trim_end_matches('/');
        let present = cur.lines().any(|l| {
            let t = l.trim().trim_start_matches('/').trim_end_matches('/');
            t == bare
        });
        if present {
            continue;
        }
        if !cur.is_empty() && !cur.ends_with('\n') {
            cur.push('\n');
        }
        cur.push_str(want);
        cur.push('\n');
        changed = true;
    }
    if changed {
        let _ = std::fs::write(&exclude, cur);
    }
}

/// Tracked-file changes in the ROOT checkout (worktrees have their own trees).
fn dirty_files(cwd: &str) -> Vec<String> {
    git(cwd, &["status", "--porcelain", "--untracked-files=no"], false)
        .map(|out| out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// Untracked paths in the ROOT checkout — the work a launch is about to hide
/// from every builder.
///
/// `git worktree add` checks out a COMMIT, so a file that exists only in the
/// root's working tree is not in the task worktree at all and no agent can see
/// it. Seen live: a mission's dashboard and admin sources sat untracked in the
/// root, the builder found them missing, wrote its own from scratch, committed
/// them, and the reviewer read them as brand-new files absent from the base
/// commit — two versions of the same work, one of them about to be merged over
/// the other. Nothing errors on the way there, which is why nothing catches it:
/// `dirty_files` passes `--untracked-files=no` on purpose (that tripwire is
/// about ref-blocking stray EDITS), so a root full of untracked work reads as
/// perfectly clean.
///
/// The host's `info/exclude` set is applied first, so `.swarm/` and the usual
/// build caches never reach the warning — only files a human might have meant
/// to commit. Directories come back collapsed, exactly as git prints them.
fn untracked_files(cwd: &str) -> Vec<String> {
    ensure_swarm_excluded(cwd);
    // `-z` because git C-quotes any path with a space or a non-ASCII byte in the
    // plain format, and a warning that names `"src/my file.ts"` in quotes is a
    // warning about a file the human cannot find.
    git(cwd, &["status", "--porcelain", "-z", "--untracked-files=normal"], false)
        .map(|out| out.split('\0').filter_map(|e| e.strip_prefix("?? ")).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Create (or find) the isolated worktree for `task` at `.swarm/<task>` on
/// branch `swarm/<task>`. Idempotent: the dispatcher calls it on every tick a
/// claimed task has no known worktree, and calling it twice is a no-op.
#[tauri::command]
pub async fn swarm_worktree_add(cwd: String, task: String) -> Value {
    if !valid_task(&task) {
        return json!({ "ok": false, "error": format!("bad task key {task:?}") });
    }
    let dir_rel = format!(".swarm/{task}");
    let branch = format!("swarm/{task}");
    let dir_abs = Path::new(&cwd).join(&dir_rel);
    if dir_abs.join(".git").exists() {
        return json!({ "ok": true, "existed": true, "path": dir_rel, "branch": branch });
    }
    ensure_swarm_excluded(&cwd);
    // A leftover DIRECTORY from a removed worktree blocks `git worktree add`.
    // `.swarm/` is host-owned (git-excluded, created only by this command), so
    // clearing a stale one is cleanup, not data loss — but only when git agrees
    // it is not a registered worktree (no .git marker, checked above).
    if dir_abs.exists() {
        let _ = std::fs::remove_dir_all(&dir_abs);
        let _ = git(&cwd, &["worktree", "prune"], true);
    }
    let have_branch = git(&cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], false).is_ok();
    // Host-marked: `worktree add` CREATES refs/heads/swarm/<task>, and the
    // reference-transaction guard refuses ref writes from the root checkout.
    let res = if have_branch {
        git(&cwd, &["worktree", "add", &dir_rel, &branch], true)
    } else {
        git(&cwd, &["worktree", "add", &dir_rel, "-b", &branch], true)
    };
    match res {
        Ok(_) => json!({ "ok": true, "existed": false, "path": dir_rel, "branch": branch }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// The branch namespace an OLD build parked swept commits in. Nothing writes it
/// any more — a launch nukes instead of salvaging — but leftovers from a repo
/// that ran that build are cleared with everything else, because "the launch
/// leaves nothing of PixelMarch's behind" has to mean nothing.
const SALVAGE_PREFIX: &str = "pixelmarch-salvage";

/// Task keys with something left over in the repo: a `.swarm/<task-n>`
/// directory, a `swarm/<task-n>` branch, or both. Both halves are looked up
/// because they rot independently — a released worktree deletes both, an
/// abandoned swarm leaves both, and a hand-cleaned `rm -rf .swarm` leaves only
/// the branch (which is the case that quietly re-checks OLD commits out into a
/// NEW run's tree, see `swarm_worktree_add`'s `have_branch` path).
fn leftover_tasks(cwd: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(Path::new(cwd).join(".swarm")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if valid_task(&name) && e.path().is_dir() {
                keys.push(name);
            }
        }
    }
    if let Ok(out) = git(cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads/swarm/"], false) {
        for line in out.lines() {
            let Some(key) = line.trim().strip_prefix("swarm/") else { continue };
            if valid_task(key) && !keys.iter().any(|k| k == key) {
                keys.push(key.to_string());
            }
        }
    }
    keys.sort_by_key(|k| k.trim_start_matches("task-").parse::<u64>().unwrap_or(u64::MAX));
    keys
}

/// Destroy every trace of ONE leftover task: its worktree directory and its
/// branch, unconditionally.
///
/// This does not try to be clever, and that is deliberate. It used to: it
/// committed whatever the last run left uncommitted, then renamed any unmerged
/// branch to `pixelmarch-salvage/<task>-<sha>` instead of deleting it, on the
/// theory that a launch should never destroy work. Every one of those steps had
/// a failure mode that ended the same way — the branch stayed, `swept: false`
/// came back with a reason, and the NEW run's task of that number started on the
/// OLD run's commits. A launch that half-cleans is worse than useless, because
/// what it leaves behind is invisible in the new run.
///
/// So: the worktree goes, the branch goes. Both are PixelMarch's own — it
/// created them, it named them, and no human puts work on `swarm/task-<n>` by
/// hand. Nothing outside that namespace is touched, in this repo or any other.
fn sweep_task(cwd: &str, task: &str) -> Value {
    let dir_rel = format!(".swarm/{task}");
    let branch = format!("swarm/{task}");
    let dir_abs = Path::new(cwd).join(&dir_rel);
    let kept = |reason: &str| json!({ "task": task, "swept": false, "reason": reason });

    // ── the worktree ──────────────────────────────────────────────────────
    // Three passes because they fail differently: git's own removal handles the
    // admin file, `remove_dir_all` handles a directory git has already forgotten
    // (or refuses to touch because it is dirty), and `prune` clears the admin
    // entry of a directory that is already gone.
    if dir_abs.exists() {
        let _ = git(cwd, &["worktree", "remove", "--force", &dir_rel], true);
        let _ = std::fs::remove_dir_all(&dir_abs);
        let _ = git(cwd, &["worktree", "prune"], true);
        if dir_abs.exists() {
            return kept("the worktree directory could not be removed");
        }
    } else {
        let _ = git(cwd, &["worktree", "prune"], true);
    }

    // ── the branch ────────────────────────────────────────────────────────
    // `-D`, not `-d`: unmerged is the normal case for an abandoned run, and it
    // is exactly the case that must not survive into the next one.
    if rev_commit(cwd, &format!("refs/heads/{branch}")).is_none() {
        return json!({ "task": task, "swept": true, "worktree": true, "branch": Value::Null });
    }
    match git(cwd, &["branch", "-D", &branch], true) {
        Ok(_) => json!({ "task": task, "swept": true, "branch": branch, "deleted": true }),
        Err(e) => kept(&format!("branch {branch} would not delete: {e}")),
    }
}

/// Clear the PREVIOUS run's task worktrees and branches out of a repo, at the
/// moment a new swarm launches.
///
/// The collision this fixes: the brain project id is fresh per launch (task ids
/// restart at `task-1`), but `.swarm/task-<n>` and `swarm/task-<n>` are
/// REPO-scoped. Left alone, a second swarm's `task-1` inherits the first one's
/// tree, branch and commits through `swarm_worktree_add`'s `existed` /
/// `have_branch` paths, and `merge_landed` — which greps HEAD for
/// `merge: {task} (swarm {project})` — used to grep for it with no notion of
/// which swarm, and read the OLD run's merge commit as this task's, which is
/// enough for `release_worktree` to drop a live tree. The subject carries the
/// project now (`merge_subject`), so the sweep is no longer the only thing
/// standing between a relaunch and that: it is the thing that stops the new run
/// STARTING on the old run's commits.
///
/// What a launch destroys, and the boundary it will not cross: everything
/// PixelMarch itself created in this repo — `.swarm/` entire, every
/// `swarm/task-<n>` branch, and any `pixelmarch-salvage/*` an older build left —
/// and nothing else, ever. Not the user's branches, not their working tree, not
/// their stashes. A swarm runs on whatever repo it is pointed at, so "clean up
/// after ourselves" is the only rule that is safe in a repo we know nothing
/// about; anything wider would be deleting a stranger's work on launch.
///
/// Inside that namespace there is no salvage and no half-measure. The previous
/// design committed uncommitted work and renamed unmerged branches aside, and
/// every way that could fail ended with the branch still there and the new run
/// silently starting on the old run's commits.
///
/// `live` is the same shape as `release_worktree`'s `owner_stopped`, for the
/// same reason: only the host UI can know whether another swarm is already
/// running on this repo, panes live in the webview, and the destructive
/// direction must be the one that needs an explicit answer. Anything other than
/// `Some(false)` sweeps nothing.
#[tauri::command]
pub async fn swarm_worktree_sweep(cwd: String, live: Option<bool>) -> Value {
    sweep_worktrees(&cwd, live)
}

/// Synchronous body of `swarm_worktree_sweep`, so the tests can drive a real repo.
fn sweep_worktrees(cwd: &str, live: Option<bool>) -> Value {
    if live != Some(false) {
        return json!({ "ok": false, "error": "refusing to sweep: the caller did not confirm that no swarm is live on this repo" });
    }
    if git(cwd, &["rev-parse", "--git-common-dir"], false).is_err() {
        return json!({ "ok": false, "error": "not a git repository" });
    }
    // The host's own artefacts, out of every `git status` before anything else
    // runs.
    ensure_swarm_excluded(cwd);
    let mut swept = Vec::new();
    let mut kept = Vec::new();
    for task in leftover_tasks(cwd) {
        let res = sweep_task(cwd, &task);
        if res["swept"] == true { swept.push(res) } else { kept.push(res) }
    }
    // Whatever an older build parked instead of deleting. A repo that never ran
    // one has none of these and this is a no-op.
    let mut salvage_branches = Vec::new();
    if let Ok(out) = git(cwd, &["for-each-ref", "--format=%(refname:short)", &format!("refs/heads/{SALVAGE_PREFIX}/")], false) {
        for line in out.lines() {
            let b = line.trim().to_string();
            if !b.is_empty() && git(cwd, &["branch", "-D", &b], true).is_ok() {
                salvage_branches.push(b);
            }
        }
    }
    // The `.swarm` directory itself, once every task in it is gone. A launch
    // that leaves an empty shell behind is fine; one that leaves a stray file a
    // builder dropped in there is how the next run finds a tree it did not make.
    let swarm_dir = Path::new(cwd).join(".swarm");
    let mut dir_removed = false;
    if swarm_dir.exists() && kept.is_empty() {
        dir_removed = std::fs::remove_dir_all(&swarm_dir).is_ok();
    }
    let _ = git(cwd, &["worktree", "prune"], true);
    json!({ "ok": true, "swept": swept, "kept": kept, "salvage_branches": salvage_branches, "swarm_dir_removed": dir_removed })
}

/// Filenames whose change in a merge means "install at the root now".
const MANIFESTS: &[&str] = &[
    "package.json", "package-lock.json", "Cargo.toml", "Cargo.lock",
    "requirements.txt", "pyproject.toml", "go.mod", "go.sum", "Gemfile", "composer.json",
];

/// A commit id we are willing to put on a git command line, and the shape a
/// reviewer writes: git's own abbreviations start at 7 hex digits.
fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Every SHA-shaped token in `text`, in order. Reviewers record an approval as
/// prose — "approved by reviewer-1 @ c15533e7" — so the caller may hand us the
/// whole log line instead of a bare id. Being permissive here is safe because
/// nothing is trusted until git resolves it AND places it on the branch, so a
/// hex-looking English word simply fails to verify.
fn sha_candidates(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| is_sha(t))
        .map(str::to_ascii_lowercase)
        .collect()
}

/// The full commit id `rev` resolves to, or None.
fn rev_commit(cwd: &str, rev: &str) -> Option<String> {
    git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")], false)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The commit an approval refers to: the first SHA-shaped token in `text` that
/// git knows AND that is an ancestor of (or equal to) `branch`. A SHA from some
/// other branch is not an approval of this one.
fn resolve_approved(cwd: &str, branch: &str, text: &str) -> Option<String> {
    sha_candidates(text).into_iter().find_map(|cand| {
        let full = rev_commit(cwd, &cand)?;
        git(cwd, &["merge-base", "--is-ancestor", &full, branch], false).ok().map(|_| full)
    })
}

/// A project id fit for a commit subject and a `--grep` pattern. The launcher
/// mints `<parent>-swarm-<slug>-<uid>`, so anything outside that alphabet is a
/// caller we do not recognise rather than something to quote. Stripped rather
/// than refused — a merge must never fail over cosmetics — and an id that strips
/// to nothing falls back to the unnamespaced subject.
fn sanitize_project(p: &str) -> String {
    p.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).take(120).collect()
}

/// The subject the host writes on every merge it performs, and the pattern it
/// greps for to verify one — one function so those two can never drift.
///
/// NAMESPACED BY SWARM PROJECT, because task ids restart at `task-1` on every
/// launch while a repo's history does not. Unnamespaced, a PREVIOUS run's
/// `merge: task-1 (swarm)` answered for THIS run's task-1: `merge_landed` said
/// yes for a task that had merged nothing, which is half of the
/// worktree-release gate — and the other half (a stopped owner pane) happens on
/// every context reset. The closing paren is part of the match, so one project
/// id can never satisfy the grep for another that it is a prefix of.
///
/// `None` reproduces the old subject. A repo carrying unnamespaced merges from
/// before this change simply stops recognising them, which keeps a worktree it
/// would otherwise have released — the safe direction, and `swarm_worktree_sweep`
/// clears those at the next launch anyway.
fn merge_subject(task: &str, project: Option<&str>) -> String {
    match project.map(sanitize_project).filter(|p| !p.is_empty()) {
        Some(p) => format!("merge: {task} (swarm {p})"),
        None => format!("merge: {task} (swarm)"),
    }
}

/// Is the host's own merge commit for `task` — from THIS swarm — on HEAD? The
/// host verifying the merge in GIT rather than believing a status handed to it
/// over IPC: the "verify every claim on merged master" rule from
/// [[swarm-coordinator-merge-discipline]], turned into code.
fn merge_landed(cwd: &str, task: &str, project: Option<&str>) -> bool {
    git(cwd, &["log", "-F", "--grep", &merge_subject(task, project), "--format=%H", "-n", "1", "HEAD"], false)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Drop a task's worktree and branch — ONLY when BOTH conditions hold.
///
/// 1. the merge is really on HEAD (git-verified here, not claimed by the caller), AND
/// 2. the owning pane has STOPPED (`owner_stopped == Some(true)`).
///
/// BOTH, never either. `git worktree remove --force` deletes uncommitted files,
/// and running it while a builder is still editing is exactly what destroyed a
/// round of work (note swarm-merge-can-destroy-builder-work): the bus said
/// "merged" before the builder said "done", one condition was enough, and the
/// tree went. Only the host UI can know (2) — panes live in the webview — so it
/// is an argument, and anything other than an explicit `true` (including the
/// `None` a caller that has not been taught to pass it sends) keeps the tree.
/// Leaving a worktree behind costs a stale directory that `swarm_worktree_add`
/// cleans up on reuse; removing one early costs work that cannot be recovered.
fn release_worktree(cwd: &str, task: &str, project: Option<&str>, owner_stopped: Option<bool>) -> Value {
    let dir_rel = format!(".swarm/{task}");
    let branch = format!("swarm/{task}");
    if !merge_landed(cwd, task, project) {
        return json!({ "released": false, "reason": "not merged on this branch", "path": dir_rel });
    }
    if owner_stopped != Some(true) {
        return json!({ "released": false, "reason": "owner pane not confirmed stopped", "path": dir_rel });
    }
    // Best-effort from here: the merge is already in — a worktree that refuses to
    // go must not turn a landed merge into a reported failure.
    let _ = git(cwd, &["worktree", "remove", "--force", &dir_rel], true);
    let _ = std::fs::remove_dir_all(Path::new(cwd).join(&dir_rel)); // leftovers (untracked files)
    let _ = git(cwd, &["branch", "-D", &branch], true); // deleting a ref is a ref write — host-marked
    let _ = git(cwd, &["worktree", "prune"], true);
    json!({ "released": true, "path": dir_rel, "branch": branch })
}

/// Merge an approved task branch into the CURRENT branch of the root checkout.
/// This is the host's merge — the only path that produces a `merged` task, and
/// the only git child that carries `PIXELMARCH_HOST_MERGE=1` past the guard.
///
/// `approved` is the commit the reviewer actually READ (a bare SHA, or the whole
/// approval log line to pull one out of). An approval on commit X authorises
/// merging X and nothing else: if the branch has moved on, the merge is REFUSED
/// with `moved: true` and both SHAs, plus a ready-to-post `changes_log`, so the
/// task goes back for a re-gate instead of the host quietly merging commits no
/// reviewer ever saw. That is not hypothetical — it happened, twice
/// (swarm-merge-can-destroy-builder-work). Passing `None` merges UNGATED and
/// says so in the result (`gated: false`); a caller that can name the approved
/// commit should.
///
/// `owner_stopped` is the second half of the worktree rule — see
/// `release_worktree`. Cleanup is deliberately not automatic: call again once the
/// pane is confirmed stopped and the idempotent path releases it then.
///
/// On conflict the merge is aborted and reported (`conflict: true`) so the
/// dispatcher can hand the task back to its owner as `changes`; the root
/// checkout is left exactly as it was.
#[tauri::command]
pub async fn swarm_merge_task(
    cwd: String,
    task: String,
    project: Option<String>,
    approved: Option<String>,
    owner_stopped: Option<bool>,
) -> Value {
    merge_task(&cwd, &task, project.as_deref(), approved.as_deref(), owner_stopped)
}

/// The whole of `swarm_merge_task`, synchronous so tests can drive it against a
/// real repo without a runtime. Nothing in here is async — it is all `git`.
fn merge_task(cwd: &str, task: &str, project: Option<&str>, approved: Option<&str>, owner_stopped: Option<bool>) -> Value {
    if !valid_task(task) {
        return json!({ "ok": false, "error": format!("bad task key {task:?}") });
    }
    let branch = format!("swarm/{task}");
    if git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], false).is_err() {
        // Branch gone. Two cases: (a) a PRIOR merge landed and deleted the branch
        // but its "merged" status write to the brain was lost — every later tick
        // then re-enters here forever with the task still `approved`; (b) the
        // branch genuinely never existed. Tell them apart by the merge commit the
        // host writes on every success. If it's on HEAD, the merge already
        // happened: report ok so the dispatcher can re-post `merged` idempotently
        // instead of silently spinning. Otherwise it's a real missing branch.
        if merge_landed(cwd, task, project) {
            return json!({ "ok": true, "merged": branch, "already": true, "manifests": [],
                           "worktree": release_worktree(cwd, task, project, owner_stopped) });
        }
        return json!({ "ok": false, "no_branch": true, "error": format!("no branch {branch}") });
    }
    let head = rev_commit(cwd, &format!("refs/heads/{branch}")).unwrap_or_default();
    // GATE 1 — an approval names a commit, not a branch.
    let gate = approved.map(str::trim).filter(|s| !s.is_empty());
    if let Some(text) = gate {
        let Some(app) = resolve_approved(cwd, &branch, text) else {
            return json!({ "ok": false, "unresolved_approval": true, "branch": branch, "head_sha": head,
                           "error": format!("no commit on {branch} matches the approval {text:?} — re-gate it and record the SHA the reviewer read") });
        };
        if app != head {
            let ahead = git(cwd, &["rev-list", "--count", &format!("{app}..{branch}")], false).unwrap_or_default();
            let short = |s: &str| s.chars().take(8).collect::<String>();
            let (a, h) = (short(&app), short(&head));
            return json!({
                "ok": false, "moved": true, "branch": branch,
                "approved_sha": app, "head_sha": head, "ahead": ahead,
                "changes_log": format!(
                    "merge refused: reviewer approved {a} but swarm/{task} is now at {h} ({ahead} commit(s) later). \
                     An approval covers ONE commit — re-review the new commits, or reset the branch to {a}."),
                "error": format!("branch {branch} moved past the approved commit ({a} -> {h}) — not merging unreviewed work"),
            });
        }
    }
    // The guard's own footprint. `reference-transaction` aborts a hand-merge at
    // the REF UPDATE, i.e. after git has written the merge into the index and
    // the working tree. Git usually unwinds that, but the fixture below caught a
    // refused merge leaving MERGE_HEAD behind, and the very next merge in that
    // repo died on "You have not concluded your merge". An in-progress merge at
    // the root is never legitimate during a swarm — the host's own merge either
    // completes or aborts inside one call — so clear it. Only this: `merge
    // --abort` restores the pre-merge state and destroys nothing, whereas plain
    // dirt (a refused `reset --hard` rewrites the tree too) is refused below and
    // left for a human. Never auto-discard a working tree.
    let stray_merge = rev_commit(cwd, "MERGE_HEAD").is_some();
    if stray_merge {
        let _ = git(cwd, &["merge", "--abort"], true);
    }
    // A dirty root would either fail the merge or fold stray edits into the
    // merge commit. Refuse loudly; the dispatcher surfaces it to the human.
    let dirty = dirty_files(cwd);
    if !dirty.is_empty() {
        return json!({ "ok": false, "reason": "repo dirty", "dirty": dirty, "aborted_stray_merge": stray_merge,
                       "error": "the root checkout has uncommitted tracked changes — not merging over them" });
    }
    let before = rev_commit(cwd, "HEAD");
    match git(cwd, &["merge", "--no-ff", "--no-edit", "-m", &merge_subject(task, project), &branch], true) {
        Ok(_) => {
            // "Already up to date" exits 0 and writes NO commit. Without this the
            // repeat call that exists to release a worktree would re-report the
            // PREVIOUS merge's manifests and send the coordinator installing again.
            let already = rev_commit(cwd, "HEAD") == before;
            let manifests: Vec<String> = if already {
                Vec::new()
            } else {
                git(cwd, &["diff", "--name-only", "HEAD^", "HEAD"], false)
                    .map(|out| {
                        out.lines()
                            .filter(|l| {
                                Path::new(l).file_name().and_then(|f| f.to_str()).is_some_and(|f| MANIFESTS.contains(&f))
                            })
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default()
            };
            json!({ "ok": true, "merged": branch, "already": already, "manifests": manifests,
                    "gated": gate.is_some(), "aborted_stray_merge": stray_merge,
                    "worktree": release_worktree(cwd, task, project, owner_stopped) })
        }
        Err(e) => {
            let _ = git(cwd, &["merge", "--abort"], true);
            json!({ "ok": false, "conflict": true, "error": e })
        }
    }
}

/// Stamp `.pixelmarch-owner` at the top of a task's worktree with the role the
/// bus says owns it. The `reference-transaction` guard compares it to the
/// pane's `PIXELMARCH_ROLE` and refuses a ref write from anyone else.
///
/// This closes the one breach no branch rule can: `builder-2`, resumed without
/// a brief, ran `git merge --ff-only master` INSIDE `.swarm/task-12` and moved
/// `swarm/task-12` — the correct branch, in the correct worktree, by the wrong
/// pane, under a live `builder-1`. Only identity tells those apart.
///
/// Called from the dispatcher on every tick a claim's owner changes (a reclaim
/// flips it), so the marker follows the bus rather than the worktree's birth.
/// `ok: false` when the worktree does not exist yet — the caller retries.
#[tauri::command]
pub async fn swarm_worktree_owner(cwd: String, task: String, owner: String) -> Value {
    worktree_owner(&cwd, &task, &owner)
}

/// Synchronous body of `swarm_worktree_owner`, so the tests can drive it.
fn worktree_owner(cwd: &str, task: &str, owner: &str) -> Value {
    if !valid_task(task) {
        return json!({ "ok": false, "error": format!("bad task key {task:?}") });
    }
    // The role goes into a file the hook reads with `cat`; keep it to the shape
    // a role name actually has so nothing else can be smuggled through it.
    if owner.is_empty() || !owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return json!({ "ok": false, "error": format!("bad owner {owner:?}") });
    }
    let dir = Path::new(cwd).join(".swarm").join(task);
    if !dir.join(".git").exists() {
        return json!({ "ok": false, "no_worktree": true });
    }
    let marker = dir.join(OWNER_FILE);
    if std::fs::read_to_string(&marker).map(|s| s.trim() == owner).unwrap_or(false) {
        return json!({ "ok": true, "owner": owner, "changed": false });
    }
    match std::fs::write(&marker, format!("{owner}\n")) {
        Ok(_) => json!({ "ok": true, "owner": owner, "changed": true }),
        Err(e) => json!({ "ok": false, "error": format!("could not write {}: {e}", marker.display()) }),
    }
}

/// Uncommitted TRACKED changes in the root checkout — the dispatcher's tripwire
/// for an agent editing outside its worktree.
#[tauri::command]
pub async fn swarm_repo_dirty(cwd: String) -> Value {
    let files = dirty_files(&cwd);
    json!({ "ok": true, "dirty": !files.is_empty(), "files": files })
}

/// Untracked root files a launch is about to hide from every builder — the
/// pre-launch warning, see `untracked_files`. Read-only apart from the host's
/// `info/exclude` entries, which the launch writes moments later anyway.
#[tauri::command]
pub async fn swarm_untracked(cwd: String) -> Value {
    let files = untracked_files(&cwd);
    json!({ "ok": true, "untracked": !files.is_empty(), "files": files })
}

/// Park the root checkout's stray edits in a git stash so merges can resume.
///
/// Nagging was the old answer and it does not work: a dirty root REFUSES every
/// host merge, and the swarm that hit it spent its coordinator's only turn
/// asking a human to tidy up, then sat. Stashing is the reversible version of
/// "clean it": nothing is discarded, `git stash list` still has it, and the
/// message the dispatcher posts carries the restore command.
///
/// Tracked changes only — same set `swarm_repo_dirty` reports and the same set
/// that blocks a merge. Untracked files are left alone: they block nothing, and
/// hoovering up a human's scratch file is not this function's business.
#[tauri::command]
pub async fn swarm_park_strays(cwd: String, label: String) -> Value {
    park_strays(&cwd, &label)
}

/// Synchronous body of `swarm_park_strays`, so the tests can drive it.
fn park_strays(cwd: &str, label: &str) -> Value {
    let files = dirty_files(cwd);
    if files.is_empty() {
        return json!({ "ok": true, "parked": false, "files": [] });
    }
    // The message goes on a git command line; keep it to one boring line.
    let msg: String = label.chars().filter(|c| !c.is_control()).take(120).collect();
    let msg = if msg.trim().is_empty() { "pixelmarch swarm: root strays".to_string() } else { msg };
    // `stash push` writes refs/stash (the guard only polices refs/heads) but also
    // rewrites the working tree, so it runs host-marked like every other host git.
    match git(cwd, &["stash", "push", "-m", &msg], true) {
        Ok(_) => {
            let left = dirty_files(cwd);
            if left.is_empty() {
                let stash = git(cwd, &["rev-parse", "--verify", "--quiet", "refs/stash"], false).unwrap_or_default();
                json!({ "ok": true, "parked": true, "files": files, "stash": stash, "label": msg })
            } else {
                // Something survived the stash (a submodule, an unmergeable state).
                // Say so rather than report a clean root that is not clean.
                json!({ "ok": false, "parked": false, "files": files, "left": left,
                        "error": "stash ran but the root is still dirty" })
            }
        }
        Err(e) => json!({ "ok": false, "parked": false, "files": files, "error": e }),
    }
}

/// The root checkout's current commit, its subject line, and the branch it is
/// on. The dispatcher samples this every tick: master moving while no host merge
/// is running means someone walked past the guard, and that is the one failure
/// nothing else in the system can see (it looks exactly like a healthy repo
/// afterwards — seen live, found the next morning).
#[tauri::command]
pub async fn swarm_repo_head(cwd: String) -> Value {
    repo_head(&cwd)
}

/// Synchronous body of `swarm_repo_head`, so the tests can drive it.
fn repo_head(cwd: &str) -> Value {
    let Some(sha) = rev_commit(cwd, "HEAD") else {
        return json!({ "ok": false, "error": "no HEAD" });
    };
    let subject = git(cwd, &["log", "-1", "--format=%s", "HEAD"], false).unwrap_or_default();
    let branch = git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], false).unwrap_or_default();
    json!({ "ok": true, "sha": sha, "subject": subject, "branch": branch })
}

/// The tip commit of a task's branch (and whether it exists at all). Used to
/// tell "the builder fixed it and never said so" from "nothing happened yet"
/// on a task sitting at `changes`.
#[tauri::command]
pub async fn swarm_branch_tip(cwd: String, task: String) -> Value {
    branch_tip(&cwd, &task)
}

/// Synchronous body of `swarm_branch_tip`, so the tests can drive it.
fn branch_tip(cwd: &str, task: &str) -> Value {
    if !valid_task(task) {
        return json!({ "ok": false, "error": format!("bad task key {task:?}") });
    }
    let branch = format!("swarm/{task}");
    match rev_commit(cwd, &format!("refs/heads/{branch}")) {
        Some(sha) => {
            let subject = git(cwd, &["log", "-1", "--format=%s", &branch], false).unwrap_or_default();
            json!({ "ok": true, "exists": true, "branch": branch, "sha": sha, "subject": subject })
        }
        None => json!({ "ok": true, "exists": false, "branch": branch }),
    }
}

/// Replace the BEGIN..END region in `existing` with `block`, else append it.
/// Same shape as the managed-block merge the PTY config writer uses.
fn merge_guard_block(existing: &str, block: &str) -> String {
    if existing.trim().is_empty() {
        return format!("#!/bin/sh\n{block}\n");
    }
    if let (Some(b), Some(e)) = (existing.find(GUARD_BEGIN), existing.find(GUARD_END)) {
        if e > b {
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..b]);
            out.push_str(block);
            out.push_str(&existing[e + GUARD_END.len()..]);
            return out;
        }
    }
    let mut out = existing.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(block);
    out.push('\n');
    out
}

/// The hook text with the managed region removed; None when nothing meaningful
/// is left (the file was ours alone) so the caller deletes it instead.
fn strip_guard_block(existing: &str) -> Option<String> {
    let (Some(b), Some(e)) = (existing.find(GUARD_BEGIN), existing.find(GUARD_END)) else {
        return Some(existing.to_string());
    };
    if e <= b {
        return Some(existing.to_string());
    }
    let stripped = format!("{}{}", &existing[..b], &existing[e + GUARD_END.len()..]);
    let meaningful = stripped.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with("#!") && !t.starts_with('#')
    });
    meaningful.then_some(stripped)
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perm = meta.permissions();
        perm.set_mode(perm.mode() | 0o755);
        let _ = std::fs::set_permissions(path, perm);
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

/// Every hook this module manages, and the block that goes in each.
const MANAGED_HOOKS: &[(&str, &str)] = &[
    ("pre-commit", GUARD_BLOCK),
    ("reference-transaction", REFTX_BLOCK),
];

/// Install (or refresh) one managed hook. A user hook already in place is kept —
/// the block is merged around it by marker, exactly like the brain's managed
/// config blocks.
fn install_hook(hooks: &Path, name: &str, block: &str) -> Result<PathBuf, String> {
    let hook = hooks.join(name);
    let existing = std::fs::read_to_string(&hook).unwrap_or_default();
    let next = merge_guard_block(&existing, block);
    if next != existing {
        std::fs::write(&hook, &next).map_err(|e| format!("could not write {}: {e}", hook.display()))?;
    }
    make_executable(&hook);
    Ok(hook)
}

/// Arm the guard: mint a fresh host nonce into the lock file and install both
/// managed hook blocks.
#[tauri::command]
pub async fn swarm_guard_install(cwd: String) -> Value {
    guard_install(&cwd)
}

/// Synchronous body of `swarm_guard_install`, so the tests can arm a real repo.
fn guard_install(cwd: &str) -> Value {
    let common = match git_common_dir(cwd) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if std::fs::write(common.join(LOCK_NAME), lock_body()).is_err() {
        return json!({ "ok": false, "error": "could not write the swarm lock file" });
    }
    // A grant left behind by a killed host process would be a live credential
    // with nobody using it. Arming clears it.
    let _ = std::fs::remove_file(common.join(GRANT_NAME));
    // Host artefacts and the usual build/editor caches, out of every agent's
    // `git status` and `git add -A` from the first tick — not just from the
    // first worktree (`swarm_worktree_add` also calls this).
    ensure_swarm_excluded(cwd);
    let hooks = common.join("hooks");
    let _ = std::fs::create_dir_all(&hooks);
    let mut installed = Vec::new();
    for (name, block) in MANAGED_HOOKS {
        match install_hook(&hooks, name, block) {
            Ok(p) => installed.push(p.to_string_lossy().to_string()),
            Err(e) => return json!({ "ok": false, "error": e }),
        }
    }
    json!({ "ok": true, "hooks": installed, "lock": common.join(LOCK_NAME).to_string_lossy() })
}

/// Disarm the guard: drop the lock and strip the managed block from every hook
/// (deleting a hook only when it was entirely ours). Safe to call when nothing
/// is installed.
#[tauri::command]
pub async fn swarm_guard_remove(cwd: String) -> Value {
    guard_remove(&cwd)
}

/// Synchronous body of `swarm_guard_remove` — see `guard_install`.
fn guard_remove(cwd: &str) -> Value {
    let common = match git_common_dir(cwd) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let _ = std::fs::remove_file(common.join(LOCK_NAME));
    let _ = std::fs::remove_file(common.join(GRANT_NAME));
    for (name, _) in MANAGED_HOOKS {
        let hook = common.join("hooks").join(name);
        if let Ok(existing) = std::fs::read_to_string(&hook) {
            match strip_guard_block(&existing) {
                Some(rest) if rest != existing => { let _ = std::fs::write(&hook, rest); }
                Some(_) => {}
                None => { let _ = std::fs::remove_file(&hook); }
            }
        }
    }
    json!({ "ok": true })
}

/// How old a `.git/index.lock` must be before [`reclaim`] will delete it. A lock
/// held by a git command that is genuinely running right now is milliseconds
/// old; one left by a killed process never changes again.
const STALE_INDEX_LOCK_MS: u128 = 10_000;

/// Is a swarm ACTUALLY running on this repo — as opposed to a lock file left
/// behind by one that was killed?
///
/// The launch path asks this before it decides whether to sweep the previous
/// run's worktrees away, and it is the only question in the system whose wrong
/// answer is silent: say "live" about a dead swarm and the new run inherits the
/// old one's trees, branches and commits, with nothing in the UI to suggest it.
///
/// So liveness is read from the process table, never from anything the app
/// persisted about itself. `ours` reports whether the owner is THIS process, so
/// the caller can add the one check only it can make — are that swarm's panes
/// still open — without ever using a persisted workspace as evidence that a
/// process exists.
#[tauri::command]
pub async fn swarm_guard_probe(cwd: String) -> Value {
    guard_probe(&cwd)
}

/// Synchronous body of `swarm_guard_probe`, so the tests can drive a real repo.
fn guard_probe(cwd: &str) -> Value {
    let common = match git_common_dir(cwd) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let lock = common.join(LOCK_NAME);
    let Ok(text) = std::fs::read_to_string(&lock) else {
        return json!({ "ok": true, "locked": false, "live": false, "ours": false });
    };
    let Some(owner) = parse_lock_owner(&text) else {
        return json!({ "ok": true, "locked": true, "live": false, "ours": false,
                       "reason": "the lock names no owner process (armed by an older build) - treating it as a leftover" });
    };
    let ours = owner.pid == std::process::id();
    // Same pid AND same start time. Either alone is a guess: a pid is recycled,
    // and a start time on its own identifies nothing.
    let live = proc_start(owner.pid) == Some(owner.start);
    let reason = if live {
        None
    } else {
        Some(format!("the process that armed the lock (pid {}) is gone", owner.pid))
    };
    json!({ "ok": true, "locked": true, "live": live, "ours": ours && live, "pid": owner.pid, "reason": reason })
}

/// Put a repo back in a state a swarm can launch into, after the last one was
/// killed rather than finished.
///
/// Everything here is a leftover that only a HARD stop produces — a clean
/// mission end tears its own guard down (see the dispatcher's `missionDone`
/// branch). What a `pkill` leaves instead: the lock and both hook blocks still
/// armed, so the human's own commits to master are refused by a swarm that no
/// longer exists; an `index.lock` from whatever git child was mid-flight, which
/// makes EVERY later git command fail; and, if the kill landed inside a host
/// merge, a `MERGE_HEAD` that makes git refuse the next merge with "you have
/// not concluded your merge".
///
/// Nothing here can lose work. The guard is the host's own file. An
/// `index.lock` is removed only when it is old enough that no live git could
/// own it. An in-progress merge is ABORTED (which restores the pre-merge tree)
/// and, only if git will not abort it, reduced to removing git's own marker
/// files — the working tree, conflict markers and all, is left exactly as it is
/// for a human to read.
///
/// Safe to call on a repo with nothing wrong with it: every step is a no-op then.
#[tauri::command]
pub async fn swarm_reclaim(cwd: String) -> Value {
    reclaim(&cwd)
}

/// Synchronous body of `swarm_reclaim`, so the tests can drive a real repo.
fn reclaim(cwd: &str) -> Value {
    reclaim_with(cwd, STALE_INDEX_LOCK_MS)
}

/// [`reclaim`] with the index-lock age threshold as a parameter, so a test can
/// assert the removal without waiting ten seconds for a file to get old.
fn reclaim_with(cwd: &str, stale_index_lock_ms: u128) -> Value {
    let common = match git_common_dir(cwd) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let mut cleared: Vec<String> = Vec::new();

    // 1. Stale index locks FIRST — every step below shells out to git, and a
    //    leftover index.lock fails all of them before they start.
    let mut gitdirs = vec![common.clone()];
    if let Ok(rd) = std::fs::read_dir(common.join("worktrees")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                gitdirs.push(e.path());
            }
        }
    }
    for dir in gitdirs {
        let lock = dir.join("index.lock");
        let Ok(meta) = std::fs::metadata(&lock) else { continue };
        let age = meta.modified().ok().and_then(|m| m.elapsed().ok()).map(|d| d.as_millis()).unwrap_or(u128::MAX);
        if age < stale_index_lock_ms {
            cleared.push(format!("left {} alone - it is {age} ms old, so a git command may still hold it", lock.display()));
            continue;
        }
        if std::fs::remove_file(&lock).is_ok() {
            cleared.push(format!("removed a stale {}", lock.display()));
        }
    }

    // 2. An operation the kill interrupted. `git X --abort` restores the
    //    pre-operation state; the marker sweep is the fallback for a state git
    //    itself will not unwind, and touches nothing but git's own bookkeeping.
    let interrupted: &[(&str, &[&str], &[&str])] = &[
        ("MERGE_HEAD", &["merge", "--abort"], &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"]),
        ("CHERRY_PICK_HEAD", &["cherry-pick", "--abort"], &["CHERRY_PICK_HEAD"]),
        ("REVERT_HEAD", &["revert", "--abort"], &["REVERT_HEAD"]),
    ];
    for (marker, abort, files) in interrupted {
        if !common.join(marker).exists() {
            continue;
        }
        let _ = git(cwd, abort, true);
        if common.join(marker).exists() {
            for f in *files {
                let _ = std::fs::remove_file(common.join(f));
            }
            cleared.push(format!("cleared an interrupted {} by hand - git would not abort it, so the working tree was left untouched", marker.trim_end_matches("_HEAD").to_lowercase()));
        } else {
            cleared.push(format!("aborted an interrupted {}", marker.trim_end_matches("_HEAD").to_lowercase()));
        }
    }
    if common.join("rebase-merge").exists() || common.join("rebase-apply").exists() {
        let _ = git(cwd, &["rebase", "--abort"], true);
        if common.join("rebase-merge").exists() || common.join("rebase-apply").exists() {
            cleared.push("a rebase is in progress and would not abort - finish or abort it by hand".to_string());
        } else {
            cleared.push("aborted an interrupted rebase".to_string());
        }
    }

    // 3. The dead swarm's guard. Held by nobody now, and while it is armed the
    //    human cannot commit to their own master.
    let had_lock = common.join(LOCK_NAME).exists();
    guard_remove(cwd);
    if had_lock {
        cleared.push("disarmed the guard a killed swarm left behind".to_string());
    }

    // 4. Worktree admin dirs whose directory is already gone, so `leftover_tasks`
    //    and the sweep that follows see the same repo git does.
    let _ = git(cwd, &["worktree", "prune"], true);

    json!({ "ok": true, "cleared": cleared })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── a throwaway repo, because these two gates are only real against git ──

    /// Run a git command that MUST succeed. `host_marked` so a global
    /// `core.hooksPath` on the dev box cannot block the fixture's own commits.
    fn g(cwd: &str, args: &[&str]) -> String {
        git(cwd, args, true).unwrap_or_else(|e| panic!("git {args:?} in {cwd}: {e}"))
    }

    /// A repo on `master` with one commit. Deleted first, so a crashed run does
    /// not poison the next one.
    fn tmp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixelmarch-swarm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let d = dir.to_string_lossy().to_string();
        g(&d, &["-c", "init.defaultBranch=master", "init", "-q", "."]);
        for (k, v) in [("user.email", "swarm@test"), ("user.name", "swarm test"), ("commit.gpgsign", "false")] {
            g(&d, &["config", k, v]);
        }
        std::fs::write(dir.join("README.md"), "base\n").unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "base"]);
        dir
    }

    /// A task worktree at `.swarm/<task>` on `swarm/<task>`, exactly as
    /// `swarm_worktree_add` makes one.
    fn add_worktree(repo: &Path, task: &str) -> PathBuf {
        let d = repo.to_string_lossy().to_string();
        g(&d, &["worktree", "add", "-q", &format!(".swarm/{task}"), "-b", &format!("swarm/{task}")]);
        repo.join(".swarm").join(task)
    }

    /// Commit one file in a worktree; returns the new commit id.
    fn commit_in(wt: &Path, file: &str, body: &str) -> String {
        let d = wt.to_string_lossy().to_string();
        std::fs::write(wt.join(file), body).unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", &format!("add {file}")]);
        g(&d, &["rev-parse", "HEAD"])
    }

    fn head(repo: &Path) -> String {
        g(&repo.to_string_lossy(), &["rev-parse", "HEAD"])
    }

    /// Overwrite a repo's lock with one owned by a process that is NOT running:
    /// our own pid, but a start time that cannot be ours. That is precisely what
    /// a `pkill`ed swarm leaves behind — a file naming an owner that is gone.
    fn orphan_the_lock(repo: &Path) {
        let common = git_common_dir(&repo.to_string_lossy()).expect("common dir");
        let body = format!("{LOCK_BODY}pid={}\nstart=1\n", std::process::id());
        std::fs::write(common.join(LOCK_NAME), body).expect("write lock");
    }

    #[test]
    fn a_live_lock_is_told_from_one_a_killed_swarm_left_behind() {
        let repo = tmp_repo("probe");
        let d = repo.to_string_lossy().to_string();

        // Nothing armed: nothing to reclaim, and nothing to mistake for a swarm.
        let idle = guard_probe(&d);
        assert_eq!(idle["locked"], false);
        assert_eq!(idle["live"], false);

        // Armed by THIS process: live, and ours — the one case where the caller
        // is allowed to go on and ask the UI whether the panes are still open.
        assert_eq!(guard_install(&d)["ok"], true);
        let live = guard_probe(&d);
        assert_eq!(live["locked"], true);
        assert_eq!(live["live"], true, "the process that armed the lock is this one");
        assert_eq!(live["ours"], true);

        // Same pid, different process. This is the ghost: the file says a swarm
        // is running, the process table says otherwise, and the process table wins.
        orphan_the_lock(&repo);
        let dead = guard_probe(&d);
        assert_eq!(dead["locked"], true);
        assert_eq!(dead["live"], false, "a start time that is not ours is not us");
        assert_eq!(dead["ours"], false);

        // A lock from a build that predates the owner lines cannot be verified,
        // so it reads as a leftover rather than as a swarm nobody can clear.
        let common = git_common_dir(&d).unwrap();
        std::fs::write(common.join(LOCK_NAME), LOCK_BODY).unwrap();
        assert_eq!(guard_probe(&d)["live"], false, "an unverifiable lock is a leftover, not a swarm");
    }

    #[test]
    fn a_killed_swarm_leaves_a_repo_a_relaunch_can_sweep() {
        let repo = tmp_repo("reclaim");
        let d = repo.to_string_lossy().to_string();
        assert_eq!(guard_install(&d)["ok"], true);
        let wt = add_worktree(&repo, "task-1");
        let tip = commit_in(&wt, "feature.txt", "unmerged work\n");

        // The kill: the lock and both hooks stay armed, the worktree stays, and
        // a git child died holding the index.
        orphan_the_lock(&repo);
        let common = git_common_dir(&d).unwrap();
        std::fs::write(common.join("index.lock"), "").unwrap();
        assert_eq!(guard_probe(&d)["live"], false);

        // Reclaim, with the age gate open so the test does not wait it out.
        let r = reclaim_with(&d, 0);
        assert_eq!(r["ok"], true);
        assert!(!common.join("index.lock").exists(), "a stale index.lock blocks every git command that follows");
        assert!(!common.join(LOCK_NAME).exists(), "the dead swarm's guard must not outlive it");
        assert!(!common.join("hooks").join("reference-transaction").exists(), "the managed hook was entirely ours");

        // And now the sweep can do its job — which is the whole point: the new
        // run must not start on the dead run's tree, branch or commits.
        let sweep = sweep_worktrees(&d, Some(false));
        assert_eq!(sweep["ok"], true);
        assert_eq!(sweep["kept"].as_array().map(|k| k.len()), Some(0), "nothing should have been left behind: {sweep:?}");
        assert!(!repo.join(".swarm").join("task-1").exists());
        assert!(rev_commit(&d, "refs/heads/swarm/task-1").is_none(), "the old branch must be out of the new run's way");
        // Nothing of the dead run is parked anywhere for the new one to find.
        assert_eq!(g(&d, &["for-each-ref", "--format=%(refname:short)", "refs/heads/pixelmarch-salvage/"]), "");
        assert!(rev_commit(&d, &tip).is_some(), "the commit is unreachable, not erased");

        // Arming again is what a relaunch does, and it must come back clean.
        assert_eq!(guard_install(&d)["ok"], true);
        let fresh = guard_probe(&d);
        assert_eq!(fresh["live"], true);
        assert_eq!(fresh["ours"], true);
    }

    #[test]
    fn a_kill_inside_a_host_merge_does_not_block_the_next_launch() {
        let repo = tmp_repo("reclaim-merge");
        let d = repo.to_string_lossy().to_string();
        // A conflict, left mid-merge exactly as a kill would leave it.
        g(&d, &["checkout", "-q", "-b", "side"]);
        std::fs::write(repo.join("README.md"), "side\n").unwrap();
        g(&d, &["commit", "-qam", "side"]);
        g(&d, &["checkout", "-q", "master"]);
        std::fs::write(repo.join("README.md"), "master\n").unwrap();
        g(&d, &["commit", "-qam", "master"]);
        let _ = git(&d, &["merge", "--no-edit", "side"], true); // conflicts on purpose
        let common = git_common_dir(&d).unwrap();
        assert!(common.join("MERGE_HEAD").exists(), "fixture must actually be mid-merge");

        assert_eq!(reclaim(&d)["ok"], true);
        assert!(!common.join("MERGE_HEAD").exists(), "git refuses the next merge while this is here");
        // The repo is usable again. `side` itself still conflicts with master —
        // that is the fixture, not the leftover — so the proof is a merge that
        // has no conflict to hit: while MERGE_HEAD was there it would have died
        // on "you have not concluded your merge" before looking at the content.
        g(&d, &["checkout", "-q", "-b", "other"]);
        std::fs::write(repo.join("NOTES.md"), "no conflict here\n").unwrap();
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "other"]);
        g(&d, &["checkout", "-q", "master"]);
        assert!(git(&d, &["merge", "--no-ff", "--no-edit", "-m", "after reclaim", "other"], true).is_ok());
    }

    #[test]
    fn reclaim_is_a_no_op_on_a_repo_with_nothing_wrong_with_it() {
        let repo = tmp_repo("reclaim-clean");
        let d = repo.to_string_lossy().to_string();
        let before = head(&repo);
        let r = reclaim(&d);
        assert_eq!(r["ok"], true);
        assert_eq!(r["cleared"].as_array().map(|c| c.len()), Some(0));
        assert_eq!(head(&repo), before);
        assert_eq!(guard_probe(&d)["locked"], false);
    }

    #[test]
    fn task_keys_are_validated_before_reaching_a_command_line() {
        assert!(valid_task("task-1"));
        assert!(valid_task("task-42"));
        for bad in ["task-", "task-1x", "task-1; rm -rf /", "../task-1", "task-1 --force", "", "1"] {
            assert!(!valid_task(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_guard_block_merges_into_an_existing_hook_and_strips_back_out() {
        // Fresh file: shebang + block.
        let fresh = merge_guard_block("", GUARD_BLOCK);
        assert!(fresh.starts_with("#!/bin/sh\n"));
        assert!(fresh.contains(GUARD_BEGIN) && fresh.contains(GUARD_END));
        assert_eq!(strip_guard_block(&fresh), None, "a hook that was entirely ours is deleted, not left as a stub");

        // A user hook is preserved around the block, and intact after removal.
        let user = "#!/bin/bash\nrun-my-linter || exit 1\n";
        let merged = merge_guard_block(user, GUARD_BLOCK);
        assert!(merged.contains("run-my-linter"));
        assert!(merged.contains(GUARD_BEGIN));
        let back = strip_guard_block(&merged).expect("user content must survive");
        assert!(back.contains("run-my-linter"));
        assert!(!back.contains(GUARD_BEGIN));

        // Re-install replaces the block instead of stacking a second one.
        let twice = merge_guard_block(&merged, GUARD_BLOCK);
        assert_eq!(twice.matches(GUARD_BEGIN).count(), 1);
    }

    #[test]
    fn the_guard_blocks_cover_master_the_root_and_honour_the_host_mark() {
        assert!(GUARD_BLOCK.contains("master|main"));
        assert!(GUARD_BLOCK.contains("*/worktrees/*"), "pre-commit must also hold the ROOT checkout");
        assert!(GUARD_BLOCK.contains(HOST_MERGE_ENV));
        assert!(GUARD_BLOCK.contains(LOCK_NAME), "the lock file is what scopes the guard to an active swarm");
        // Every managed block lives between its own markers, so merge/strip
        // round-trips for each hook file.
        for (name, block) in MANAGED_HOOKS {
            assert!(block.starts_with(GUARD_BEGIN), "{name}");
            assert!(block.ends_with(GUARD_END), "{name}");
            assert!(block.contains(LOCK_NAME), "{name} must be scoped to an active swarm");
            assert!(block.contains(HOST_MERGE_ENV), "{name} must let the host's own git through");
            assert!(block.contains(GRANT_NAME), "{name} must compare against the short-lived grant");
        }
        // The host mark is COMPARED, never assumed: the old block tested for the
        // literal "1", which the briefs told every agent not to set — i.e. told
        // them what to set. And what it compares against is the GRANT, not the
        // lock: a credential that sits in the repo for the life of the swarm is
        // one every agent can read (see the grant test below).
        assert!(!GUARD_BLOCK.contains("\"$PIXELMARCH_HOST_MERGE\" != \"1\""), "the constant bypass is gone");
        for (name, block) in MANAGED_HOOKS {
            assert!(
                !block.contains(&format!("$PIXELMARCH_HOST_MERGE\" = \"$(cat \"$pm_common/{LOCK_NAME}")),
                "{name} must not accept the lock file's contents as the host mark",
            );
        }
        assert!(REFTX_BLOCK.contains("prepared"), "only the abortable state may refuse");
        assert!(REFTX_BLOCK.contains(OWNER_FILE), "the owner marker is what tells two builders apart");
    }

    /// Run git with an explicit environment and say only whether it succeeded —
    /// the guard's whole answer is exit status.
    fn git_as(cwd: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<(), String> {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(cwd).env_remove(HOST_MERGE_ENV).env_remove("PIXELMARCH_ROLE");
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// THE BREACH THAT KEEPS HAPPENING (breach-builder-2-unbriefed-git-writes):
    /// a pane resumed with a bare "continue" merges an unreviewed branch into
    /// master. `pre-commit` never saw it — a merge writes its commit through
    /// `pre-merge-commit`, and a fast-forward writes no commit at all.
    #[test]
    fn a_hand_merge_into_master_is_refused_while_the_host_s_own_merge_passes() {
        let repo = tmp_repo("reftx-master");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        commit_in(&wt, "a.txt", "work\n");
        assert_eq!(guard_install(&d)["ok"], true);
        let before = head(&repo);

        // 1+2. Every shape the old pre-commit guard was blind to, because none of
        //    them writes a commit it could hook. THE REFUSAL IS NOT FREE: git
        //    writes the index and the working tree BEFORE the ref update this
        //    hook aborts, so the branch holds while the root checkout is left
        //    rewritten. That is the guard's real cost, it is why the dispatcher's
        //    stray-edit tripwire matters as much as the hook, and it is why each
        //    attempt below has to be cleaned up before the next one.
        for (what, args) in [
            ("a fast-forward", vec!["merge", "--ff-only", "swarm/task-1"]),
            ("a no-ff merge", vec!["merge", "--no-ff", "--no-edit", "swarm/task-1"]),
            ("a reset --hard", vec!["reset", "--hard", "swarm/task-1"]),
        ] {
            let err = match git_as(&d, &args, &[("PIXELMARCH_ROLE", "builder-2")]) {
                Err(e) => e,
                Ok(()) => panic!("{what} into master must be refused"),
            };
            assert!(err.contains("pixelmarch swarm guard"), "{what}: {err}");
            assert_eq!(head(&repo), before, "{what} moved master anyway");
            g(&d, &["reset", "--hard", "HEAD"]); // clear what the refusal left behind
        }

        // 2b. The ROOT checkout is the host's on EVERY branch, not just master —
        //    a stray that only gets caught when the pane happens to be on master
        //    is how root strays accumulated for a whole mission. pre-commit takes
        //    this one so it fails before git writes anything.
        g(&d, &["checkout", "-q", "-b", "side"]);
        std::fs::write(repo.join("stray.txt"), "written in the root\n").unwrap();
        git_as(&d, &["add", "-A"], &[("PIXELMARCH_ROLE", "builder-2")]).unwrap();
        let err = git_as(&d, &["commit", "-qm", "stray"], &[("PIXELMARCH_ROLE", "builder-2")])
            .expect_err("a role pane must not commit in the root checkout, on any branch");
        assert!(err.contains("ROOT checkout"), "{err}");
        // A human terminal carries no role and keeps its own side branch.
        git_as(&d, &["commit", "-qm", "human side work"], &[]).expect("an unroled terminal keeps working");
        g(&d, &["checkout", "-q", "master"]);
        g(&d, &["branch", "-D", "side"]);
        std::fs::remove_file(repo.join("stray.txt")).ok();

        // 3. The one root ref write a builder legitimately makes: creating its own
        //    task branch via `git worktree add -b`. Creation only — the same
        //    command against a branch that already exists is somebody else's.
        git_as(&d, &["worktree", "add", ".swarm/task-7", "-b", "swarm/task-7"], &[("PIXELMARCH_ROLE", "builder-1")])
            .expect("a builder must still be able to open its own worktree");
        g(&d, &["branch", "swarm/task-9", "HEAD"]); // an existing branch, nobody's worktree
        let err = git_as(&d, &["branch", "-f", "swarm/task-9", "swarm/task-1"], &[("PIXELMARCH_ROLE", "builder-2")])
            .expect_err("moving an existing task branch from the root must be refused");
        assert!(err.contains("not yours to move"), "{err}");

        // 4. The host does NOT merge over a dirty root, whoever dirtied it.
        //    Auto-discarding a working tree is how a builder's real work gets
        //    destroyed, so it refuses and hands the mess to a human.
        std::fs::write(repo.join("README.md"), "someone was editing this\n").unwrap();
        let refused = merge_task(&d, "task-1", None, None, None);
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["reason"], "repo dirty");
        assert_eq!(std::fs::read_to_string(repo.join("README.md")).unwrap(), "someone was editing this\n");

        // 5. Clean root: the host's own merge — nonce-marked — lands.
        g(&d, &["reset", "--hard", "HEAD"]);
        let ok = merge_task(&d, "task-1", None, None, None);
        assert_eq!(ok["ok"], true, "{ok}");
        assert_ne!(head(&repo), before);
        assert!(repo.join("a.txt").exists());
        assert!(rev_commit(&d, "MERGE_HEAD").is_none());

        guard_remove(&d);
        // Disarmed: the same command that was refused now runs.
        assert!(git_as(&d, &["branch", "-f", "scratch", "HEAD"], &[("PIXELMARCH_ROLE", "builder-2")]).is_ok());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The write no branch rule can catch: the RIGHT branch, in the RIGHT
    /// worktree, moved by the WRONG pane while its real owner was live. Only the
    /// owner marker tells them apart.
    #[test]
    fn a_worktree_refuses_a_ref_write_from_a_pane_that_does_not_own_it() {
        let repo = tmp_repo("reftx-owner");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-2");
        let wtd = wt.to_string_lossy().to_string();
        assert_eq!(guard_install(&d)["ok"], true);
        std::fs::write(wt.join(OWNER_FILE), "builder-1\n").unwrap();

        let write_one = |role: &str, file: &str| {
            std::fs::write(wt.join(file), "x\n").unwrap();
            git_as(&wtd, &["add", "-A"], &[("PIXELMARCH_ROLE", role)]).expect("staging is not a ref write");
            git_as(&wtd, &["commit", "-qm", file], &[("PIXELMARCH_ROLE", role)])
        };

        let err = write_one("builder-2", "intruder.txt").expect_err("another builder's commit must be refused");
        assert!(err.contains("belongs to builder-1"), "{err}");

        // The owner itself is unaffected — the guard must not stop the work.
        write_one("builder-1", "mine.txt").expect("the owning builder must still commit");

        // And the owner may not reach past its own branch, even inside its tree.
        let err = git_as(&wtd, &["branch", "-f", "swarm/task-9", "HEAD"], &[("PIXELMARCH_ROLE", "builder-1")])
            .expect_err("a worktree may only move its own branch");
        assert!(err.contains("not this worktree's branch"), "{err}");

        // A pane with no role at all (a human terminal) is not policed inside a
        // worktree it did not claim — the marker only fires on a role mismatch.
        write_one("", "human.txt").expect("an unroled terminal keeps working");

        guard_remove(&d);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The marker follows the BUS, not the worktree's birth — a reclaim changes
    /// who owns a live tree. And it never reaches a commit: `git add -A` is what
    /// builders run, so the marker is excluded repo-wide.
    /// The pre-launch warning's whole point: what a builder will NOT be able to
    /// see. A worktree is checked out from a commit, so untracked root files are
    /// missing from it — and the dirty tripwire cannot report them, by design.
    #[test]
    fn untracked_root_files_are_reported_and_are_invisible_inside_a_worktree() {
        let repo = tmp_repo("untracked");
        let d = repo.to_string_lossy().to_string();
        std::fs::create_dir_all(repo.join("src/admin")).unwrap();
        std::fs::write(repo.join("src/admin/Users.tsx").as_path(), "x\n").unwrap();
        std::fs::write(repo.join("dashboard.tsx").as_path(), "x\n").unwrap();

        let files = untracked_files(&d);
        assert!(files.iter().any(|f| f == "dashboard.tsx"), "{files:?}");
        // `--untracked-files=normal` collapses a wholly-untracked directory, and
        // that is the right unit for the warning: one line, not one per file.
        assert!(files.iter().any(|f| f == "src/"), "{files:?}");

        // The tripwire is deliberately blind to all of it — this is why nothing
        // caught the case before.
        assert!(dirty_files(&d).is_empty(), "the dirty tripwire must stay tracked-only");

        // And the builder really cannot see them.
        let wt = add_worktree(&repo, "task-1");
        assert!(!wt.join("dashboard.tsx").exists(), "an untracked root file must not reach a worktree");

        // Host artefacts never reach the human's warning.
        std::fs::create_dir_all(repo.join("node_modules/x")).unwrap();
        std::fs::write(repo.join("node_modules/x/i.js").as_path(), "x\n").unwrap();
        let files = untracked_files(&d);
        assert!(!files.iter().any(|f| f.starts_with("node_modules")), "{files:?}");
        assert!(!files.iter().any(|f| f.starts_with(".swarm")), "{files:?}");

        // Committing them is the fix, and it clears the warning.
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "the untracked work"]);
        assert!(untracked_files(&d).is_empty(), "{:?}", untracked_files(&d));

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn the_owner_marker_is_validated_rewritable_and_kept_out_of_git() {
        let repo = tmp_repo("owner-marker");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-3");
        ensure_swarm_excluded(&d);

        // Nothing but a role name reaches a file the hook reads back.
        for bad in ["", "builder 1", "builder;rm -rf /", "../../etc/passwd", "a\nb"] {
            let res = worktree_owner(&d, "task-3", bad);
            assert_eq!(res["ok"], false, "{bad:?} must be refused");
        }
        let res = worktree_owner(&d, "task-3", "builder-1");
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["changed"], true);
        assert_eq!(std::fs::read_to_string(wt.join(OWNER_FILE)).unwrap().trim(), "builder-1");

        // Idempotent, then re-stamped on a reclaim.
        assert_eq!(worktree_owner(&d, "task-3", "builder-1")["changed"], false);
        assert_eq!(worktree_owner(&d, "task-3", "builder-2")["changed"], true);
        assert_eq!(std::fs::read_to_string(wt.join(OWNER_FILE)).unwrap().trim(), "builder-2");

        // No worktree yet = retry later, not a silent success.
        assert_eq!(worktree_owner(&d, "task-8", "builder-1")["no_worktree"], true);

        // The marker must be invisible to the builder's own `git add -A`.
        let status = g(&wt.to_string_lossy(), &["status", "--porcelain"]);
        assert!(!status.contains(OWNER_FILE), "the host marker is visible to the builder: {status}");
        let excl = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
        for want in EXCLUDED {
            assert!(excl.contains(want), "{want} missing from info/exclude: {excl}");
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn an_approval_is_read_out_of_whatever_the_reviewer_actually_wrote() {
        assert_eq!(sha_candidates("approved by reviewer-1 @ c15533e7 — 2.1 covered"), vec!["c15533e7"]);
        // Case-folded, and a longer id survives whole.
        assert_eq!(sha_candidates("@ C15533E7C15533E7C15533E7C15533E7C15533E7"), vec!["c15533e7c15533e7c15533e7c15533e7c15533e7"]);
        // Not SHA-shaped: too short, too long, non-hex, and the task key itself.
        assert!(sha_candidates("task-1 looks good, approved, ship it").is_empty());
        assert!(sha_candidates("c15533").is_empty(), "6 hex digits is below git's own abbreviation floor");
        assert!(sha_candidates(&"a".repeat(41)).is_empty());
        // Permissive on purpose — git is what decides. A hex-looking word is a
        // candidate here and simply fails to resolve later.
        assert_eq!(sha_candidates("the deadbeef case"), vec!["deadbeef"]);
    }

    /// 2.3, part one: an approval on commit X authorises merging X ONLY. The live
    /// incident (swarm-merge-can-destroy-builder-work) was a reviewer approving the
    /// commit it had read while the builder pushed more, and the host merging the
    /// later tip unreviewed.
    #[test]
    fn a_branch_that_moved_past_the_approved_commit_is_refused_then_merges_once_re_gated() {
        let repo = tmp_repo("moved");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        let approved = commit_in(&wt, "a.txt", "reviewed\n");
        let moved = commit_in(&wt, "b.txt", "never reviewed\n");
        let master_before = head(&repo);

        let res = merge_task(&d, "task-1", None, Some(&approved), None);
        assert_eq!(res["ok"], false);
        assert_eq!(res["moved"], true);
        assert_eq!(res["approved_sha"], approved, "the refusal must name the approved commit");
        assert_eq!(res["head_sha"], moved, "…and the commit the branch actually sits on");
        assert_eq!(res["ahead"], "1");
        let log = res["changes_log"].as_str().unwrap();
        assert!(log.contains(&approved[..8]) && log.contains(&moved[..8]), "both SHAs belong in the re-gate log: {log}");
        assert_eq!(head(&repo), master_before, "a refused merge must not touch the root checkout");
        assert!(repo.join(".swarm/task-1").exists(), "and must not touch the worktree");

        // Re-gated on the commit that is actually there: the same call merges.
        let ok = merge_task(&d, "task-1", None, Some(&moved), None);
        assert_eq!(ok["ok"], true, "{ok}");
        assert_eq!(ok["gated"], true);
        assert!(merge_landed(&d, "task-1", None));
        assert!(repo.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The approval arrives as prose ("approved by reviewer-1 @ c15533e7"), an
    /// abbreviated id, or nothing at all. Prose and abbreviations resolve; a
    /// hex-shaped word that is not a commit on this branch is a hard refusal, never
    /// a silent ungated merge.
    #[test]
    fn an_approval_may_be_prose_or_abbreviated_but_never_guessed() {
        let repo = tmp_repo("prose");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-2");
        let sha = commit_in(&wt, "a.txt", "reviewed\n");
        let short = &sha[..8];

        // A SHA-shaped token that git cannot place on this branch refuses the merge.
        let bad = merge_task(&d, "task-2", None, Some("approved by reviewer-1 @ deadbeef"), None);
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["unresolved_approval"], true, "{bad}");
        assert!(!merge_landed(&d, "task-2", None), "an unresolvable approval must not merge");

        // Prose carrying a real abbreviated id does resolve, to the full commit.
        let ok = merge_task(&d, "task-2", None, Some(&format!("[approved by reviewer-1] @ {short} — looks good")), None);
        assert_eq!(ok["ok"], true, "{ok}");
        assert!(merge_landed(&d, "task-2", None));
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// A caller that cannot name the approved commit still merges — but the result
    /// says `gated: false`, so "nothing checked this" is visible rather than assumed.
    #[test]
    fn a_merge_with_no_approval_still_reports_that_it_was_ungated() {
        let repo = tmp_repo("ungated");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-3");
        commit_in(&wt, "a.txt", "x\n");

        let res = merge_task(&d, "task-3", None, None, None);
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["gated"], false);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// 2.3, part two: BOTH conditions, never either. The merge landing is not enough
    /// — `worktree remove --force` deletes uncommitted files, and doing it under a
    /// live builder is what destroyed a round of work.
    #[test]
    fn a_worktree_outlives_the_merge_until_the_owner_pane_is_confirmed_stopped() {
        let repo = tmp_repo("release");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-4");
        commit_in(&wt, "package.json", "{}\n");

        // Merge with the pane still alive: work lands, tree stays.
        let first = merge_task(&d, "task-4", None, None, None);
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["manifests"], json!(["package.json"]));
        assert_eq!(first["worktree"]["released"], false);
        assert_eq!(first["worktree"]["reason"], "owner pane not confirmed stopped");
        assert!(wt.exists(), "the worktree was removed under a live pane");
        assert!(rev_commit(&d, "refs/heads/swarm/task-4").is_some(), "the branch went with it");

        // `false` is not `true`: an explicit "still running" keeps it too.
        assert_eq!(merge_task(&d, "task-4", None, None, Some(false))["worktree"]["released"], false);
        assert!(wt.exists());

        // Pane stopped: the repeat call releases, and does NOT re-report the
        // manifest it already reported (no second root install).
        let second = merge_task(&d, "task-4", None, None, Some(true));
        assert_eq!(second["ok"], true, "{second}");
        assert_eq!(second["already"], true, "no second merge commit was written");
        assert_eq!(second["manifests"], json!([]));
        assert_eq!(second["worktree"]["released"], true, "{second}");
        assert!(!wt.exists(), "the worktree should be gone now");
        assert!(rev_commit(&d, "refs/heads/swarm/task-4").is_none(), "the branch should be gone now");
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The other half of "both": a stopped pane is not a licence to delete a tree
    /// whose work never landed. Merged-ness is read out of git, not taken on trust.
    #[test]
    fn a_stopped_pane_alone_never_releases_an_unmerged_worktree() {
        let repo = tmp_repo("unmerged");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-5");
        commit_in(&wt, "a.txt", "not merged anywhere\n");

        let res = release_worktree(&d, "task-5", None, Some(true));
        assert_eq!(res["released"], false);
        assert_eq!(res["reason"], "not merged on this branch");
        assert!(wt.exists());
        assert!(rev_commit(&d, "refs/heads/swarm/task-5").is_some());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// THE HOLE THAT MADE THE GUARD OPTIONAL. The host's credential used to be
    /// the nonce stored in the lock file — a password sitting in the repo that
    /// every agent can read, so `PIXELMARCH_HOST_MERGE=$(cat
    /// .git/pixelmarch-swarm-lock)` walked past both hooks. Seen live: a builder
    /// committed straight onto master with the guard armed and intact. The
    /// credential now exists only while the host itself is inside a git child.
    #[test]
    fn the_host_credential_is_not_readable_out_of_the_repo_between_host_commands() {
        let repo = tmp_repo("grant");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        commit_in(&wt, "a.txt", "work\n");
        assert_eq!(guard_install(&d)["ok"], true);
        let common = git_common_dir(&d).unwrap();
        let before = head(&repo);

        // At rest there is no grant at all, and the lock holds no secret.
        assert!(!common.join(GRANT_NAME).exists(), "a grant must not outlive the host git child that minted it");
        let lock = std::fs::read_to_string(common.join(LOCK_NAME)).unwrap();
        assert!(!lock.trim().is_empty());

        // The old bypass, exactly as an agent would type it: the lock's contents
        // presented as the host mark. Both hooks must still refuse.
        let err = git_as(&d, &["merge", "--ff-only", "swarm/task-1"], &[
            ("PIXELMARCH_ROLE", "builder-1"), (HOST_MERGE_ENV, lock.trim()),
        ]).expect_err("the lock file must not be a usable credential");
        assert!(err.contains("pixelmarch swarm guard"), "{err}");
        assert_eq!(head(&repo), before, "master moved anyway");
        g(&d, &["reset", "--hard", "HEAD"]);

        // Nor is any guess, including the empty string the hooks used to compare
        // against an unreadable nonce.
        for guess in ["", "1", "pixelmarch", "deadbeef"] {
            let err = git_as(&d, &["merge", "--ff-only", "swarm/task-1"], &[
                ("PIXELMARCH_ROLE", "builder-1"), (HOST_MERGE_ENV, guess),
            ]).expect_err("no static value may open the guard");
            assert!(err.contains("pixelmarch swarm guard"), "{guess:?}: {err}");
            g(&d, &["reset", "--hard", "HEAD"]);
        }

        // The host's own merge still lands, and still leaves no credential behind.
        let ok = merge_task(&d, "task-1", None, None, None);
        assert_eq!(ok["ok"], true, "{ok}");
        assert!(!common.join(GRANT_NAME).exists(), "the grant leaked past the host's git child");

        guard_remove(&d);
        assert!(!common.join(LOCK_NAME).exists());
        assert!(!common.join(GRANT_NAME).exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// Stray edits in the root block EVERY host merge, and the old answer was to
    /// ask a human to tidy up — which is how a mission spent its coordinator's
    /// only turn on housekeeping and then sat. Parking is reversible: the stash
    /// still has the work.
    #[test]
    fn root_strays_are_parked_in_a_stash_so_merges_can_resume() {
        let repo = tmp_repo("park");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        commit_in(&wt, "a.txt", "work\n");
        assert_eq!(guard_install(&d)["ok"], true);

        // Clean root: nothing to park, and that is not an error.
        let noop = park_strays(&d, "swarm strays");
        assert_eq!(noop["ok"], true, "{noop}");
        assert_eq!(noop["parked"], false);

        // Someone edits a tracked file in the root. The merge refuses.
        std::fs::write(repo.join("README.md"), "edited outside a worktree\n").unwrap();
        assert_eq!(merge_task(&d, "task-1", None, None, None)["reason"], "repo dirty");

        // Park it: root clean, merge lands, the work is recoverable.
        let parked = park_strays(&d, "pixelmarch swarm: root strays");
        assert_eq!(parked["ok"], true, "{parked}");
        assert_eq!(parked["parked"], true);
        assert_eq!(parked["files"].as_array().unwrap().len(), 1);
        assert!(dirty_files(&d).is_empty(), "the root is still dirty after parking");
        let ok = merge_task(&d, "task-1", None, None, None);
        assert_eq!(ok["ok"], true, "{ok}");
        let stash = g(&d, &["stash", "list"]);
        assert!(stash.contains("root strays"), "the parked work must be findable: {stash:?}");
        g(&d, &["stash", "pop"]);
        assert_eq!(std::fs::read_to_string(repo.join("README.md")).unwrap(), "edited outside a worktree\n");

        guard_remove(&d);
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// What the dispatcher compares each tick: HEAD (did master move without a
    /// host merge?) and a task branch's tip (did the builder commit a fix and
    /// never post `done`?).
    #[test]
    fn head_and_branch_tips_are_reported_for_the_dispatcher_s_comparisons() {
        let repo = tmp_repo("tips");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        let tip = commit_in(&wt, "a.txt", "work\n");

        let h = repo_head(&d);
        assert_eq!(h["ok"], true, "{h}");
        assert_eq!(h["sha"], head(&repo));
        assert_eq!(h["subject"], "base");
        assert_eq!(h["branch"], "master");

        let t = branch_tip(&d, "task-1");
        assert_eq!(t["exists"], true, "{t}");
        assert_eq!(t["sha"], tip);
        assert_eq!(t["subject"], "add a.txt");

        // A task with no branch is a fact, not an error — the caller decides.
        let none = branch_tip(&d, "task-9");
        assert_eq!(none["ok"], true, "{none}");
        assert_eq!(none["exists"], false);
        // And a key that could carry anything onto a command line is refused.
        assert_eq!(branch_tip(&d, "task-1; rm -rf /")["ok"], false);

        // After the host's merge, HEAD carries the subject the dispatcher uses to
        // recognise its own work.
        assert_eq!(merge_task(&d, "task-1", None, None, None)["ok"], true);
        assert_eq!(repo_head(&d)["subject"], "merge: task-1 (swarm)");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_relaunch_sweeps_the_previous_run_s_worktrees_without_losing_a_commit() {
        let repo = tmp_repo("sweep");
        let d = repo.to_string_lossy().to_string();

        // task-1: merged into master, so the sweep may simply delete it.
        let wt1 = add_worktree(&repo, "task-1");
        commit_in(&wt1, "one.txt", "one\n");
        assert_eq!(merge_task(&d, "task-1", None, None, None)["ok"], true);
        // (merged, but the owner was never confirmed stopped: exactly the state
        // an abandoned swarm leaves behind — tree and branch still there)
        assert!(repo.join(".swarm/task-1").exists());

        // A branch of the human's own, in the same repo. Untouchable.
        g(&d, &["branch", "mine"]);

        // task-2: unmerged commits AND uncommitted work on top.
        let wt2 = add_worktree(&repo, "task-2");
        let two = commit_in(&wt2, "two.txt", "two\n");
        std::fs::write(wt2.join("wip.txt"), "unfinished\n").unwrap();

        // task-3: branch only, no directory — `rm -rf .swarm` by hand. This is
        // the one that silently re-checks OLD commits out into a NEW run's tree.
        let wt3 = add_worktree(&repo, "task-3");
        let three = commit_in(&wt3, "three.txt", "three\n");
        g(&d, &["worktree", "remove", "--force", ".swarm/task-3"]);
        assert!(g(&d, &["rev-parse", "--verify", "refs/heads/swarm/task-3"]).starts_with(&three[..8]));

        // A caller that has not confirmed the repo is free sweeps NOTHING.
        for guess in [None, Some(true)] {
            let res = sweep_worktrees(&d, guess);
            assert_eq!(res["ok"], false, "{res}");
            assert!(repo.join(".swarm/task-1").exists(), "and must not touch anything");
        }

        let res = sweep_worktrees(&d, Some(false));
        assert_eq!(res["ok"], true, "{res}");
        assert!(res["kept"].as_array().unwrap().is_empty(), "nothing should have been left behind: {res}");

        // Every tree and every swarm/task-<n> branch is gone: task-1 can be reused.
        assert!(!repo.join(".swarm").join("task-1").exists());
        assert!(!repo.join(".swarm").join("task-2").exists());
        assert_eq!(g(&d, &["for-each-ref", "--format=%(refname:short)", "refs/heads/swarm/"]), "");

        // Nothing is parked anywhere. Unmerged commits and uncommitted work in a
        // task tree are the NORMAL state of an abandoned run, and a launch that
        // keeps either of them is a launch the next run can trip over.
        assert_eq!(g(&d, &["for-each-ref", "--format=%(refname:short)", "refs/heads/pixelmarch-salvage/"]), "");
        assert!(rev_commit(&d, &two).is_some(), "the commit object is unreachable, not erased - reflog and fsck still see it");
        assert!(rev_commit(&d, &three).is_some());
        // .swarm itself goes with the last task in it.
        assert_eq!(res["swarm_dir_removed"], true, "{res}");
        assert!(!repo.join(".swarm").exists(), "the whole folder, not just the trees in it");

        // And the branches the launch is allowed to touch are ONLY its own. This
        // is the boundary: a swarm runs on whatever repo it is pointed at.
        assert!(rev_commit(&d, "refs/heads/mine").is_some(), "a branch PixelMarch did not create is never deleted");

        // Sweeping again is a no-op, and the NEW run gets a clean task-1.
        let again = sweep_worktrees(&d, Some(false));
        assert_eq!(again["ok"], true, "{again}");
        assert!(again["swept"].as_array().unwrap().is_empty(), "{again}");
        let fresh = tauri::async_runtime::block_on(swarm_worktree_add(d.clone(), "task-1".into()));
        assert_eq!(fresh["existed"], false, "task-1 must be built from HEAD, not inherited: {fresh}");
        assert_eq!(
            g(&repo.join(".swarm/task-1").to_string_lossy(), &["rev-parse", "HEAD"]), head(&repo),
            "and it starts on the root's HEAD",
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_launch_clears_what_an_older_build_parked_instead_of_deleting() {
        let repo = tmp_repo("sweep-old-salvage");
        let d = repo.to_string_lossy().to_string();
        // Exactly what the previous design left in a repo, plus a branch of the
        // human's that merely looks similar.
        g(&d, &["branch", &format!("{SALVAGE_PREFIX}/task-1-deadbeef")]);
        g(&d, &["branch", &format!("{SALVAGE_PREFIX}/task-7-cafebabe")]);
        g(&d, &["branch", "pixelmarch-salvage-notes"]); // not under the prefix — not ours

        let res = sweep_worktrees(&d, Some(false));
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["salvage_branches"].as_array().map(|b| b.len()), Some(2), "{res}");
        assert_eq!(g(&d, &["for-each-ref", "--format=%(refname:short)", &format!("refs/heads/{SALVAGE_PREFIX}/")]), "");
        assert!(rev_commit(&d, "refs/heads/pixelmarch-salvage-notes").is_some(), "a name that is not in our namespace is not ours to delete");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_tree_in_a_state_nothing_could_be_salvaged_from_is_still_removed() {
        let repo = tmp_repo("sweep-keep");
        let d = repo.to_string_lossy().to_string();
        let wt = add_worktree(&repo, "task-1");
        commit_in(&wt, "a.txt", "a\n");
        // Uncommitted work on a DETACHED head — the shape the old sweep gave up
        // on, because there was no branch to commit it onto. Giving up is what
        // left `swarm/task-1` in place for the next run to inherit, so a launch
        // does not do that any more.
        let w = wt.to_string_lossy().to_string();
        g(&w, &["checkout", "-q", "--detach"]);
        std::fs::write(wt.join("wip.txt"), "unfinished\n").unwrap();

        let res = sweep_worktrees(&d, Some(false));
        assert_eq!(res["ok"], true, "{res}");
        assert!(res["kept"].as_array().unwrap().is_empty(), "nothing is left behind any more: {res}");
        assert!(!wt.exists(), "{res}");
        assert!(rev_commit(&d, "refs/heads/swarm/task-1").is_none(), "{res}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_previous_swarm_s_merge_commit_does_not_answer_for_this_swarm_s_task() {
        // Task ids restart at task-1 every launch; the repo's history does not.
        // Unnamespaced, run B's task-1 inherited run A's "merged" answer — and
        // `merge_landed` is half of the gate that removes a worktree with
        // `--force`, the other half being an owner pane that has stopped, which
        // every context reset does.
        let repo = tmp_repo("merge-ns");
        let d = repo.to_string_lossy().to_string();
        let (a, b) = ("proj-swarm-alpha-1a2b", "proj-swarm-beta-3c4d");

        let wt = add_worktree(&repo, "task-1");
        commit_in(&wt, "a.txt", "a\n");
        assert_eq!(merge_task(&d, "task-1", Some(a), None, None)["ok"], true);
        assert_eq!(repo_head(&d)["subject"], format!("merge: task-1 (swarm {a})"));
        assert!(merge_landed(&d, "task-1", Some(a)));

        // Run B, same repo, same task number, nothing merged yet.
        assert!(!merge_landed(&d, "task-1", Some(b)), "run A's merge is not run B's");
        // ...and neither is the unnamespaced form, in either direction.
        assert!(!merge_landed(&d, "task-1", None));
        assert!(!merge_landed(&d, "task-1", Some("proj-swarm-alpha-1a2b-extra")));
        // A project id that is a PREFIX of the one that merged must not match:
        // the grep carries the closing paren for exactly this.
        assert!(!merge_landed(&d, "task-1", Some("proj-swarm-alpha")));

        // So B's worktree survives its owner stopping — the release that used to
        // happen here is what destroyed a round of live work. (Run B reaches this
        // point through the launch sweep, which is what frees the task-1 name.)
        assert_eq!(sweep_worktrees(&d, Some(false))["ok"], true);
        let wt_b = add_worktree(&repo, "task-1");
        std::fs::write(wt_b.join("live.txt"), "b is still working\n").unwrap();
        let held = release_worktree(&d, "task-1", Some(b), Some(true));
        assert_eq!(held["released"], false, "{held}");
        assert!(wt_b.join("live.txt").exists(), "and the work is still on disk");

        // An id with characters no launcher mints is stripped, not quoted, and one
        // that strips to nothing falls back to the unnamespaced subject.
        assert_eq!(merge_subject("task-1", Some("a b/c\nd")), "merge: task-1 (swarm abcd)");
        assert_eq!(merge_subject("task-1", Some("  ")), "merge: task-1 (swarm)");
        assert_eq!(merge_subject("task-1", None), "merge: task-1 (swarm)");
        let _ = std::fs::remove_dir_all(&repo);
    }
}
