//! PTY helpers shared by the session host (`host.rs`).
//!
//! The PTYs themselves are now owned by the detached host process (so they
//! survive a GUI restart / in-place update); this module just holds the
//! shell/arg/env building and the tree-kill that both the host and any future
//! caller need. `SpawnOpts` is the on-the-wire spawn request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use portable_pty::Child;
use serde::{Deserialize, Serialize};

/// How a pane's child process is attached to the world.
///
/// `Pty` is what every pane has always been and stays the default: a real
/// terminal, byte stream in and out, a human (or a keystroke injector) driving
/// a TUI. `Piped` is the headless mode — plain stdin/stdout pipes carrying
/// line-delimited JSON, for a CLI that speaks a stream protocol
/// (`claude -p --input-format stream-json --output-format stream-json`) and
/// needs no terminal at all.
///
/// The mode is an explicit per-pane parameter rather than something inferred
/// from the command, because only the frontend knows whether the CLI in this
/// pane is headless-capable (`AGENT_CAPS[bin].headless`) — and a wrong guess
/// here is invisible: a TUI on pipes just sits there rendering nothing.
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum SpawnMode {
    #[default]
    Pty,
    Piped,
}

/// Everything needed to launch a pane from a profile.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    pub rows: u16,
    pub cols: u16,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub startup_command: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub big_brain_targets: Option<Vec<String>>,
    /// Absent = `Pty`, so every `Open` frame an older GUI sends — and every
    /// existing caller — keeps exactly today's behaviour. This is an addition,
    /// not a replacement.
    #[serde(default)]
    pub mode: Option<SpawnMode>,
}

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;

/// Lock a mutex, recovering the guard even if a thread panicked while holding it,
/// so one bad pane can't poison the manager and take the whole app down.
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Turn a startup command into shell args that run it and then drop to an
/// interactive prompt. Passing it as an arg is reliable; typing it into the
/// pty races the shell's line editor (PSReadLine) and gets swallowed.
pub fn startup_args(shell: &str, startup: &str, mut base: Vec<String>) -> Vec<String> {
    let name = std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match name.as_str() {
        "powershell" | "pwsh" => {
            base.push("-NoExit".into());
            base.push("-Command".into());
            base.push(startup.into());
            base
        }
        "cmd" => {
            base.push("/K".into());
            base.push(startup.into());
            base
        }
        "bash" | "sh" | "zsh" => vec!["-c".into(), format!("{startup}; exec {name} -i")],
        // Same shape as the sh family. Without this arm fish falls to the
        // catch-all, which passes the startup command as a bare arg — fish
        // reads that as a script *filename* and dies with "no such file".
        "fish" => vec!["-c".into(), format!("{startup}; exec fish -i")],
        "wsl" => {
            base.push("--".into());
            base.push("bash".into());
            base.push("-lic".into());
            base.push(format!("{startup}; exec bash"));
            base
        }
        _ => {
            base.push(startup.into());
            base
        }
    }
}

/// Shell args that run `startup` and then EXIT — the headless counterpart to
/// [`startup_args`].
///
/// The difference is the whole point: `startup_args` drops to an interactive
/// prompt afterwards, which is right for a PTY pane and wrong for a piped one.
/// A headless pane has no terminal to be interactive on, and an interactive
/// shell left behind would hold stdout open forever after the agent exits — the
/// pane would never report its exit and the UI would show a live pane with a
/// dead agent in it.
///
/// Same shell dispatch as `startup_args` so the two cannot drift on which
/// shells are understood.
pub fn headless_args(shell: &str, startup: &str, mut base: Vec<String>) -> Vec<String> {
    let name = std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match name.as_str() {
        "powershell" | "pwsh" => {
            base.push("-Command".into());
            base.push(startup.into());
            base
        }
        "cmd" => {
            base.push("/C".into());
            base.push(startup.into());
            base
        }
        "bash" | "sh" | "zsh" | "fish" => vec!["-c".into(), startup.into()],
        "wsl" => {
            base.push("--".into());
            base.push("bash".into());
            base.push("-lc".into());
            base.push(startup.into());
            base
        }
        _ => {
            base.push(startup.into());
            base
        }
    }
}

/// Put a piped child in its own process group, so [`kill_tree`] keeps working
/// on it UNCHANGED.
///
/// `kill_tree` signals a process GROUP on unix, and is allowed to assume
/// `pgid == pid` because portable-pty calls `setsid` on the slave pty for us.
/// A `std::process::Command` child gets no such treatment: it inherits the
/// host's process group, so `killpg(child_pid)` would signal a group that is
/// not the child's — and the grandchild reaping that is the entire point of
/// `kill_tree` would be lost SILENTLY, with the kill still appearing to work
/// because the direct `child.kill()` at the end of it still lands.
///
/// So the fix belongs here, in the spawn, not in `kill_tree`: make the
/// assumption true again instead of special-casing the killer.
pub fn new_process_group(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Safety: `setsid` is async-signal-safe and touches nothing this
        // process owns — it runs in the forked child before exec.
        unsafe {
            cmd.pre_exec(|| {
                // Fails only if we are already a group leader, which a freshly
                // forked child never is.
                nix::unistd::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    cmd
}

/// Kill the whole process tree, not just the shell — zombie Claude/Python
/// children are unacceptable. On Windows that means `taskkill /T /F`; on unix
/// we signal the shell's whole process group, SIGTERM then SIGKILL, which
/// reaches grandchildren `child.kill()` would orphan.
///
/// That group signal is only correct because pgid == pid holds for BOTH spawn
/// modes, by two different mechanisms: a PTY pane's shell is a session leader
/// thanks to portable-pty's `setsid` on the slave pty, and a piped pane's child
/// gets there through `new_process_group` above. Neither is optional — a child
/// that inherits the host's process group would make this signal the host.
pub fn kill_tree(pid: Option<u32>, child: &SharedChild) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Some(pid) = pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
    #[cfg(not(windows))]
    {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        if let Some(pid) = pid {
            // pid doubles as the process-group id (see doc-comment above).
            let pgid = Pid::from_raw(pid as i32);
            let _ = killpg(pgid, Signal::SIGTERM);
            // Give the group a moment to exit cleanly, then force it.
            std::thread::sleep(std::time::Duration::from_millis(150));
            let _ = killpg(pgid, Signal::SIGKILL);
        }
    }
    let _ = pid; // used only on the platform-specific branches above
    let _ = lock(child).kill();
}

// ---------------------------------------------------------------------------
// Portable webview state.
//
// WebKitGTK derives its cache/storage path from XDG_DATA_HOME / XDG_CACHE_HOME
// and the bundle identifier, so a shipped build writes
// ~/.local/share/io.pixelmarch.pixelmarch/ (WebKitCache, storage, CacheStorage,
// hsts-storage.sqlite, mediakeys) without any code of ours asking for it — the
// one unrequested $HOME write the app makes. We point those two variables at
// the profile directory instead, so a portable checkout has zero home footprint.
//
// The catch: every process we spawn inherits that environment, and a user's
// shell reading OUR XDG paths would write its own state into the exe dir. So
// the originals are stashed at startup and restored for children.
// ---------------------------------------------------------------------------

/// The variables the webview redirect overwrites.
pub const XDG_VARS: [&str; 2] = ["XDG_DATA_HOME", "XDG_CACHE_HOME"];
/// Set once the redirect is actually applied. Its ABSENCE means we never
/// touched the environment (e.g. a read-only install), so children must be left
/// exactly as they are — stripping the vars there would be a second bug.
pub const XDG_MARKER: &str = "PIXELMARCH_XDG_REDIRECTED";
/// `PIXELMARCH_ORIG_XDG_DATA_HOME` etc. carry the value the variable held at
/// startup. Absent *while the marker is set* means it was originally UNSET, and
/// must be unset in the child — not set to empty, which WebKitGTK and the XDG
/// spec both read as "no value" but shells do not.
pub const XDG_ORIG_PREFIX: &str = "PIXELMARCH_ORIG_";

/// Where the webview's state lives: `<repo>/data/webview/{data,cache}`.
pub fn webview_dirs(base: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = base.join("webview");
    (root.join("data"), root.join("cache"))
}

pub fn xdg_orig_key(var: &str) -> String {
    format!("{XDG_ORIG_PREFIX}{var}")
}

/// Who this pane is, in the child's environment. Read by the agent hooks we
/// install (see `hook_settings_json`) so one settings file serves every pane.
pub const PANE_IDENT_VARS: [&str; 2] = ["PIXELMARCH_ROLE", "PIXELMARCH_PROJECT"];

/// The env changes that undo the redirect for a child process, read through
/// `get` so this is testable without mutating the real environment.
/// `(name, Some(value))` = set it, `(name, None)` = unset it.
///
/// Empty when we never redirected — the child then inherits untouched.
pub fn child_env_overrides<F>(get: F) -> Vec<(String, Option<String>)>
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = Vec::new();
    // Pane identity, forwarded when the caller has it. It rides the environment
    // rather than the agent's config file so the hook settings we write are
    // BYTE-IDENTICAL for every pane — two swarms sharing a directory would
    // otherwise take turns overwriting each other's role into the same file.
    // Outside the redirect check on purpose: a host that never redirected still
    // has panes with roles.
    for var in PANE_IDENT_VARS {
        if let Some(v) = get(var) {
            out.push((var.to_string(), Some(v)));
        }
    }
    if get(XDG_MARKER).is_none() {
        return out;
    }
    for var in XDG_VARS {
        let key = xdg_orig_key(var);
        out.push((var.to_string(), get(&key)));
        // Our bookkeeping is not the child's business either.
        out.push((key, None));
    }
    out.push((XDG_MARKER.to_string(), None));
    out
}

/// A command builder we can stage environment edits on before spawning.
/// `std::process::Command` and `tokio::process::Command` have the same
/// `env`/`env_remove` shape but share no trait, and `portable_pty`'s
/// `CommandBuilder` spells it differently again — so we bridge them here and
/// every spawn site calls one function.
pub trait ChildEnv {
    fn set_child_var(&mut self, key: &str, val: &str);
    fn unset_child_var(&mut self, key: &str);
}

impl ChildEnv for std::process::Command {
    fn set_child_var(&mut self, key: &str, val: &str) {
        self.env(key, val);
    }
    fn unset_child_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl ChildEnv for tokio::process::Command {
    fn set_child_var(&mut self, key: &str, val: &str) {
        self.env(key, val);
    }
    fn unset_child_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl ChildEnv for portable_pty::CommandBuilder {
    fn set_child_var(&mut self, key: &str, val: &str) {
        self.env(key, val);
    }
    fn unset_child_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

/// Undo the webview XDG redirect for a child process about to be spawned.
///
/// Call this on EVERY command we launch: a child that inherits our
/// `XDG_DATA_HOME` reads the profile directory instead of the user's home, which
/// for `xdg-open` means losing the user's `mimeapps.list` and opening the
/// wrong program (or nothing) — and for a shell means writing its own state
/// into our portable directory.
///
/// No-op when we never redirected (no marker), so a read-only install leaves
/// children exactly as they were.
pub fn strip_webview_env<C: ChildEnv>(cmd: &mut C) -> &mut C {
    strip_webview_env_with(cmd, |k| std::env::var(k).ok())
}

/// `strip_webview_env` with the environment read through `get`, so the staging
/// logic is testable without mutating the real (process-global) environment.
pub fn strip_webview_env_with<C: ChildEnv, F: Fn(&str) -> Option<String>>(
    cmd: &mut C,
    get: F,
) -> &mut C {
    for (key, val) in child_env_overrides(get) {
        match val {
            Some(v) => cmd.set_child_var(&key, &v),
            None => cmd.unset_child_var(&key),
        }
    }
    cmd
}

/// Apply `child_env_overrides` to THIS process. Used by the detached session
/// host (`--host`), which inherits the GUI's redirected environment but owns no
/// webview — every PTY shell it spawns copies its environment, so restoring
/// here fixes all of them at once.
pub fn restore_env_from_stash() {
    for (k, v) in child_env_overrides(|k| std::env::var(k).ok()) {
        match v {
            Some(v) => std::env::set_var(&k, v),
            None => std::env::remove_var(&k),
        }
    }
}

/// Stash the current XDG values, then point them at `<base>/webview`.
/// Returns the two directories on success. Errors (read-only install) leave the
/// environment completely untouched: no marker, so children stay untouched too.
pub fn redirect_webview_state(
    base: &std::path::Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let (data, cache) = webview_dirs(base);
    for dir in [&data, &cache] {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    for (var, dir) in XDG_VARS.iter().zip([&data, &cache]) {
        if let Some(orig) = std::env::var_os(var) {
            std::env::set_var(xdg_orig_key(var), orig);
        } else {
            // Leave no stale stash from a parent PixelMarch.
            std::env::remove_var(xdg_orig_key(var));
        }
        std::env::set_var(var, dir);
    }
    std::env::set_var(XDG_MARKER, "1");
    Ok((data, cache))
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

const BB_BEGIN: &str = "<!-- BEGIN BIGBRAIN (managed by PixelMarch) -->";
const BB_END: &str = "<!-- END BIGBRAIN (managed by PixelMarch) -->";
// Pre-rename delimiters: repos written by TermMarch still carry these. Matched
// as a fallback so the block is updated in place instead of duplicated.
const LEGACY_BB_BEGIN: &str = "<!-- BEGIN BIGBRAIN (managed by TermMarch) -->";
const LEGACY_BB_END: &str = "<!-- END BIGBRAIN (managed by TermMarch) -->";

/// Ensure a PixelMarch-managed BigBrain block in the config files agents auto-load
/// (AGENTS.md, CLAUDE.md) in `dir`. Idempotent: only the delimited block is
/// managed; the user's own content is never touched.
pub fn ensure_bigbrain_files(dir: &std::path::Path, base: &str, targets: &[String]) {
    // Project = this folder's name (same convention the brain service uses).
    let project = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("<project>");
    let block = bigbrain_block(base, project, cfg!(windows));
    for name in targets {
        let rel = name.trim();
        if rel.is_empty() {
            continue;
        }
        // ponytail: user-chosen paths in their own profile — no traversal guard.
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        // Current delimiters win; fall back to the TermMarch-era pair so an old
        // block is replaced (not appended to) on first run after the rename.
        let (begin, end) = if !existing.contains(BB_BEGIN) && existing.contains(LEGACY_BB_BEGIN) {
            (LEGACY_BB_BEGIN, LEGACY_BB_END)
        } else {
            (BB_BEGIN, BB_END)
        };
        let next = merge_managed_block(&existing, &block, begin, end);
        if next != existing {
            let _ = std::fs::write(&path, next);
        }
    }
}

/// A base URL with its `/t/<token>/` credential prefix removed.
///
/// The managed block is written into CLAUDE.md / AGENTS.md — files that live in
/// the user's repo and get COMMITTED. A session token in there would be a secret
/// in git history, and (because it is minted fresh on every host start) a line
/// that dirties the working tree on every launch. Same reasoning bars the
/// absolute path of the token file: it names this machine.
pub fn base_without_token(base: &str) -> &str {
    match base.find("/t/") {
        Some(i) => &base[..i],
        None => base,
    }
}

/// Percent-encode one URL path segment or query value: everything outside the
/// unreserved set is escaped. Ten lines instead of a dependency, and the brain's
/// own `pct_decode` (brain/mod.rs) is its exact inverse — it decodes query pairs
/// AND path segments, so an encoded project name round-trips on both routes.
fn pct_encode(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => { let _ = write!(out, "%{b:02X}"); }
        }
    }
    out
}

/// The managed BigBrain block agents auto-load. `windows` decides the curl spelling
/// and is a PARAMETER, not `cfg!`, so both renderings are testable on one host.
///
/// On Windows the commands MUST say `curl.exe`: PowerShell aliases bare `curl` to
/// Invoke-WebRequest, which reads `-s`/`-d` as its own params and never reaches the
/// brain — every agent's escape hatch breaks with no error to explain it.
///
/// The brain now requires a session token, and the commands here reach for it
/// through `$BIGBRAIN_URL` — the env var every pane is spawned with (see the
/// `cmd.env` in host.rs), which already carries the `/t/<token>/` prefix. Nothing
/// machine-specific and nothing secret therefore lands in the committed file, and
/// a pane opened after a restart picks the new token up with no edit anywhere.
/// The bare URL in the heading is the service address, not a working base.
///
/// Markdown structure (heading + blank lines) is load-bearing too: without it the
/// whole block collapses into one paragraph in the agent's context and reads as prose.
///
/// QUERY SAFETY, same rule as `hook_command` and for the same reason. The one
/// value an agent substitutes into these lines is free text — a RECALL topic —
/// and a topic is almost always MULTI-WORD. Spliced into the URL as `q=<topic>`
/// it dies at the first space (curl never gets a usable request line) or, with a
/// `&` in it, truncates at the ampersand and searches for a fragment. Either way
/// recall silently returns nothing and the agent goes and re-reads the code the
/// note was written to save it from — the failure looks like "the brain knows
/// nothing", never like a broken URL. So the topic rides `--data-urlencode` with
/// `-G` (curl does the encoding the shell cannot), and the project name, which we
/// DO know at write time, is percent-encoded here for both the query and the
/// `/memory/<p>/<k>` path — a checkout in a directory called `my repo & co` is the
/// same bug wearing a different hat.
fn bigbrain_block(base: &str, project: &str, windows: bool) -> String {
    let curl = if windows { "curl.exe" } else { "curl" };
    let base = base_without_token(base);
    let v = if windows { "$env:BIGBRAIN_URL" } else { "$BIGBRAIN_URL" };
    let project = pct_encode(project);
    format!(
        "{BB_BEGIN}\n\
         \n\
         ## BigBrain — long-term memory ({base})\n\
         \n\
         Shared across agents and sessions; survives context clears.\n\
         \n\
         Every request needs the brain's session token. `{v}` already carries it — use\n\
         that variable as your base URL, never the bare address above. It is set in every\n\
         PixelMarch terminal; if it is empty, or a call answers `401`, this shell predates\n\
         the running brain, so open a new one.\n\
         \n\
         - RECALL before reading code: `{curl} -s -G \"{v}/recall?project={project}\" --data-urlencode \"q=<topic>\"`\n\
         - REMEMBER after anything non-obvious: `{curl} -s -X POST \"{v}/memory/{project}/<key>\" -d \"<what & where, file:line>\"`\n\
         - Full guide (endpoints, write/search syntax, shell notes): `{curl} -s {v}/info`\n\
         \n\
         {BB_END}\n"
    )
}

// ── agent lifecycle hooks (PixelMarch-owned settings file) ──────────────────
//
// A hook-capable agent CLI can be told to run a command when its session starts,
// when a prompt is accepted and when a turn ends. Pointing those at the brain's
// `/agent-event` route turns "is this pane still working?" from a guess about
// terminal output going quiet into a fact the agent itself reports.
//
// WHERE the settings live is the load-bearing decision. The obvious move — a
// managed block in the project's own settings file — cannot work: `merge_managed_block`
// is a BEGIN..END *text* splice and those files are JSON, where a marker line makes
// the whole file invalid and the CLI silently ignores every setting in it. So we
// do not write into the user's repo at all. We write ONE file we own outright,
// next to the brain's token file, and point the CLI at it with a launch flag
// (`--settings <path>` on claude). Consequences, all of them good:
//   * nothing to merge, no user text to preserve, idempotent by construction;
//   * nothing PixelMarch-managed can ever land in git, so the "no token in a
//     committed file" rule stops being something to defend and starts being a
//     property of the design;
//   * two swarms sharing a directory cannot clobber each other, because the file
//     is identical for every pane — role and project ride the ENVIRONMENT
//     (`PANE_IDENT_VARS`), and the token is read from its file at run time.
// A pane whose CLI has no hooks is passed no flag and behaves exactly as before.

/// The hook settings file PixelMarch owns: in the profile's generated-config
/// folder (`state::CONFIG_DIR`), not in the user's repo, so it is never
/// committed and never merged.
pub fn hook_settings_file() -> std::path::PathBuf {
    crate::state::config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("pixelmarch-hooks.json")
}

/// The agent hook events we install, paired with the `/agent-event` kind each maps to.
///
/// `SubagentStop` is deliberately absent: it fires when a SUBagent finishes, i.e.
/// mid-turn, so mapping it to `turn-end` would report the pane idle while the
/// agent is still working — reintroducing the exact false-idle bug these events
/// exist to kill.
/// `PreCompact` is the one that is NOT a turn boundary: it fires when the CLI is
/// about to compact its context, which on a slow endpoint is minutes of work that
/// looks exactly like a spiralling turn (busy pane, frozen screen, no tool calls)
/// and used to burn the runaway watchdog's restart budget on an agent that was
/// perfectly healthy. There is no matching "compaction finished" hook — the
/// SessionStart above fires afterwards (source `compact`), and the frontend ends
/// the window on that or on any other event from the role.
const HOOK_EVENTS: [(&str, &str); 5] = [
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt-submitted"),
    ("Stop", "turn-end"),
    ("Notification", "notification"),
    ("PreCompact", "compacting"),
];

/// How long a hook command may take before the CLI gives up on it. A hook runs
/// in the agent's critical path, so this is a loopback POST with a short leash:
/// a wedged brain must cost a pane a second, not its turn.
const HOOK_TIMEOUT_SECS: u32 = 5;

/// One hook command line. `windows` decides the curl spelling and the variable
/// syntax and is a PARAMETER, not `cfg!`, so both renderings are testable on one
/// host — same rule as `bigbrain_block`.
///
/// The token is read from `token_path` AT RUN TIME, never interpolated here: this
/// file outlives a host restart, the token does not. Role and project come from
/// the environment for the same reason plus one more — it keeps this string
/// identical for every pane.
///
/// The two environment values are handed to curl as `--data-urlencode` fields and
/// pushed onto the query string with `-G`, NEVER spliced into the URL text. They
/// cannot be percent-encoded here — their VALUES only exist in the pane's shell —
/// and a project string carries the repo folder name verbatim (swarm.ts
/// `swarmProject`), so a checkout under a directory containing a space, `&`, `?`
/// or `#` would otherwise truncate the query at the separator and file every event
/// under a project key nobody polls: working-looking, silently deaf. `-G` keeps the
/// fields in the query string (which is where `/agent-event` reads them) while
/// `-X POST` keeps the method, and curl does the encoding the shell cannot.
///
/// The ADDRESS is resolved at run time too, from `$BIGBRAIN_URL` (already set on
/// every pane, already carrying the `/t/<token>/` prefix), with the base this file
/// was written against as the fallback. This closes the one staleness this design
/// still had: `--settings <path>` is frozen into a deferred worker's boot command
/// when the swarm is created, but the brain picks a FREE port at start, so after a
/// restart onto another port a frozen command would point every hook at an address
/// nothing is listening on — no event, no error, straight back to guessing at
/// idleness. The header token is kept as well: it is what authenticates when
/// `BIGBRAIN_URL` is unset and the fallback base carries no credential.
fn hook_command(base: &str, token_path: &str, kind: &str, windows: bool) -> String {
    let base = base_without_token(base).trim_end_matches('/');
    let fields = |role: &str, project: &str| {
        format!(
            "--data-urlencode \"project={project}\" --data-urlencode \"role={role}\" -d \"event={kind}\""
        )
    };
    if windows {
        // PowerShell aliases bare `curl` to Invoke-WebRequest, which reads -s/-d as
        // its own parameters and never reaches the brain. Always curl.exe.
        format!(
            "$t=(Get-Content -Raw -ErrorAction SilentlyContinue '{token_path}').Trim(); \
             $u=$env:BIGBRAIN_URL; if (-not $u) {{ $u='{base}' }}; \
             curl.exe -s -m {HOOK_TIMEOUT_SECS} -o NUL -X POST -G \"$($u.TrimEnd('/'))/agent-event\" {} -H \"X-Brain-Token: $t\"",
            fields("$env:PIXELMARCH_ROLE", "$env:PIXELMARCH_PROJECT")
        )
    } else {
        format!(
            "t=$(tr -d '\\r\\n' < '{token_path}' 2>/dev/null); \
             u=\"${{BIGBRAIN_URL:-{base}}}\"; \
             curl -s -m {HOOK_TIMEOUT_SECS} -o /dev/null -X POST -G \"${{u%/}}/agent-event\" {} -H \"X-Brain-Token: $t\"",
            fields("$PIXELMARCH_ROLE", "$PIXELMARCH_PROJECT")
        )
    }
}

/// The whole settings file, built through `serde_json` so it is valid JSON by
/// construction rather than by careful quoting.
fn hook_settings_json(base: &str, token_path: &str, windows: bool) -> String {
    let mut hooks = serde_json::Map::new();
    for (event, kind) in HOOK_EVENTS {
        hooks.insert(
            event.to_string(),
            serde_json::json!([{
                "hooks": [{
                    "type": "command",
                    "command": hook_command(base, token_path, kind, windows),
                    "timeout": HOOK_TIMEOUT_SECS,
                }]
            }]),
        );
    }
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks }))
        .unwrap_or_else(|_| "{}".into())
}

/// Write (or refresh) the hook settings file and hand back its path. `None` when
/// there is no brain to report to or the write fails — the caller then passes no
/// flag and the pane takes today's path unchanged.
pub fn ensure_hook_settings(base: &str) -> Option<std::path::PathBuf> {
    if base.trim().is_empty() {
        return None;
    }
    let path = hook_settings_file();
    let token_path = crate::brain::token_file();
    let next = hook_settings_json(base, &token_path.to_string_lossy(), cfg!(windows));
    // Whole-file ownership makes this idempotent; the read-first is only to avoid
    // rewriting an unchanged file on every pane spawn.
    if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, &next).ok()?;
    }
    Some(path)
}

/// Absolute path of the hook settings file, refreshed against the running brain —
/// or `""` when this host cannot support hooks. The frontend appends
/// `--settings <path>` for hook-capable CLIs only, and an empty string means
/// "append nothing", i.e. exactly today's behaviour.
#[tauri::command]
pub async fn hook_settings_path() -> String {
    ensure_hook_settings(&crate::host::read_brain_url())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ── the brain's MCP server (PixelMarch-owned config file) ───────────────────
//
// Same decision as the hook settings above, for the same reasons: `.mcp.json` is
// JSON *and* tracked in git in a normal repo, so a managed block cannot go in it
// (a marker line makes the file invalid and the CLI ignores every server in it)
// and a credential must not either. We write ONE config we own outright, next to
// the token file, and pass it with `--mcp-config <path>`.
//
// `--strict-mcp-config` is deliberately NOT used: it would disable every MCP
// server the USER configured (this repo's own `.mcp.json` has a playwright entry),
// which is a working feature of theirs traded for nothing — our server loads
// alongside them either way.

/// Name the brain's MCP server carries in the config, and therefore the prefix the
/// agent sees on its tools. Referenced by the MCP briefs in `src/lib/swarm.ts`.
pub const MCP_SERVER_NAME: &str = "pixelmarch-brain";

/// The MCP config file PixelMarch owns: in the profile's generated-config
/// folder (`state::CONFIG_DIR`). Never in the user's repo, so it is never
/// committed and never merged.
pub fn mcp_config_file() -> std::path::PathBuf {
    crate::state::config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("pixelmarch-mcp.json")
}

/// The whole config file. Built through `serde_json` so it is valid JSON by
/// construction, and identical for every pane.
///
/// The URL is the LITERAL token-carrying base plus `/mcp` — deliberately not
/// `${BIGBRAIN_URL}` expansion. This file used to lean on that env var and it
/// made MCP the only brain channel with a spawn-environment dependency (briefs
/// embed the tokened URL, hooks read the token file at run time): one missed
/// `env` push and every agent lost its tool server with nothing else failing.
/// The app is a PORTABLE install — everything it needs must resolve from files
/// in the profile, not from what a shell happened to inherit. Writing the
/// credential here adds nothing to steal: `pixelmarch-brain.token` and
/// `pixelmarch-brain.url` already sit in the same directory with the same
/// secret, and this file is written 0600 the same way. Staleness is bounded by
/// construction: the token dies with the host process, and so do all the panes
/// whose CLIs read this file — a config refreshed at every pane spawn can never
/// outlive the token it names.
fn mcp_config_json(base: &str) -> String {
    let base = base.trim_end_matches('/');
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            MCP_SERVER_NAME: { "type": "http", "url": format!("{base}/mcp") }
        }
    }))
    .unwrap_or_else(|_| "{}".into())
}

/// Write (or refresh) the MCP config file and hand back its path. `None` when
/// there is no brain (empty base) or the write fails — the caller then passes no
/// flag and the pane takes today's curl path unchanged. The file carries the
/// session token, so it goes through the same symlink-refusing 0600 writer as
/// the token file itself, and the result is read back rather than assumed.
pub fn ensure_mcp_config(base: &str) -> Option<std::path::PathBuf> {
    if base.trim().is_empty() {
        return None;
    }
    let path = mcp_config_file();
    let next = mcp_config_json(base);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        crate::host::write_token_at(&path, &next);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
            return None;
        }
    }
    Some(path)
}

/// Absolute path of the MCP config file, or `""` when this host cannot write it.
/// The frontend appends `--mcp-config <path>` for MCP-capable CLIs only, and an
/// empty string means "append nothing", i.e. exactly today's behaviour.
#[tauri::command]
pub async fn mcp_config_path() -> String {
    ensure_mcp_config(&crate::host::read_brain_url())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// File-name-safe segment for the per-role MCP config below.
fn cfg_seg(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "_".into() } else { out }
}

/// Per-ROLE MCP config for a swarm pane: same shape as the shared config, but
/// carrying the pane's AGENT-token base URL (from `swarm_register_agents`), so
/// every MCP call the pane makes authenticates as its role and the brain's
/// task-lifecycle guard knows who is asking. One file per (project, role), in
/// the profile's generated-config folder (`state::CONFIG_DIR`) — this is the
/// file the swarm writes MOST of, one per role per mission, which is why they
/// no longer sit loose in the profile — 0600. `""` = could not write — the
/// caller then keeps the pane on the curl brief with its role URL in
/// `$BIGBRAIN_URL`, which authenticates identically.
#[tauri::command]
pub async fn swarm_mcp_config(url: String, project: String, role: String) -> String {
    if url.trim().is_empty() || role.trim().is_empty() {
        return String::new();
    }
    let path = crate::state::config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join(format!("pixelmarch-mcp-swarm-{}-{}.json", cfg_seg(&project), cfg_seg(&role)));
    let next = mcp_config_json(&url);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        crate::host::write_token_at(&path, &next);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
            return String::new();
        }
    }
    path.to_string_lossy().into_owned()
}

/// Delete the per-role MCP configs of one swarm project (mission end). The
/// agent tokens inside them are already revoked; this is hygiene, not security.
pub fn remove_swarm_mcp_configs(project: &str) {
    let Ok(dir) = crate::state::config_dir() else { return };
    let prefix = format!("pixelmarch-mcp-swarm-{}-", cfg_seg(project));
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".json") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Replace the BEGIN..END region in `existing` with `block`, else append it.
fn merge_managed_block(existing: &str, block: &str, begin: &str, end: &str) -> String {
    if existing.is_empty() {
        return block.to_string();
    }
    if let (Some(b), Some(e)) = (existing.find(begin), existing.find(end)) {
        if e > b {
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..b]);
            out.push_str(block.trim_end_matches('\n'));
            out.push_str(&existing[e + end.len()..]);
            return out;
        }
    }
    let mut out = existing.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(block);
    out
}

#[cfg(test)]
mod tests {
    use super::{
        base_without_token, bigbrain_block, child_env_overrides, headless_args, hook_settings_json,
        mcp_config_json, merge_managed_block, pct_encode, startup_args, strip_webview_env_with, webview_dirs,
        ChildEnv, BB_BEGIN, BB_END, HOOK_EVENTS, MCP_SERVER_NAME, PANE_IDENT_VARS, XDG_MARKER,
    };
    const B: &str = "<!--B-->";
    const E: &str = "<!--E-->";

    /// The one property that separates the headless wrapper from the PTY one: it
    /// must not leave an interactive shell behind. That shell would hold the
    /// pane's stdout open after the agent exited, so the exit would never be
    /// reported and the UI would show a live pane with a dead agent in it.
    #[test]
    fn headless_args_run_the_command_and_exit() {
        for shell in ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/fish"] {
            let out = headless_args(shell, "claude -p", vec![]);
            assert_eq!(out, vec!["-c".to_string(), "claude -p".to_string()], "{shell}");
            // ...whereas the PTY wrapper deliberately does drop to a prompt.
            assert!(
                startup_args(shell, "claude -p", vec![]).join(" ").contains("exec"),
                "{shell}: the PTY wrapper stopped being interactive"
            );
        }
        assert_eq!(
            headless_args("powershell.exe", "claude -p", vec![]),
            vec!["-Command".to_string(), "claude -p".to_string()],
        );
        assert_eq!(
            headless_args("cmd.exe", "claude -p", vec![]),
            vec!["/C".to_string(), "claude -p".to_string()],
        );
        // No -NoExit / /K anywhere: those are the Windows spellings of the same
        // "stay interactive afterwards" mistake.
        for shell in ["powershell.exe", "pwsh", "cmd.exe", "wsl.exe", "/bin/sh"] {
            let out = headless_args(shell, "claude -p", vec![]).join(" ");
            assert!(!out.contains("-NoExit") && !out.contains("/K"), "{shell}: {out}");
        }
        // An unknown program is run directly, with the command as a bare arg.
        assert_eq!(
            headless_args("/usr/bin/claude", "hello", vec!["--flag".into()]),
            vec!["--flag".to_string(), "hello".to_string()],
        );
    }

    #[test]
    fn managed_block_uses_curl_exe_on_windows_only() {
        let win = bigbrain_block("http://127.0.0.1:8734", "proj", true);
        let unix = bigbrain_block("http://127.0.0.1:8734", "proj", false);

        // PowerShell's `curl` is Invoke-WebRequest — every command line must be curl.exe.
        for line in win.lines().filter(|l| l.contains("curl")) {
            assert!(line.contains("curl.exe"), "bare curl on Windows: {line}");
        }
        assert!(!unix.contains("curl.exe"));
        assert!(unix.contains("curl -s "));

        // both carry the project + base the pane was spawned with
        for b in [&win, &unix] {
            assert!(b.contains("project=proj") && b.contains("http://127.0.0.1:8734"));
            assert!(b.starts_with(BB_BEGIN) && b.trim_end().ends_with(BB_END));
        }
    }

    /// CLAUDE.md and AGENTS.md are COMMITTED. The block must therefore contain
    /// neither the session token (a secret in git history, and rewritten on every
    /// host start, so every launch would dirty the tree) nor anything naming this
    /// machine. `$BIGBRAIN_URL` carries the credential at run time instead.
    #[test]
    fn managed_block_never_writes_the_token_into_a_committed_file() {
        let tokened = "http://127.0.0.1:8734/t/deadbeefdeadbeefdeadbeef";
        for windows in [true, false] {
            let b = bigbrain_block(tokened, "proj", windows);
            assert!(!b.contains("deadbeef"), "the session token reached a committed file:\n{b}");
            assert!(!b.contains("/t/"), "a token prefix reached a committed file:\n{b}");
            assert!(b.contains("BIGBRAIN_URL"), "no way left to authenticate:\n{b}");
        }
        // The stripper itself: prefix removed, everything else left alone.
        assert_eq!(base_without_token(tokened), "http://127.0.0.1:8734");
        assert_eq!(base_without_token("http://127.0.0.1:8734"), "http://127.0.0.1:8734");
    }

    #[test]
    fn managed_block_keeps_its_markdown_structure() {
        // heading + blank lines: without them the block renders as one paragraph.
        let b = bigbrain_block("http://x", "proj", false);
        assert!(b.contains("\n## BigBrain"), "heading missing");
        assert!(b.contains("\n\n"), "blank lines missing — renders as one paragraph");
        assert_eq!(b.lines().filter(|l| l.starts_with("- ")).count(), 3);
    }

    /// The double-quoted arguments of a shell command line, in order. Every URL in
    /// the managed block is quoted, so this is what a query check has to look at —
    /// splitting on `?` and running to the closing backtick swallows the FLAGS that
    /// follow the URL, which is how a `--data-urlencode` fix reads as a violation.
    fn quoted_args(line: &str) -> Vec<&str> {
        line.split('"').skip(1).step_by(2).collect()
    }

    #[test]
    fn managed_block_query_strings_stay_shell_and_url_safe() {
        // Agents copy these lines verbatim. A raw space in a query string breaks the
        // HTTP request line and a raw `&` truncates the value at the first ampersand —
        // silently, like the bare-`curl` bug.
        for b in [
            bigbrain_block("http://x", "proj", true),
            bigbrain_block("http://x", "proj", false),
        ] {
            for line in b.lines() {
                for arg in quoted_args(line) {
                    let Some((_, q)) = arg.split_once('?') else { continue };
                    assert!(!q.contains(' '), "raw space in query string: {line}");
                    for pair in q.split('&') {
                        assert!(
                            pair.split_once('=').is_some_and(|(k, _)| !k.is_empty()),
                            "`&` not separating a key=value pair: {line}"
                        );
                    }
                    // The values an AGENT substitutes are free text and cannot be
                    // encoded here — no placeholder may sit inside a query string.
                    assert!(!q.contains('<'), "a placeholder the agent fills with free text is spliced into the query: {line}");
                }
            }
        }
    }

    /// 3.1: a RECALL topic is normally MULTI-WORD. `?q=<topic>` breaks on the first
    /// space and truncates at the first `&`, and the agent reads that as "the brain
    /// knows nothing" — then re-reads the code the note existed to save it from.
    /// curl must do the encoding the shell cannot: `-G` + `--data-urlencode`.
    #[test]
    fn the_recall_line_lets_curl_encode_a_multi_word_topic() {
        for windows in [true, false] {
            let b = bigbrain_block("http://x", "proj", windows);
            let recall = b.lines().find(|l| l.contains("/recall")).expect("a RECALL line");
            assert!(recall.contains("--data-urlencode \"q=<topic>\""), "the topic is not encoded by curl: {recall}");
            assert!(recall.contains(" -G "), "without -G the topic becomes a body /recall never reads: {recall}");
            // …and the URL argument itself ends at the project, carrying no topic.
            let url = quoted_args(recall).first().copied().expect("a quoted URL");
            assert!(url.ends_with("/recall?project=proj"), "the topic is spliced into the URL: {url}");
        }
    }

    /// The project is the repo FOLDER NAME, taken verbatim. `my repo & co` puts a
    /// space and an `&` into both the query and the `/memory/<p>/<k>` path; we know
    /// it at write time, so it is encoded here rather than left to break at run time.
    #[test]
    fn a_project_name_needing_encoding_reaches_neither_query_nor_path_raw() {
        assert_eq!(pct_encode("my repo & co"), "my%20repo%20%26%20co");
        assert_eq!(pct_encode("ai_dashboard-2.0~x"), "ai_dashboard-2.0~x", "unreserved characters are left alone");

        let b = bigbrain_block("http://x", "my repo & co", false);
        assert!(b.contains("/recall?project=my%20repo%20%26%20co"), "{b}");
        assert!(b.contains("/memory/my%20repo%20%26%20co/<key>"), "{b}");
        for line in b.lines() {
            for arg in quoted_args(line).iter().filter(|a| a.contains("://")) {
                assert!(!arg.contains(' ') && !arg.contains('&'), "raw project name in a URL: {line}");
            }
        }
    }

    // ── agent hook settings ─────────────────────────────────────────────────

    const TOK_PATH: &str = "/portable/pixelmarch-brain.token";

    #[test]
    fn hook_settings_use_curl_exe_on_windows_only() {
        let win = hook_settings_json("http://127.0.0.1:8734", TOK_PATH, true);
        let unix = hook_settings_json("http://127.0.0.1:8734", TOK_PATH, false);

        // PowerShell's `curl` is Invoke-WebRequest — every command line must be curl.exe.
        for line in win.lines().filter(|l| l.contains("curl")) {
            assert!(line.contains("curl.exe"), "bare curl on Windows: {line}");
        }
        assert!(!unix.contains("curl.exe"));
        assert!(unix.contains("curl -s "));
        // …and each spells its own environment syntax.
        assert!(win.contains("$env:PIXELMARCH_ROLE") && !win.contains("\"$PIXELMARCH_ROLE"));
        assert!(unix.contains("$PIXELMARCH_ROLE") && !unix.contains("$env:"));
    }

    /// Same rule as the CLAUDE.md block, for the same reason: the session token is
    /// minted fresh on every host start, so a copy baked into a file that outlives
    /// one start is both a stale credential and a secret sitting somewhere it can
    /// be read. The hook reads it from the token file at RUN TIME instead.
    #[test]
    fn hook_settings_never_write_the_token_into_a_file() {
        let tokened = "http://127.0.0.1:8734/t/deadbeefdeadbeefdeadbeef";
        for windows in [true, false] {
            let s = hook_settings_json(tokened, TOK_PATH, windows);
            assert!(!s.contains("deadbeef"), "the session token reached a file on disk:\n{s}");
            assert!(!s.contains("/t/"), "a token prefix reached a file on disk:\n{s}");
            assert!(s.contains(TOK_PATH), "no way left to find the token:\n{s}");
            assert!(s.contains("X-Brain-Token"), "no way left to authenticate:\n{s}");
        }
    }

    /// The file is BYTE-IDENTICAL whoever the pane is: role and project ride the
    /// environment. Bake either one in and two swarms sharing a directory take
    /// turns overwriting the other's identity into the one file both CLIs read.
    #[test]
    fn hook_settings_are_identical_for_every_pane() {
        let a = hook_settings_json("http://127.0.0.1:8734", TOK_PATH, false);
        let b = hook_settings_json("http://127.0.0.1:8734", TOK_PATH, false);
        assert_eq!(a, b, "the settings file must not vary between panes");
        for var in PANE_IDENT_VARS {
            assert!(a.contains(var), "{var} is not read from the environment:\n{a}");
        }
        // A pane's actual role must appear nowhere: the file has no idea who reads it.
        assert!(!a.contains("builder-1") && !a.contains("coordinator"), "{a}");
    }

    /// It is a JSON settings file, so it has to BE valid JSON — the failure mode
    /// otherwise is silent: the CLI ignores the whole file and every pane quietly
    /// falls back to guessing at idleness.
    #[test]
    fn hook_settings_are_valid_json_with_one_command_per_lifecycle_event() {
        for windows in [true, false] {
            let v: serde_json::Value =
                serde_json::from_str(&hook_settings_json("http://x", TOK_PATH, windows)).expect("valid JSON");
            let hooks = v["hooks"].as_object().expect("a hooks object");
            assert_eq!(hooks.len(), HOOK_EVENTS.len());
            for (event, kind) in HOOK_EVENTS {
                let cmd = hooks[event][0]["hooks"][0]["command"].as_str().expect(event);
                assert!(cmd.contains(&format!("event={kind}")), "{event} does not report {kind}: {cmd}");
                assert_eq!(hooks[event][0]["hooks"][0]["type"], "command");
                assert!(hooks[event][0]["hooks"][0]["timeout"].as_u64().unwrap() > 0);
            }
            // SubagentStop fires MID-turn — mapping it to turn-end reports a pane
            // idle while it is still working, the exact bug these events kill.
            assert!(hooks.get("SubagentStop").is_none(), "SubagentStop must not be installed");
            // PreCompact is what tells the host "this pane is compacting, not
            // wedged" — without it the runaway watchdog aborts a healthy agent
            // mid-compaction and spends one of its two restarts doing it.
            assert!(
                hooks["PreCompact"][0]["hooks"][0]["command"].as_str().unwrap().contains("event=compacting"),
                "PreCompact must report the compacting kind"
            );
        }
    }

    /// The values that reach the query string come from the pane's ENVIRONMENT, so
    /// they cannot be encoded when this string is built — and `swarmProject()`
    /// prefixes the repo folder name verbatim, so a checkout under a directory with
    /// a space or an `&` in its name produces exactly the shape that truncates a
    /// query at the separator and files every event under a project nobody polls.
    /// The only portable place left to encode is curl itself: `--data-urlencode`
    /// for both environment values, `-G` to put them in the query string where
    /// `/agent-event` reads them, `-X POST` to keep the method.
    #[test]
    fn hook_command_query_strings_stay_shell_and_url_safe() {
        for windows in [true, false] {
            let v: serde_json::Value =
                serde_json::from_str(&hook_settings_json("http://x", TOK_PATH, windows)).unwrap();
            for (event, kind) in HOOK_EVENTS {
                let cmd = v["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap();
                // No interpolation into the URL text: the URL ends at the route, and
                // the address itself is resolved from the environment at run time
                // (with the base this file was written against as the fallback).
                assert!(cmd.contains("/agent-event\""), "URL is not a bare route: {cmd}");
                assert!(!cmd.contains("/agent-event?"), "a value was spliced into the query: {cmd}");
                assert!(cmd.contains("BIGBRAIN_URL"), "the address is frozen at write time: {cmd}");
                assert!(cmd.contains("http://x"), "no fallback address when BIGBRAIN_URL is unset: {cmd}");
                assert!(cmd.contains(" -G "), "without -G the fields become a body the route never reads: {cmd}");
                assert!(cmd.contains("-X POST"), "the route only answers POST: {cmd}");
                for var in PANE_IDENT_VARS {
                    let field = if var == "PIXELMARCH_ROLE" { "role" } else { "project" };
                    assert!(
                        cmd.contains(&format!("--data-urlencode \"{field}=")),
                        "{field} is not encoded by curl: {cmd}"
                    );
                    assert!(cmd.contains(var), "{var} is not read from the environment: {cmd}");
                }
                // The one value we DO control is a fixed literal, so it needs no encoding.
                assert!(cmd.contains(&format!("-d \"event={kind}\"")), "{event} does not report {kind}: {cmd}");
            }
        }
    }

    // ── brain MCP config ────────────────────────────────────────────────────

    /// The config is read by the CLI, so it has to BE valid JSON, and it has to
    /// name a server the briefs can point at. One entry, ours; the user's own
    /// servers live in their own config and are not touched.
    #[test]
    fn mcp_config_is_valid_json_naming_one_http_server() {
        let base = "http://127.0.0.1:8734/t/sometoken";
        let v: serde_json::Value = serde_json::from_str(&mcp_config_json(base)).expect("valid JSON");
        let servers = v["mcpServers"].as_object().expect("an mcpServers object");
        assert_eq!(servers.len(), 1, "we own exactly one entry: {servers:?}");
        let s = &servers[MCP_SERVER_NAME];
        assert_eq!(s["type"], "http");
        assert_eq!(s["url"], "http://127.0.0.1:8734/t/sometoken/mcp");
        // A trailing slash on the base must not produce `//mcp`.
        let v: serde_json::Value =
            serde_json::from_str(&mcp_config_json("http://x/t/tok/")).expect("valid JSON");
        assert_eq!(v["mcpServers"][MCP_SERVER_NAME]["url"], "http://x/t/tok/mcp");
    }

    /// The config carries the LITERAL token-carrying URL — the portable rule: an
    /// agent CLI must find everything in files in the profile, never in a var
    /// its spawn environment may or may not have. (`${BIGBRAIN_URL}` expansion is
    /// exactly how every swarm lost its tool server when one env push was gated
    /// wrong.) The secret adds nothing new on disk: the token file sits in the
    /// same directory, and this file goes through the same 0600 writer.
    #[test]
    fn mcp_config_bakes_the_tokened_url_and_is_identical_for_every_pane() {
        let base = "http://127.0.0.1:8734/t/sometoken";
        let s = mcp_config_json(base);
        assert!(s.contains("http://127.0.0.1:8734/t/sometoken/mcp"), "no way left to authenticate:\n{s}");
        assert!(!s.contains("${"), "an env placeholder survived — spawn-env dependency is back:\n{s}");
        // Byte-identical whoever the pane is — no role, no project, nothing per-swarm.
        assert_eq!(s, mcp_config_json(base));
        for var in PANE_IDENT_VARS {
            assert!(!s.contains(var), "{var} has no business in a shared config:\n{s}");
        }
    }

    /// Pane identity is forwarded even on a host we never redirected — the early
    /// return in `child_env_overrides` is about the XDG stash, not about roles.
    #[test]
    fn pane_identity_is_forwarded_with_or_without_the_xdg_redirect() {
        let lookup = |map: &[(&str, &str)]| {
            let owned: Vec<(String, String)> =
                map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            move |k: &str| owned.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
        };
        let ident = [("PIXELMARCH_ROLE", "builder-1"), ("PIXELMARCH_PROJECT", "proj")];

        for extra in [Vec::new(), vec![(XDG_MARKER, "1")]] {
            let mut map: Vec<(&str, &str)> = ident.to_vec();
            map.extend(extra.iter().copied());
            let ov = child_env_overrides(lookup(&map));
            assert_eq!(
                ov.iter().find(|(k, _)| k == "PIXELMARCH_ROLE").and_then(|(_, v)| v.clone()),
                Some("builder-1".to_string()),
                "role lost with XDG_MARKER {}",
                extra.is_empty()
            );
            assert_eq!(
                ov.iter().find(|(k, _)| k == "PIXELMARCH_PROJECT").and_then(|(_, v)| v.clone()),
                Some("proj".to_string())
            );
        }
        // A pane with no identity still stages nothing — non-swarm panes are untouched.
        assert!(child_env_overrides(lookup(&[])).is_empty());
    }

    /// The three cases the child env builder has to get right, plus the
    /// "we never redirected" case where it must do nothing at all.
    #[test]
    fn child_env_strips_or_restores_the_webview_vars() {
        let lookup = |map: &[(&str, &str)]| {
            let owned: Vec<(String, String)> =
                map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            move |k: &str| {
                owned.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone())
            }
        };
        let of = |ov: &[(String, Option<String>)], name: &str| {
            ov.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
        };

        // 1. never redirected (read-only install): no overrides at all.
        assert!(child_env_overrides(lookup(&[("XDG_DATA_HOME", "/home/u/.local/share")])).is_empty());

        // 2. originally UNSET: the child must have it unset, not empty.
        let ov = child_env_overrides(lookup(&[
            (XDG_MARKER, "1"),
            ("XDG_DATA_HOME", "/app/webview/data"),
            ("XDG_CACHE_HOME", "/app/webview/cache"),
        ]));
        assert_eq!(of(&ov, "XDG_DATA_HOME"), Some(None));
        assert_eq!(of(&ov, "XDG_CACHE_HOME"), Some(None));

        // 3. originally SET: restored to the exact original value.
        let ov = child_env_overrides(lookup(&[
            (XDG_MARKER, "1"),
            ("XDG_DATA_HOME", "/app/webview/data"),
            ("XDG_CACHE_HOME", "/app/webview/cache"),
            ("PIXELMARCH_ORIG_XDG_DATA_HOME", "/home/u/.local/share"),
            ("PIXELMARCH_ORIG_XDG_CACHE_HOME", "/home/u/.cache"),
        ]));
        assert_eq!(
            of(&ov, "XDG_DATA_HOME"),
            Some(Some("/home/u/.local/share".to_string()))
        );
        assert_eq!(of(&ov, "XDG_CACHE_HOME"), Some(Some("/home/u/.cache".to_string())));

        // 4. our own bookkeeping never reaches the child.
        for k in [XDG_MARKER, "PIXELMARCH_ORIG_XDG_DATA_HOME", "PIXELMARCH_ORIG_XDG_CACHE_HOME"] {
            assert_eq!(of(&ov, k), Some(None), "{k} must be unset in the child");
        }
    }

    /// What a spawn site actually stages on its `Command`. Same three cases as
    /// above, but through the helper every GUI-side spawn now calls — a child
    /// that inherits our XDG_DATA_HOME loses the user's file associations
    /// (xdg-open) or writes its state into the portable exe directory (shells).
    #[test]
    fn strip_webview_env_stages_the_right_edits() {
        #[derive(Default)]
        struct Rec(Vec<(String, Option<String>)>);
        impl ChildEnv for Rec {
            fn set_child_var(&mut self, key: &str, val: &str) {
                self.0.push((key.to_string(), Some(val.to_string())));
            }
            fn unset_child_var(&mut self, key: &str) {
                self.0.push((key.to_string(), None));
            }
        }
        let lookup = |map: &[(&str, &str)]| {
            let owned: Vec<(String, String)> =
                map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            move |k: &str| owned.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone())
        };
        let staged = |map: &[(&str, &str)]| {
            let mut rec = Rec::default();
            strip_webview_env_with(&mut rec, lookup(map));
            rec.0
        };
        let of = |ov: &[(String, Option<String>)], name: &str| {
            ov.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
        };

        // 1. never redirected: the command is left completely alone.
        assert!(staged(&[("XDG_DATA_HOME", "/home/u/.local/share")]).is_empty());

        // 2. originally UNSET: env_remove, never an empty value.
        let ov = staged(&[
            (XDG_MARKER, "1"),
            ("XDG_DATA_HOME", "/app/webview/data"),
            ("XDG_CACHE_HOME", "/app/webview/cache"),
        ]);
        assert_eq!(of(&ov, "XDG_DATA_HOME"), Some(None));
        assert_eq!(of(&ov, "XDG_CACHE_HOME"), Some(None));

        // 3. originally SET: restored to the user's real directories.
        let ov = staged(&[
            (XDG_MARKER, "1"),
            ("XDG_DATA_HOME", "/app/webview/data"),
            ("XDG_CACHE_HOME", "/app/webview/cache"),
            ("PIXELMARCH_ORIG_XDG_DATA_HOME", "/home/u/.local/share"),
            ("PIXELMARCH_ORIG_XDG_CACHE_HOME", "/home/u/.cache"),
        ]);
        assert_eq!(of(&ov, "XDG_DATA_HOME"), Some(Some("/home/u/.local/share".to_string())));
        assert_eq!(of(&ov, "XDG_CACHE_HOME"), Some(Some("/home/u/.cache".to_string())));
        // and our bookkeeping is stripped, not forwarded
        for k in [XDG_MARKER, "PIXELMARCH_ORIG_XDG_DATA_HOME", "PIXELMARCH_ORIG_XDG_CACHE_HOME"] {
            assert_eq!(of(&ov, k), Some(None), "{k} must be unset in the child");
        }
    }

    #[test]
    fn webview_dirs_live_next_to_the_exe() {
        let base = crate::state::state_dir().expect("state_dir");
        let (data, cache) = webview_dirs(&base);
        assert!(data.starts_with(&base) && cache.starts_with(&base));
        assert_ne!(data, cache);
        // The whole point: nothing under $HOME.
        if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
            if !base.starts_with(&home) {
                assert!(!data.starts_with(&home) && !cache.starts_with(&home));
            }
        }
    }

    /// A read-only install must still start: the redirect fails, and it must
    /// fail without leaving a marker behind (a marker with no redirect would
    /// make every child strip XDG vars we never set).
    #[cfg(unix)]
    #[test]
    fn a_read_only_exe_dir_fails_without_touching_the_environment() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join("pixelmarch-readonly-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o555)).unwrap();

        let res = super::redirect_webview_state(&base);

        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&base);

        // root ignores the permission bits; only assert when it actually failed.
        if res.is_err() {
            assert!(std::env::var_os(XDG_MARKER).is_none());
        }
    }

    #[test]
    fn merge_keeps_user_text_and_is_idempotent() {
        let user = "# My notes\n\nkeep me\n";
        let block = format!("{B}\nv1\n{E}\n");
        let once = merge_managed_block(user, &block, B, E);
        assert!(once.contains("keep me") && once.contains("v1"));

        // re-applying the same block changes nothing
        assert_eq!(once, merge_managed_block(&once, &block, B, E));

        // a new block replaces in place — no duplicate markers, old body gone
        let updated = merge_managed_block(&once, &format!("{B}\nv2\n{E}\n"), B, E);
        assert!(updated.contains("v2") && !updated.contains("v1"));
        assert_eq!(updated.matches(B).count(), 1);
        assert!(updated.contains("keep me"));
    }
}
