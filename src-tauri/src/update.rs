//! Source updater. PixelMarch runs OUT OF ITS OWN GIT CHECKOUT (see
//! `state::repo_root`), so updating is `git pull` plus a rebuild — not a signed
//! exe swap. The old updater fetched `latest.json`, verified an Ed25519
//! signature and a sha256 over a downloaded binary, and renamed it over itself;
//! all of that is gone, along with the trust model it carried.
//!
//! ## What the trust model is now
//!
//! It is **git, and whatever the checkout's `origin` points at**. That is a
//! deliberate, and strictly weaker, trade:
//!
//!   * The old model made the release SERVER untrusted — the signing key was
//!     offline, so a fully compromised server could serve anything and none of
//!     it would verify. Nothing here reproduces that. Whoever can push to the
//!     configured remote can run code on this machine at the next update,
//!     because an update BUILDS the code it pulled.
//!   * The dependency tree is trusted too, for the same reason: `npm ci` and
//!     `cargo build` execute install scripts and build scripts out of the
//!     lockfiles the pull brought in.
//!   * What is still guarded is DIRECTION and PROVENANCE: the pull is
//!     `--ff-only` against the branch's own configured upstream, so an update
//!     can only ever move this checkout forward along the history it already
//!     tracks. It cannot rewind onto an older release, and it cannot switch the
//!     checkout to a different branch or remote.
//!
//! Anyone weighing this: the protection you get is `origin`'s access control,
//! not a signature. Point the checkout at a remote you control.
//!
//! ## The sequence, and why it is in this order
//!
//! 1. `git pull --ff-only`
//! 2. `npm ci` — ONLY when the pull actually changed `package-lock.json`.
//!    Unconditional it is a minute of deleting and refetching `node_modules`
//!    on every update, which is how an update people can afford becomes one
//!    they avoid.
//! 3. `npm run build` — the frontend into `dist/`, which `tauri-build` embeds.
//! 4. `cargo build` — the binary.
//! 5. Only NOW stop the terminal host, and relaunch.
//!
//! The build runs BEFORE anything destructive. A build that fails (a conflict,
//! a broken commit, no toolchain) therefore costs the user nothing: their
//! terminals are still up and the binary on disk is untouched, because cargo
//! writes its output only on success. The old updater had to stop the host
//! first — a process running the file being renamed is what makes an in-place
//! swap fail — but a rebuild replaces the binary by unlink-then-link, which
//! Linux and macOS allow while it is executing.
//!
//! WINDOWS: they do not. A running image cannot be replaced, so `cargo build`
//! fails with "Access is denied (os error 5)" against the GUI's own binary and
//! the update reports exactly that. Updating a Windows checkout means closing
//! the app and building from a terminal. Nothing here can fix that from inside
//! the process being replaced.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::hostclient::HostClient;

/// Commit subjects offered as release notes. Enough to see what is coming,
/// short enough to read in a settings row.
const MAX_NOTES: usize = 10;

/// Trailing output kept per step, to quote back when one fails. A build failure
/// prints its cause near the end; the first 2000 lines of a cargo build are
/// noise in an error message.
const ERROR_TAIL_LINES: usize = 25;

/// Minimum gap between two `update-progress` events. A build emits thousands of
/// lines and the UI shows one at a time — without this, the IPC channel becomes
/// the slowest part of the update.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(60);

// ── running commands in the checkout ────────────────────────────────────────

/// A `Command` that never flashes a console window on Windows. Every process
/// this module starts is a build tool the user is already watching in the UI.
fn command(program: &str) -> Command {
    // `mut` is only used by the Windows branch below.
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The checkout every command below runs in.
fn root() -> Result<&'static Path, String> {
    crate::state::repo_root()
}

/// Run `git` in the checkout and hand back its trimmed stdout.
///
/// A non-zero exit is an `Err` carrying git's own stderr: git's diagnostics
/// ("Your local changes to the following files would be overwritten by merge:
/// …") are better than anything this module could write, and they name the
/// files. Do not swallow them.
fn git(args: &[&str]) -> Result<String, String> {
    let root = root()?;
    let out = command("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("could not run git (is it installed and on PATH?): {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(format!("git {} failed: {err}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The branch's configured upstream, e.g. `origin/master`.
///
/// This is the ONLY thing an update ever pulls from, and it is read from the
/// checkout rather than passed in: a caller-supplied remote or branch would let
/// the frontend (or anything that can reach the IPC surface) redirect where
/// this machine gets code it is about to compile and run.
fn upstream() -> Result<String, String> {
    git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).map_err(|e| {
        if e.contains("no upstream") || e.contains("HEAD") {
            "this checkout's branch has no upstream — set one with \
             `git branch --set-upstream-to origin/master`, or update by hand"
                .to_string()
        } else {
            e
        }
    })
}

/// How many commits `HEAD` is behind `upstream`.
fn behind(upstream: &str) -> Result<u32, String> {
    let range = format!("HEAD..{upstream}");
    git(&["rev-list", "--count", &range])?
        .parse::<u32>()
        .map_err(|e| format!("could not count incoming commits: {e}"))
}

/// Does the working tree carry changes the user has not committed?
///
/// Not a blocker — an agent editing this app has a dirty tree nearly all the
/// time, and `git pull --ff-only` only refuses when the incoming commits would
/// actually overwrite one of those files. So this is reported, not enforced:
/// the UI warns, and git makes the call.
fn dirty() -> bool {
    git(&["status", "--porcelain", "--untracked-files=no"]).is_ok_and(|s| !s.is_empty())
}

/// The version the incoming commits will build as, read from the upstream copy
/// of `package.json` — the file `release:` commits bump, and the same value
/// `tauri.conf.json` and `Cargo.toml` carry.
///
/// Best-effort: an unreadable or unparseable manifest yields an empty string
/// and the UI falls back to naming the commit count. A version is a nicety
/// here, unlike in the old updater where it WAS the update decision.
fn incoming_version(upstream: &str) -> String {
    let Ok(raw) = git(&["show", &format!("{upstream}:package.json")]) else { return String::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return String::new() };
    json.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

// ── what the frontend sees ──────────────────────────────────────────────────

/// An update that is ready to apply: what is coming, and from where.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Commits `HEAD` is behind the upstream.
    pub behind: u32,
    /// The upstream ref, e.g. `origin/master`. Shown so the user can see which
    /// remote is about to put code on their machine.
    pub upstream: String,
    /// Version the incoming commits build as; `""` when it could not be read.
    pub version: String,
    /// Incoming commit subjects, newest first, at most `MAX_NOTES`.
    pub notes: Vec<String>,
    /// The working tree has uncommitted changes. The pull may still succeed —
    /// git refuses only when the incoming commits touch a modified file.
    pub dirty: bool,
}

/// The three answers `check_update` can give.
///
/// `Blocked` is NOT "up to date" and not a crash: it is a checkout that cannot
/// update itself in place — git missing, no upstream configured, a detached
/// HEAD. Collapsing it into either of the others would tell someone they are
/// current when nothing has ever been checked.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheck {
    Available { info: UpdateInfo },
    UpToDate,
    Blocked { reason: String },
}

/// Emitted for each line of build output, so a multi-minute rebuild reads as
/// work rather than as a hang.
///
/// There is no byte count and no percentage here, deliberately: a build has no
/// knowable total, and the old updater's bar was only honest because a download
/// has a `Content-Length`. `step`/`steps` is the only progress that is true.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct UpdateProgress {
    /// 1-based index of the running step.
    pub step: u32,
    /// How many steps this update has.
    pub steps: u32,
    /// The command being run, as a person would type it.
    pub command: String,
    /// Its most recent line of output, or `""` before it has printed anything.
    pub line: String,
}

/// Event name, shared with docs/ipc.md and SettingsModal.tsx.
pub const UPDATE_PROGRESS_EVENT: &str = "update-progress";

/// Can this checkout update itself? False disables the Check button rather than
/// offering one that can only fail.
#[tauri::command]
pub fn update_configured() -> bool {
    upstream().is_ok()
}

/// Fetch from the upstream remote and report what is waiting.
///
/// The fetch is the only network this module does on a check, and it is still
/// only ever on an explicit click — same promise the old updater made.
#[tauri::command]
pub fn check_update() -> Result<UpdateCheck, String> {
    let upstream = match upstream() {
        Ok(u) => u,
        Err(reason) => return Ok(UpdateCheck::Blocked { reason }),
    };
    // `--quiet` and no ref arguments: fetch what this branch tracks, nothing else.
    if let Err(e) = git(&["fetch", "--quiet"]) {
        return Ok(UpdateCheck::Blocked { reason: e });
    }
    let behind = behind(&upstream)?;
    if behind == 0 {
        return Ok(UpdateCheck::UpToDate);
    }
    let range = format!("HEAD..{upstream}");
    let notes = git(&["log", "--no-merges", "--pretty=format:%s", "-n", &MAX_NOTES.to_string(), &range])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(UpdateCheck::Available {
        info: UpdateInfo {
            behind,
            version: incoming_version(&upstream),
            upstream,
            notes,
            dirty: dirty(),
        },
    })
}

// ── applying it ─────────────────────────────────────────────────────────────

/// One command in the update, with the directory it runs in.
struct Step {
    /// How it is shown in the UI — the command as a person would type it.
    label: String,
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
}

impl Step {
    fn new(cwd: &Path, program: &str, args: &[&str]) -> Self {
        Self {
            label: format!("{program} {}", args.join(" ")),
            program: program.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: cwd.to_path_buf(),
        }
    }
}

/// Run one step, streaming its output to `on_line` and failing loudly.
///
/// stdout and stderr are drained by two threads into one channel: reading them
/// in sequence deadlocks the moment a tool fills the pipe it is not being read
/// from, and cargo writes everything to stderr, so "read stdout, then stderr"
/// would hang on the very step this exists for.
fn run_step(step: &Step, mut on_line: impl FnMut(&str)) -> Result<(), String> {
    let mut child = command(&step.program)
        .args(&step.args)
        .current_dir(&step.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run `{}`: {e}", step.label))?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut pumps = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        pumps.push(std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    return;
                }
            }
        }));
    }
    // The loop below ends when every sender is gone, so this one must not linger.
    drop(tx);

    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    for line in rx {
        on_line(&line);
        tail.push_back(line);
        if tail.len() > ERROR_TAIL_LINES {
            tail.pop_front();
        }
    }
    for pump in pumps {
        let _ = pump.join();
    }

    let status = child.wait().map_err(|e| format!("`{}`: {e}", step.label))?;
    if status.success() {
        return Ok(());
    }
    let tail: Vec<String> = tail.into();
    Err(format!(
        "`{}` failed ({status}):\n{}",
        step.label,
        tail.join("\n")
    ))
}

/// Cargo's output directory. Read from cargo rather than assumed to be
/// `src-tauri/target`: `build.target-dir` is routinely redirected (this
/// project's own dev box points it off the small volume the source lives on),
/// and guessing wrong means relaunching the binary from BEFORE the update while
/// reporting success.
fn cargo_target_dir(manifest: &Path) -> Result<PathBuf, String> {
    let out = command("cargo")
        .arg("metadata")
        .arg("--format-version")
        .arg("1")
        .arg("--no-deps")
        .current_dir(manifest)
        .output()
        .map_err(|e| format!("could not run cargo (is the Rust toolchain installed?): {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("cargo metadata: {e}"))?;
    json.get("target_directory")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .ok_or_else(|| "cargo metadata named no target directory".to_string())
}

/// `debug` or `release` — the profile THIS binary was built with, so the update
/// rebuilds the same thing that is running and relaunches what it just built.
fn running_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// The binary the rebuild produces.
fn built_binary(target_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        concat!(env!("CARGO_PKG_NAME"), ".exe")
    } else {
        env!("CARGO_PKG_NAME")
    };
    target_dir.join(running_profile()).join(name)
}

/// Pull, rebuild, and restart into the result.
///
/// Takes no arguments on purpose. The old `apply_update` was handed an
/// `UpdateInfo` back from the frontend and had to re-fetch the manifest to
/// avoid trusting it; here there is nothing to trust, because there is nothing
/// to pass: the pull is `--ff-only` onto the branch's own upstream, which is
/// read from the checkout every time.
#[tauri::command]
pub async fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_blocking(app))
        .await
        .map_err(|e| format!("update task: {e}"))?
}

fn apply_blocking(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    let root = root()?;
    let manifest = root.join("src-tauri");
    // Resolved BEFORE the build, so a broken `cargo metadata` fails while the
    // user still has their terminals and their old binary.
    let target_dir = cargo_target_dir(&manifest)?;

    // `npm ci` deletes and refetches node_modules — a minute, every time. Only
    // the lockfile can make it necessary, so read it before and after the pull
    // and run the install only if the pull actually moved it.
    let lock = root.join("package-lock.json");
    let lock_before = std::fs::read(&lock).ok();

    // `--features custom-protocol` decides dev-vs-production for the WHOLE binary:
    // the tauri crate's build script sets cfg(dev) to !custom-protocol, so without
    // it cargo produces an app that ignores the dist/ built one step earlier and
    // loads devUrl (http://localhost:1420) instead. The update would "succeed" and
    // leave the user with a window reading "Could not connect to localhost". The
    // tauri CLI passes it on `tauri build`; we build with cargo, so we pass it.
    // Same set scripts/run.sh uses — the two must not drift.
    let profile_args: Vec<&str> = if running_profile() == "release" {
        vec!["build", "--release", "--features", "custom-protocol"]
    } else {
        vec!["build", "--features", "custom-protocol,devtools"]
    };

    let pull = Step::new(root, "git", &["pull", "--ff-only"]);
    let install = Step::new(root, "npm", &["ci"]);
    let frontend = Step::new(root, "npm", &["run", "build"]);
    let backend = Step::new(&manifest, "cargo", &profile_args);

    // The count is settled up front so the UI never sees "step 3 of 3" turn
    // into "step 3 of 4". `npm ci` is the only conditional one, and whether it
    // runs is not knowable until the pull has happened — so it is counted in
    // and, when skipped, simply passes through instantly.
    let steps = 4u32;
    let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
    let mut emit = |step: u32, label: &str, line: &str, force: bool| {
        if !force && last_emit.elapsed() < PROGRESS_THROTTLE {
            return;
        }
        last_emit = Instant::now();
        let _ = app.emit(
            UPDATE_PROGRESS_EVENT,
            UpdateProgress {
                step,
                steps,
                command: label.to_string(),
                line: line.to_string(),
            },
        );
    };

    for (index, step) in [&pull, &install, &frontend, &backend].into_iter().enumerate() {
        let n = index as u32 + 1;
        // Index 1 is `npm ci`; see `lock_before`.
        if n == 2 && std::fs::read(&lock).ok() == lock_before {
            emit(n, &step.label, "dependencies unchanged — skipped", true);
            continue;
        }
        emit(n, &step.label, "", true);
        let mut last = String::new();
        run_step(step, |line| {
            last = line.to_string();
            emit(n, &step.label, line, false);
        })?;
        emit(n, &step.label, &last, true);
    }

    // Everything above this line is reversible: a failure leaves the terminals
    // up and the binary untouched. Everything below ends the session.
    let built = built_binary(&target_dir);
    if !built.exists() {
        return Err(format!(
            "the build reported success but produced no binary at {} — nothing was restarted, \
             and the running app is unchanged",
            built.display()
        ));
    }

    // The sidecar runs the OLD binary and deliberately outlives the GUI, so a
    // restart alone would leave the new GUI talking to the old host. Stopping it
    // ends the terminal sessions; that is why it happens last, once the update
    // is certain to be worth the cost.
    let client = app.state::<HostClient>();
    stop_host(&client)?;

    // Relaunch, telling the new process to wait for this one to fully exit —
    // otherwise it races our single-instance lock and host handoff during
    // teardown, which used to leave reattached panes blank.
    command(&built.to_string_lossy())
        .arg("--await-exit")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("start the rebuilt app ({}): {e}. {TERMINALS_ENDED}", built.display()))?;
    app.exit(0);
    Ok(())
}

// ── stopping the old sidecar ────────────────────────────────────────────────
//
// The GUI is not the whole app: `hostclient` runs a detached `this-exe --host`
// sidecar that owns every terminal and BigBrain, and it deliberately OUTLIVES the
// GUI. That is what let terminals survive a restart — but it also meant a
// self-update left the new GUI talking to a host still running the OLD binary.
// Harmless only for as long as the host protocol never changes; the first release
// that changes it would break on every machine that had self-updated, and would
// look like a runtime bug, because every version on disk would be correct.
//
// So the update stops the host, and stops it BEFORE the exe is replaced:
//   * a process running from the file being renamed is exactly what makes an
//     in-place swap fail on some filesystems (and is why `.old` files used to
//     linger un-deletable on Windows), and
//   * the new GUI spawns a host lazily on first connect (`hostclient::ensure_host`),
//     so with the old one gone the replacement comes up from the NEW exe by itself.
//
// Terminal sessions do NOT survive this. They cannot: the shells are children of
// the host. Stopping it via the normal shutdown message at least reaps them (and
// their children) properly instead of orphaning them.

/// How long the host gets to honour `shutdown` before we escalate to signals.
const HOST_STOP_GRACE: Duration = Duration::from_secs(5);
/// How long a killed host gets to actually disappear before we give up.
const HOST_KILL_GRACE: Duration = Duration::from_secs(3);
/// Appended to the errors raised after the host has already been stopped, so the
/// message never leaves the user wondering why their terminals went away.
const TERMINALS_ENDED: &str = "The terminal host was stopped for the update, so \
    running terminal sessions have ended; restart PixelMarch to get terminals back.";

/// Accept only a plausible pid. `0` is not a process we could wait on, and a
/// truncated or half-written file must read as "unknown", not as pid 0.
fn parse_pid(raw: &str) -> Option<u32> {
    raw.trim().parse::<u32>().ok().filter(|p| *p != 0)
}

/// The pid the running host published, if it published one. `None` covers both
/// "no host" and "a host from a build older than this one", which is why nothing
/// below treats an unknown pid as a failure.
fn host_pid() -> Option<u32> {
    parse_pid(&std::fs::read_to_string(crate::host::pid_file()).ok()?)
}

/// The port the running host published, if any.
fn host_port() -> Option<u16> {
    std::fs::read_to_string(crate::host::port_file()).ok()?.trim().parse::<u16>().ok()
}

/// True while something still accepts connections on `port` — the observable
/// half of "is the old host gone", and the half that matters for the next host,
/// which has to bind a port out of the same range.
///
/// `connect_timeout` alone is NOT a reliable answer. It does a non-blocking
/// connect and then polls, and on Linux the poll can report the socket ready
/// while the connection was in fact refused — it hands back an `Ok(TcpStream)`
/// that is not connected to anything (`peer_addr()` = `ENOTCONN`). Measured at
/// ~25% of probes against a just-released loopback port. Taking that `Ok` at
/// face value is a false "the old host still holds the port", which is exactly
/// the answer that makes an update refuse itself forever. So the connection is
/// only believed once the socket can name its peer.
fn port_answers(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        Ok(stream) => stream.peer_addr().is_ok(),
        Err(_) => false,
    }
}

/// Is `pid` a process that is still RUNNING — as opposed to absent, or a corpse
/// nobody has collected yet?
///
/// The zombie case is not hypothetical: the GUI spawns the host with `spawn()`
/// and never waits on it, so an exited host stays in the process table as
/// `<defunct>` for as long as the GUI that started it lives. The first real
/// end-to-end run of this code failed exactly there — the host had shut down
/// cleanly, its port, token and pid files were gone, and the update still
/// refused because the zombie kept answering "yes, that pid exists".
fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid) {
        None => false,
        Some(p) => p.status() != ProcessStatus::Zombie,
    }
}

/// Does `pid` name a process that is running AND is actually OUR terminal host?
///
/// Liveness alone is not enough to act on, because the pid we are given comes
/// from a file we do not control the lifetime of: `pixelmarch-host.pid` is only
/// removed on the clean shutdown path, so any crash, SIGKILL or panic leaves it
/// behind. Pids are recycled — after a reboot a low pid is handed out again
/// within minutes — so a stale file plus bare liveness would have the updater
/// SIGTERM/SIGKILL a completely unrelated process, and abort a legitimate update
/// with "could not stop the terminal host" when no host is running at all.
///
/// So identity is part of the question: a pid that is alive but is not a host
/// reads as GONE, and is never signalled. The port half of the "both must agree"
/// check is unaffected — a host that really is up still holds its port.
fn host_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
    let spid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[spid]), true);
    let Some(p) = sys.process(spid) else { return false };
    if p.status() == ProcessStatus::Zombie {
        return false;
    }
    let Ok(cur) = std::env::current_exe() else { return false };
    // Strip a Linux " (deleted)" marker first: identity is matched by file name,
    // and "pixelmarch (deleted)" never matches the live host's "pixelmarch".
    // Without this a running host reads as GONE in exactly the moved-exe case
    // this module now survives — stop_host would return Ok with the old host
    // still up, and the kill path would discard the pid as unidentifiable.
    let cur = intended_install_path(&cur);
    let cmd: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    looks_like_host(p.exe(), &cmd, &cur)
}

/// The identity half of [`host_alive`], split out so both answers are testable
/// without arranging a real process to be one.
///
/// `--host` is REQUIRED, not a fallback: the GUI runs the very same executable,
/// so matching on the image alone would call the GUI itself a host. The image
/// must match too — argv[0]'s file name is accepted when `exe` is unreadable
/// (permissions, or a platform sysinfo cannot answer for). Anything that fails
/// to identify positively is not our host.
fn looks_like_host(exe: Option<&std::path::Path>, cmd: &[String], cur: &std::path::Path) -> bool {
    if !cmd.iter().any(|a| a == "--host") {
        return false;
    }
    if exe.is_some_and(|exe| exe == cur) {
        return true;
    }
    let Some(name) = cur.file_name() else { return false };
    cmd.first().is_some_and(|argv0| {
        std::path::Path::new(argv0).file_name().is_some_and(|n| n == name)
    })
}

/// Decide "the old host is really gone" from the two independent observations.
/// Both must agree: a live pid means the process is still there whatever the
/// socket does, and a socket that still answers means SOMETHING is holding the
/// port even if the pid we knew about has died. Either alone would let the update
/// proceed while the thing it was supposed to remove is still running.
fn host_gone(alive: bool, port_busy: bool) -> bool {
    !alive && !port_busy
}

/// Poll `host_gone` until it holds or `timeout` expires.
fn wait_host_gone(pid: Option<u32>, port: Option<u16>, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let alive = pid.map(host_alive).unwrap_or(false);
        let busy = port.map(port_answers).unwrap_or(false);
        if host_gone(alive, busy) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Last resort for a host that ignored `shutdown`. Signals the host process ONLY
/// (never its process group — on unix the host inherits the GUI's group, so a
/// group signal would kill the GUI that is mid-update). Terminal children are
/// then orphaned rather than reaped, which is the price of a wedged host; the
/// clean path above is the one that reaps them.
fn kill_host(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let pid = Pid::from_raw(pid as i32);
        let _ = kill(pid, Signal::SIGTERM);
        std::thread::sleep(Duration::from_millis(300));
        let _ = kill(pid, Signal::SIGKILL);
    }
}

/// Stop the detached `--host` sidecar, or explain why the update must not go on.
///
/// Returning `Err` ABORTS the update with the exe untouched — that is deliberate.
/// A half-updated app whose GUI is new and whose host is old is precisely the
/// state this task exists to prevent, so a host we cannot get rid of has to be a
/// visible failure, not a silent one.
fn stop_host(client: &HostClient) -> Result<(), String> {
    let pid = host_pid();
    let port = host_port();
    if pid.is_none() && port.is_none() {
        return Ok(()); // no host was ever started (or it cleaned up after itself)
    }
    // Stale files from a host that died without cleaning up are not a host.
    if wait_host_gone(pid, port, Duration::ZERO) {
        return Ok(());
    }
    // The polite path: the host kills every session's process TREE, drops its
    // port/token/pid files and exits. Same message as "Close all & quit".
    client.shutdown();
    if wait_host_gone(pid, port, HOST_STOP_GRACE) {
        return Ok(());
    }
    tracing::warn!("terminal host did not stop within {HOST_STOP_GRACE:?}; killing it");
    // Only signal a pid we have positively identified as our own host. Reaching
    // here with an unidentified pid means the PORT is what is still busy, held by
    // something that is not ours — killing the pid would hit a bystander and would
    // not free the port anyway.
    let pid = pid.filter(|p| host_alive(*p));
    let Some(pid) = pid else {
        return Err("the terminal host's port is still in use and the host did not respond \
             to the shutdown request, and there is no host process we can identify to stop \
             (its pid file is stale, or it predates this version). Quit PixelMarch completely \
             with \"Close all & quit\", reopen it, and update again — updating now would leave \
             the new app talking to the old host."
            .to_string());
    };
    kill_host(pid);
    if wait_host_gone(Some(pid), port, HOST_KILL_GRACE) {
        return Ok(());
    }
    Err(format!(
        "could not stop the terminal host (pid {pid}) — updating now would leave the \
         new app talking to a host running the old binary. Nothing was changed. Quit \
         PixelMarch completely with \"Close all & quit\" and update again."
    ))
}

/// The path the new exe should be installed to, given what `current_exe()` reports.
///
/// On Linux a process whose backing file was deleted or moved out from under it
/// reads back through /proc/self/exe as "<path> (deleted)". `current_exe()` hands
/// that string through verbatim, so a naive `rename(cur, ...)` targets a path that
/// can never exist and fails with os error 2 (ENOENT). Strip the marker so we
/// target the real install location; a path without it is returned unchanged.
/// Shared with `hostclient::spawn_host`, which hands the same `current_exe()`
/// string to `Command::new` and would otherwise spawn a path that can never
/// resolve.
pub(crate) fn intended_install_path(cur: &std::path::Path) -> std::path::PathBuf {
    const DELETED: &str = " (deleted)";
    if let Some(stripped) = cur.to_str().and_then(|s| s.strip_suffix(DELETED)) {
        return std::path::PathBuf::from(stripped);
    }
    cur.to_path_buf()
}
/// Block until process `pid` has exited (bounded ~10s, best-effort). Called right
/// after a self-update relaunch so the new GUI starts only once the old one is
/// gone — avoiding the single-instance / host-handoff race that blanked reattached
/// panes. If the pid lingers past the cap we proceed anyway (never hang the app).
pub fn wait_for_process_exit(pid: u32) {
    // `process_alive`, not "is there a pid": the old GUI can sit around as an
    // unreaped zombie, and waiting the full ten seconds for a corpse only delays
    // the window the user is waiting for.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while process_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::{built_binary, host_gone, intended_install_path, looks_like_host, parse_pid,
                port_answers, process_alive, running_profile, wait_for_process_exit,
                wait_host_gone, host_alive, Step, UpdateCheck, UpdateInfo, UpdateProgress};

    /// It narrows the race to this process only; nothing here can stop an
    /// unrelated process on the box from grabbing the number in the
    /// microseconds after we drop it.
    static PORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take `PORT_LOCK`, tolerating poisoning — a panic in one port test must
    /// not cascade into "all the others fail on a poisoned mutex" and bury the
    /// single real failure.
    fn port_lock() -> std::sync::MutexGuard<'static, ()> {
        PORT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }


    #[test]
    fn wait_returns_immediately_for_absent_pid() {
        // The "process already gone" path must return fast, not sit out the 10s cap.
        let t = std::time::Instant::now();
        wait_for_process_exit(u32::MAX); // no such process
        assert!(t.elapsed() < std::time::Duration::from_secs(5));
    }

    /// A running exe deleted/moved out from under the process reads back through
    /// /proc/self/exe with a " (deleted)" marker; the install target strips it so we
    /// don't rename-to-a-ghost (os error 2). A normal path passes through untouched.
    #[test]
    fn intended_install_strips_deleted_marker() {
        use std::path::{Path, PathBuf};
        assert_eq!(
            intended_install_path(Path::new("/opt/pixelmarch/pixelmarch (deleted)")),
            PathBuf::from("/opt/pixelmarch/pixelmarch")
        );
        assert_eq!(
            intended_install_path(Path::new("/opt/pixelmarch/pixelmarch")),
            PathBuf::from("/opt/pixelmarch/pixelmarch")
        );
        // Only a trailing marker is stripped — a real name containing the word is kept.
        assert_eq!(
            intended_install_path(Path::new("/opt/deleted/app")),
            PathBuf::from("/opt/deleted/app")
        );
    }


    // ── the source update ───────────────────────────────────────────────────
    //
    // `check_update` and `apply_update` both shell out to git, npm and cargo in
    // a real checkout, so the end-to-end path is exercised by running it. What
    // IS testable without a build is the shape of what they hand the UI, and
    // the two decisions that would silently relaunch the WRONG binary.

    /// The rebuild must produce, and the relaunch must start, the profile that
    /// is running — a release build that rebuilt `debug/` (or the reverse) would
    /// report success and restart into unchanged code.
    #[test]
    fn the_rebuilt_binary_is_the_running_profile() {
        let target = std::path::Path::new("/tmp/target");
        let built = built_binary(target);
        assert!(built.starts_with(target.join(running_profile())), "{}", built.display());
        assert_eq!(running_profile(), if cfg!(debug_assertions) { "debug" } else { "release" });
        // Named after the crate, so a rename cannot leave this pointing at a
        // binary that no longer exists.
        assert!(built.file_name().unwrap().to_string_lossy().starts_with(env!("CARGO_PKG_NAME")));
    }

    /// A step shows the user the command it is about to run, verbatim. This is
    /// the only place the UI learns what is executing on their machine.
    #[test]
    fn a_step_is_labelled_with_the_command_it_runs() {
        let step = Step::new(std::path::Path::new("/tmp"), "git", &["pull", "--ff-only"]);
        assert_eq!(step.label, "git pull --ff-only");
        assert_eq!(step.program, "git");
        assert_eq!(step.args, vec!["pull".to_string(), "--ff-only".to_string()]);
    }

    /// The frontend switches on `status`, so the tag has to be there and the
    /// payload has to be camelCase — see SettingsModal.tsx.
    #[test]
    fn check_results_serialise_with_a_status_tag() {
        let up = serde_json::to_value(UpdateCheck::UpToDate).unwrap();
        assert_eq!(up, serde_json::json!({ "status": "upToDate" }));

        let blocked = serde_json::to_value(UpdateCheck::Blocked { reason: "no upstream".into() }).unwrap();
        assert_eq!(blocked, serde_json::json!({ "status": "blocked", "reason": "no upstream" }));

        let available = serde_json::to_value(UpdateCheck::Available {
            info: UpdateInfo {
                behind: 4,
                upstream: "origin/master".into(),
                version: "0.1.38".into(),
                notes: vec!["fix(swarm): a thing".into()],
                dirty: true,
            },
        })
        .unwrap();
        assert_eq!(
            available,
            serde_json::json!({
                "status": "available",
                "info": {
                    "behind": 4,
                    "upstream": "origin/master",
                    "version": "0.1.38",
                    "notes": ["fix(swarm): a thing"],
                    "dirty": true,
                },
            })
        );
    }

    /// A build has no knowable total, so progress is steps and the latest line —
    /// never a percentage. Pinned because the UI renders exactly these fields.
    #[test]
    fn progress_reports_the_step_and_the_line_and_nothing_invented() {
        let value = serde_json::to_value(UpdateProgress {
            step: 4,
            steps: 4,
            command: "cargo build --release".into(),
            line: "   Compiling pixelmarch v0.1.37".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "step": 4,
                "steps": 4,
                "command": "cargo build --release",
                "line": "   Compiling pixelmarch v0.1.37",
            })
        );
    }

    // ── stopping the old sidecar ────────────────────────────────────────────
    // `stop_host` itself needs a live HostClient and a real detached process, so
    // the end-to-end path was verified by hand rather than in a unit test. What IS testable is
    // the decision it is built on — "is the old host really gone" — and the pid
    // parsing that feeds it.

    #[test]
    fn a_pid_file_is_only_believed_when_it_holds_a_real_pid() {
        assert_eq!(parse_pid("4242"), Some(4242));
        assert_eq!(parse_pid(" 4242\n"), Some(4242));
        // A zero, a truncated write or junk must read as "unknown pid", never as
        // a pid we would then wait on (or signal).
        assert_eq!(parse_pid("0"), None);
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("nope"), None);
        assert_eq!(parse_pid("-1"), None);
    }

    /// Both observations have to say "gone". Either one alone would let an update
    /// proceed over a host that is still there — a live process whose socket has
    /// closed, or a port still held by something after the pid we knew about died.
    #[test]
    fn the_host_counts_as_gone_only_when_process_and_port_agree() {
        assert!(host_gone(false, false));
        assert!(!host_gone(true, false));
        assert!(!host_gone(false, true));
        assert!(!host_gone(true, true));
    }

    /// A bound port answers; the same port answers no more once it is dropped.
    ///
    /// The "answers no more" half is asserted with a bounded settle, not in the
    /// microsecond after `drop`. Closing a listening socket does not instantly
    /// stop the kernel completing connects that are already in flight against
    /// it, so a probe fired immediately after `drop` can still come back with a
    /// genuinely connected socket (observed local/peer pair, ~15% of runs). That
    /// window is the kernel's, not this code's, and production never looks
    /// through it either: `wait_host_gone` polls with a grace period. So the test
    /// asserts what production depends on — the port goes quiet, and quickly —
    /// rather than that it goes quiet within one syscall.
    #[test]
    fn a_listening_port_is_seen_and_a_closed_one_is_not() {
        let _guard = port_lock();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_answers(port), "a bound port must read as busy");
        drop(listener);
        assert!(
            wait_host_gone(None, Some(port), std::time::Duration::from_secs(2)),
            "a released port must read as free"
        );
    }

    /// The wait must not return "gone" while the port is still held — that is the
    /// case that would let a new GUI start against an old host.
    #[test]
    fn waiting_reports_not_gone_while_something_still_holds_the_port() {
        let _guard = port_lock();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!wait_host_gone(None, Some(port), std::time::Duration::from_millis(300)));
        drop(listener);
        assert!(wait_host_gone(None, Some(port), std::time::Duration::from_millis(300)));
    }

    /// No pid file and no port file is not a failure — it is an app that never
    /// started a host, and the update must sail straight past it.
    #[test]
    fn nothing_published_means_nothing_to_wait_for() {
        assert!(wait_host_gone(None, None, std::time::Duration::ZERO));
    }

    /// Our own pid is alive by definition; a pid that cannot exist is not.
    #[test]
    fn process_liveness_is_read_from_the_real_process_table() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(u32::MAX));
    }

    /// An exited child nobody has waited on is NOT alive, however long it stays
    /// in the process table. This is the bug the first real end-to-end run hit:
    /// the GUI never reaps the host it spawned, so a host that had shut down
    /// perfectly cleanly still looked alive and the update refused itself.
    #[test]
    fn a_child_nobody_reaped_is_not_alive() {
        // `child` is deliberately never waited on, and dropping a `Child` in Rust
        // does not reap it either — so on unix this pid is a zombie from here on.
        let child = std::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn true");
        let pid = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while process_alive(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!process_alive(pid), "an exited child must not read as alive (pid {pid})");
    }

    /// Liveness is not identity. The test runner is unquestionably alive, and it
    /// is unquestionably not a `--host` sidecar — so a pid file left behind by a
    /// crashed host and later recycled onto an ordinary process must read as
    /// GONE. If this ever regresses, the updater kills a bystander.
    #[test]
    fn a_live_process_that_is_not_the_host_reads_as_gone() {
        let me = std::process::id();
        assert!(process_alive(me), "the test process is alive");
        assert!(!host_alive(me), "...but it is not our terminal host");
        // ...and therefore a stale pid alone never blocks an update.
        assert!(wait_host_gone(Some(me), None, std::time::Duration::ZERO));
    }

    /// A pid that names nothing at all is not a host either — no panic, no wait.
    #[test]
    fn an_absent_pid_is_not_the_host() {
        assert!(!host_alive(u32::MAX));
    }

    /// Both directions of the identity test, without needing a real sidecar.
    #[test]
    fn only_our_exe_running_with_host_counts_as_the_host() {
        use std::path::Path;
        let cur = Path::new("/opt/pixelmarch/pixelmarch");
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // The real thing, identified by image path...
        assert!(looks_like_host(Some(cur), &args(&["pixelmarch", "--host"]), cur));
        // ...and by argv[0] when the image path is unreadable.
        assert!(looks_like_host(None, &args(&["/opt/pixelmarch/pixelmarch", "--host"]), cur));

        // Our own exe WITHOUT --host is the GUI, not the host.
        assert!(!looks_like_host(Some(cur), &args(&["pixelmarch"]), cur));
        // A recycled pid: something else entirely, whatever its arguments.
        assert!(!looks_like_host(
            Some(Path::new("/usr/bin/rsync")),
            &args(&["rsync", "--host"]),
            cur
        ));
        // Nothing readable at all is not a positive identification.
        assert!(!looks_like_host(None, &[], cur));
    }
}
