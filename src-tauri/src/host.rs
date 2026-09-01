//! Detached PTY session host — the piece that lets terminals survive a GUI
//! restart / in-place update.
//!
//! The SAME exe runs as this host when launched with `--host` (keeps the
//! single-portable-exe promise). It owns every PTY plus a per-session output
//! ring buffer, and serves one GUI client at a time over localhost TCP. When
//! the GUI quits it just disconnects; the host and its shells keep running, so
//! the next GUI launch reattaches by pane id and replays the ring to repaint
//! scrollback.
//!
//! ponytail: one client at a time (the GUI is single-instance) and a raw-byte
//! ring replay instead of tmux-style screen reconstruction — upgrade to a real
//! screen model only if replay artifacts on reattach actually bother anyone.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::pty::{
    default_shell, ensure_bigbrain_files, headless_args, kill_tree, lock, new_process_group,
    startup_args, SharedChild, SpawnMode, SpawnOpts,
};

/// Per-pane retained output. On reattach the whole ring is replayed so the
/// terminal repaints ~where it was. 256 KiB ≈ generous scrollback per pane.
const RING_CAP: usize = 256 * 1024;
/// Coalesce PTY output over this window before framing one message (a fast
/// producer like `yes` must not flood the socket or the Tauri bridge). Only a
/// stream already judged hot waits it out — see [`coalesce_loop`], which flushes
/// a quiet pipe immediately so a typed character's echo is not held in a timer.
const COALESCE: Duration = Duration::from_millis(16);
const MAX_BATCH: usize = 128 * 1024;
/// A single batch this big is a burst by itself, not someone typing.
const HOT_BYTES: usize = 8 * 1024;
/// Flushes closer together than this mean output is still arriving. A producer
/// paced in the band just outside it (a chunk every ~7-15 ms, e.g. a slow
/// line-at-a-time logger) never earns a strike and so emits one frame per read.
/// That is deliberate: the band is bounded by the producer's own rate (~140
/// frames/s worst case, where the fixed window capped it at ~62), and paying it
/// is what keeps a lone echoed keystroke out of the timer.
const HOT_GAP: Duration = Duration::from_millis(6);
/// Consecutive busy flushes before the coalescing window switches on. Two, so a
/// real stream coalesces from its second batch and a lone echo never does.
const HOT_STRIKES: u32 = 2;
/// How long hotness lasts after the last busy flush (renewed by each one).
/// Consequence to know: for this long after output stops the window is still
/// armed, so the first keystroke typed right after a flood still costs up to
/// [`COALESCE`]. Inherent to hysteresis and bounded by this constant — the
/// alternative (disarming instantly) makes a stuttering producer flap between
/// hot and quiet and re-flood the bridge.
const HOT_LINGER: Duration = Duration::from_millis(150);
/// Ports the host will try to bind, in order. First free one wins.
const PORT_RANGE: std::ops::RangeInclusive<u16> = 8760..=8780;
/// How long a fresh connection has to present its token before it is dropped.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// Refuse absurd frame lengths instead of allocating them. The largest thing a
/// client legitimately sends is a paste, far under this.
const MAX_FRAME: usize = 8 * 1024 * 1024;

// ── wire protocol: 4-byte BE length prefix + JSON ───────────────────────────

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ClientMsg {
    /// Must be the FIRST frame on every connection. Anything else — or a wrong
    /// token — and the socket is closed before it can attach or run a command.
    Auth { token: String },
    /// Attach if a session with this id exists (replay its ring), else spawn it.
    Open { id: String, opts: SpawnOpts },
    Write { id: String, data: String },
    Resize { id: String, rows: u16, cols: u16 },
    Close { id: String },
    /// Flow control. When the GUI's render queue for a pane backs up it asks the
    /// host to stop reading that PTY; the kernel's PTY buffer then fills and the
    /// child process blocks on write() — real end-to-end backpressure, so a
    /// runaway producer is throttled to what the GUI can actually draw. `Resume`
    /// lifts it once the queue drains. Unknown to pre-0.1.6 hosts, which ignore
    /// the frame (the serve loop skips undeserializable messages) — the GUI then
    /// just falls back to dropping overflow in its own queue.
    Pause { id: String },
    Resume { id: String },
    /// Kill every session and exit the host process ("Close all & quit").
    Shutdown,
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ServerMsg {
    Data { id: String, data: String },
    Exit { id: String, code: Option<i32> },
}

pub fn write_frame(w: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    w.write_all(&(bytes.len() as u32).to_be_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}

pub fn read_frame(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

/// File in the profile holding the host's chosen port.
pub fn port_file() -> PathBuf {
    crate::state::state_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pixelmarch-host.port")
}

/// File in the profile holding the host's own process id.
///
/// The self-updater needs it: replacing the exe means stopping the host that is
/// running from the old one, and "did it actually stop?" cannot be answered from
/// the port alone (a wedged host still holds the socket, and a freed port could
/// in principle be taken by anything). With the pid it can wait for the process
/// to really be gone and, failing that, kill it — see `update::stop_host`.
pub fn pid_file() -> PathBuf {
    crate::state::state_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pixelmarch-host.pid")
}

/// File in the profile holding the session token every client must present.
///
/// The port is loopback-only but that is not a permission boundary: any process
/// running as this user could connect and type into a pane. Knowing the token
/// requires reading this file, so on unix it is written 0600. Windows has no
/// cheap equivalent for a portable folder — there the file inherits the
/// directory's ACL, which still keeps out other user accounts.
pub fn token_file() -> PathBuf {
    crate::state::state_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pixelmarch-host.token")
}

/// Fresh per host start: two v4 UUIDs (OS randomness) = 244 bits, hex, no deps
/// beyond the `uuid` we already pull in.
pub(crate) fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Publish the token for the GUI. Written (and locked down) BEFORE the port file
/// exists, so any host a client can find has already published its token.
/// Created 0600 AT open time, not chmod-ed to 0600 afterwards. `fs::write` creates
/// 0666-and-umask — usually 0644 — so a write-then-chmod leaves the token
/// world-readable for the length of one syscall, and anything polling the file only
/// has to win that race once to own every terminal for the rest of the session.
/// `OpenOptions::mode` closes the window: the file never exists readable.
///
/// The old file is removed first for the same reason. `fs::write` to an EXISTING path
/// reuses it and leaves its mode alone, so a token file that was somehow left
/// world-readable (an older build, a restore, a copied portable folder) would keep
/// those permissions and quietly get a fresh secret written into it.
fn write_token(token: &str) {
    write_token_at(&token_file(), token);
}

/// The write itself, against an explicit path so the permissions it produces are
/// testable without touching the real portable folder.
///
/// `create_new`, not `create`: remove-then-create leaves a window in which anything
/// that can write the exe directory may plant a SYMLINK at the path, and a plain
/// `create` would follow it — writing the session secret wherever the link points,
/// with 0600 on a file the attacker already owns. `O_CREAT|O_EXCL` refuses to follow
/// a link (or to reuse an existing file at all), so the loser of that race gets
/// `AlreadyExists` rather than a redirected write. The retry is bounded because a
/// path that keeps reappearing is an attacker winning repeatedly, not a transient —
/// at that point publishing no token is the correct outcome: clients then find no
/// token and the host is unusable rather than compromised.
pub(crate) fn write_token_at(path: &Path, token: &str) {
    for _ in 0..TOKEN_WRITE_TRIES {
        // Removes a regular file, a stale token, and a planted symlink alike
        // (`remove_file` unlinks the link itself, never its target).
        let _ = std::fs::remove_file(path);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        // 0600 AT open time, not chmod-ed afterwards: `fs::write` creates
        // 0666-and-umask — usually 0644 — so a write-then-chmod leaves the token
        // world-readable for the length of one syscall, and anything polling the
        // file only has to win that race once to own every terminal for the
        // session. Windows has no cheap portable-folder equivalent: the file
        // inherits the directory's ACL, which still keeps out other accounts.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(path) {
            Ok(mut f) => {
                let _ = f.write_all(token.as_bytes());
                return;
            }
            // Something re-created the path between the unlink and the open. Try again.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            // A real failure (read-only install, missing directory): retrying cannot help.
            Err(_) => return,
        }
    }
}

/// Bounded so a path an attacker keeps re-planting ends in "no token published"
/// instead of an unbounded loop.
const TOKEN_WRITE_TRIES: u32 = 5;

/// GUI-side: the token the running host published (empty if none).
pub fn read_token() -> String {
    std::fs::read_to_string(token_file())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Length-independent compare, so a wrong guess leaks nothing through timing.
fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// File in the profile holding BigBrain's base URL. The host owns BigBrain (so
/// it survives GUI restarts); the GUI reads the URL from here for its UI snippet.
pub fn brain_url_file() -> PathBuf {
    crate::state::state_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pixelmarch-brain.url")
}

/// Delete the pre-rename `termmarch-host.port` / `termmarch-brain.url` left in
/// the portable folder by an older build — nothing reads them any more.
fn remove_legacy_files() {
    let Ok(dir) = crate::state::state_dir() else { return };
    for name in ["termmarch-host.port", "termmarch-brain.url"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// GUI-side: the BigBrain URL the running host published (empty if none).
pub fn read_brain_url() -> String {
    std::fs::read_to_string(brain_url_file())
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ── session manager ─────────────────────────────────────────────────────────

struct Session {
    /// Behind its OWN lock, not the `sessions` map's. A PTY master write lands in
    /// the tty buffer and returns, but a PIPE write to a child that has stopped
    /// draining its stdin blocks once the buffer fills (64 KiB on Linux) — and a
    /// blocking write while holding the global map lock would freeze every other
    /// pane's write, resize, spawn and close behind it, INCLUDING the close()
    /// that would kill the offender. See `Host::write`.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// `None` for a piped (headless) pane: there is no terminal behind it, so
    /// there is nothing to resize and `Resize` is a no-op rather than an error.
    master: Option<Box<dyn MasterPty + Send>>,
    child: SharedChild,
    pid: Option<u32>,
    ring: Arc<Mutex<VecDeque<u8>>>,
    /// Flow-control gate for the reader thread. `true` = reader is parked and the
    /// PTY goes unread, so the child blocks once the kernel buffer fills. The
    /// reader waits on the condvar; `set_paused` / `close` / child-exit notify it.
    paused: Arc<(Mutex<bool>, Condvar)>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

struct Host {
    sessions: Sessions,
    /// Frames destined for the newest-connected client, tagged with its accept
    /// generation so a stale client's teardown can never clobber a newer one
    /// (None = detached).
    out: Arc<Mutex<Option<(u64, Sender<Vec<u8>>)>>>,
    /// BigBrain base URL, owned by the host (empty if BigBrain didn't start).
    brain_url: String,
    /// Secret every client must present as its first frame.
    token: String,
}

impl Host {
    fn new(brain_url: String, token: String) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            out: Arc::new(Mutex::new(None)),
            brain_url,
            token,
        }
    }

    /// Route output to client `gen` — unless a newer client already claimed it.
    fn attach_client(&self, gen: u64, tx: Sender<Vec<u8>>) {
        let mut out = lock(&self.out);
        if out.as_ref().map_or(true, |(g, _)| gen > *g) {
            *out = Some((gen, tx));
        }
    }

    /// Detach client `gen` — a no-op if a newer client has since attached.
    fn detach_client(&self, gen: u64) {
        let mut out = lock(&self.out);
        if out.as_ref().map_or(false, |(g, _)| *g == gen) {
            *out = None;
        }
    }

    /// Push one server message to the client if attached (dropped if detached).
    fn send(&self, msg: &ServerMsg) {
        if let Some((_, tx)) = lock(&self.out).as_ref() {
            if let Ok(bytes) = serde_json::to_vec(msg) {
                let _ = tx.send(bytes);
            }
        }
    }

    /// Attach to an existing session (replay its ring) or spawn a new one.
    fn open(&self, id: String, opts: SpawnOpts) -> Result<(), String> {
        if let Some(s) = lock(&self.sessions).get(&id) {
            let ring: Vec<u8> = lock(&s.ring).iter().copied().collect();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&ring);
            self.send(&ServerMsg::Data { id, data: b64 });
            return Ok(());
        }
        self.spawn(id, opts)
    }

    /// Launch a pane in the mode it asked for. Absent mode = `Pty` = exactly
    /// what every pane has always done.
    fn spawn(&self, id: String, opts: SpawnOpts) -> Result<(), String> {
        match opts.mode.unwrap_or_default() {
            SpawnMode::Pty => self.spawn_pty(id, opts),
            SpawnMode::Piped => self.spawn_piped(id, opts),
        }
    }

    fn spawn_pty(&self, id: String, opts: SpawnOpts) -> Result<(), String> {
        let brain_url = self.brain_url.clone();
        let pair = native_pty_system()
            .openpty(PtySize { rows: opts.rows, cols: opts.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let shell = opts.shell.clone().unwrap_or_else(default_shell);
        let base_args = opts.args.clone().unwrap_or_default();
        let args = match opts.startup_command.clone().filter(|s| !s.is_empty()) {
            Some(sc) => startup_args(&shell, &sc, base_args),
            None => base_args,
        };
        let mut cmd = CommandBuilder::new(&shell);
        for arg in args {
            cmd.arg(arg);
        }
        let cwd_opt = opts.cwd.clone().filter(|d| !d.is_empty());
        if let Some(dir) = &cwd_opt {
            cmd.cwd(dir);
        }
        // portable-pty copies our own environment, and a GUI-launched app has no
        // TERM — so agents and CLIs saw "no terminal" and dropped all colour.
        // The frontend is xterm.js, so advertise what it actually renders rather
        // than passing through whatever TERM the launching shell happened to use.
        //
        // Set BEFORE `pane_env`, which carries the caller's own `env` map, so an
        // explicit TERM from the caller still wins — the ordering the inline
        // version had. Deliberately NOT in `pane_env`: TERM is a property of
        // having a terminal, and a piped child that believed it had one would
        // write colour escapes into a line-delimited JSON stream.
        #[cfg(unix)]
        {
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
        }
        for (k, v) in pane_env(&opts, &brain_url) {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let pid = child.process_id();
        drop(pair.slave); // so the master reader sees EOF when the child exits
        let child: SharedChild = Arc::new(Mutex::new(child));
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        self.attach_session(id, writer, reader, Some(pair.master), child, pid, None);
        Ok(())
    }

    /// Headless pane: the CLI's own stdin/stdout, carrying line-delimited JSON,
    /// instead of a terminal. Everything downstream — the ring, the adaptive
    /// coalescer, `ServerMsg::Data`, `ServerMsg::Exit`, flow control — is the
    /// SAME pipeline the PTY path uses. A piped child is just a different source
    /// of bytes for it, which is why the frontend needs no second event channel.
    fn spawn_piped(&self, id: String, opts: SpawnOpts) -> Result<(), String> {
        use std::process::Stdio;

        let brain_url = self.brain_url.clone();
        let shell = opts.shell.clone().unwrap_or_else(default_shell);
        let base_args = opts.args.clone().unwrap_or_default();
        // `headless_args`, not `startup_args`: the PTY variant drops to an
        // interactive prompt afterwards, which would hold stdout open forever
        // after the agent exits and the pane would never report its exit.
        let args = match opts.startup_command.clone().filter(|s| !s.is_empty()) {
            Some(sc) => headless_args(&shell, &sc, base_args),
            None => base_args,
        };
        let mut cmd = std::process::Command::new(&shell);
        cmd.args(&args);
        if let Some(dir) = opts.cwd.clone().filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        for (k, v) in pane_env(&opts, &brain_url) {
            cmd.env(k, v);
        }
        // No-op inside the host, which already restored its own environment via
        // `restore_env_from_stash` — but this is the one spawn site that could
        // also be driven from the GUI process, where the redirect is live.
        crate::pty::strip_webview_env(&mut cmd);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Makes `kill_tree`'s `pgid == pid` assumption true for a child that
        // portable-pty did not `setsid` for us. See `new_process_group`.
        new_process_group(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let pid = Some(child.id());
        let stdin = child.stdin.take().ok_or("piped child has no stdin")?;
        let stdout = child.stdout.take().ok_or("piped child has no stdout")?;
        let stderr = child.stderr.take();
        // portable-pty implements its own `Child`/`ChildKiller` for
        // `std::process::Child`, so this needs no adapter and `kill_tree` takes
        // it as-is.
        let child: SharedChild = Arc::new(Mutex::new(Box::new(child)));
        self.attach_session(
            id,
            Box::new(stdin),
            Box::new(stdout),
            None,
            child,
            pid,
            stderr.map(|e| Box::new(e) as Box<dyn Read + Send>),
        );
        Ok(())
    }

    /// Everything a spawned pane needs once its streams exist, shared by both
    /// modes so they cannot drift: reader thread (with the flow-control gate),
    /// coalescer thread, waiter thread, and the session record itself.
    ///
    /// `diag` is a second, low-volume stream (a piped child's stderr) whose
    /// lines are wrapped as JSON objects before joining the main one — see
    /// `diag_loop`. `None` for a PTY, which has only the one stream.
    #[allow(clippy::too_many_arguments)]
    fn attach_session(
        &self,
        id: String,
        writer: Box<dyn Write + Send>,
        reader: Box<dyn Read + Send>,
        master: Option<Box<dyn MasterPty + Send>>,
        child: SharedChild,
        pid: Option<u32>,
        diag: Option<Box<dyn Read + Send>>,
    ) {
        let ring = Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP)));
        let paused: Arc<(Mutex<bool>, Condvar)> = Arc::new((Mutex::new(false), Condvar::new()));

        // Reader thread: blocking reads -> channel, parking while flow-controlled.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        {
            let mut reader = reader;
            let paused = paused.clone();
            let tx = tx.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    // Park while paused: the PTY master goes unread, the kernel
                    // buffer fills, and the child blocks on its next write. A
                    // read already in flight when the pause lands completes one
                    // more buffer first — bounded and fine. close()/child-exit
                    // clear the flag so a parked reader unparks, sees EOF, exits.
                    {
                        let (m, cv) = &*paused;
                        let mut p = m.lock().unwrap();
                        while *p {
                            p = cv.wait(p).unwrap();
                        }
                    }
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }

        // A piped child's stderr, folded into the same stream as JSON objects.
        // The `tx` this consumes is the LAST clone when it exists; when it does
        // not, dropping it here is what lets `coalesce_loop` finish at EOF.
        match diag {
            Some(diag) => {
                thread::spawn(move || diag_loop(diag, tx));
            }
            None => drop(tx),
        }

        // Coalescer thread: ~16ms window -> append ring + push one Data frame.
        {
            let out = self.out.clone();
            let ring = ring.clone();
            let id = id.clone();
            thread::spawn(move || {
                let b64 = base64::engine::general_purpose::STANDARD;
                coalesce_loop(rx, |batch| {
                    {
                        let mut r = lock(&ring);
                        r.extend(batch.iter().copied());
                        while r.len() > RING_CAP {
                            r.pop_front();
                        }
                    }
                    if let Some((_, tx)) = lock(&out).as_ref() {
                        let msg = ServerMsg::Data { id: id.clone(), data: b64.encode(batch) };
                        if let Ok(bytes) = serde_json::to_vec(&msg) {
                            let _ = tx.send(bytes);
                        }
                    }
                });
            });
        }

        // Waiter thread: emit the real exit code, then drop the session so a
        // later reattach respawns fresh instead of attaching to a dead shell.
        {
            let out = self.out.clone();
            let sessions = self.sessions.clone();
            let child = Arc::clone(&child);
            let id = id.clone();
            let paused = paused.clone();
            thread::spawn(move || {
                let code = loop {
                    match lock(&child).try_wait() {
                        Ok(Some(s)) => break Some(s.exit_code() as i32),
                        Ok(None) => thread::sleep(Duration::from_millis(200)),
                        Err(_) => break None,
                    }
                };
                // Unpark a reader parked on flow control so it sees EOF and
                // exits instead of leaking a thread on a dead session.
                {
                    let (m, cv) = &*paused;
                    *m.lock().unwrap() = false;
                    cv.notify_all();
                }
                lock(&sessions).remove(&id);
                if let Some((_, tx)) = lock(&out).as_ref() {
                    let msg = ServerMsg::Exit { id, code };
                    if let Ok(bytes) = serde_json::to_vec(&msg) {
                        let _ = tx.send(bytes);
                    }
                }
            });
        }

        lock(&self.sessions)
            .insert(id, Session { writer: Arc::new(Mutex::new(writer)), master, child, pid, ring, paused });
    }

    /// Flip a session's flow-control gate. Pausing parks the reader (child blocks
    /// once the PTY buffer fills); resuming wakes it. No-op for an unknown id.
    fn set_paused(&self, id: &str, paused: bool) {
        if let Some(s) = lock(&self.sessions).get(id) {
            let (m, cv) = &*s.paused;
            *m.lock().unwrap() = paused;
            cv.notify_all();
        }
    }

    /// The `sessions` lock is held only long enough to CLONE the target pane's
    /// writer handle; the blocking part happens under that pane's own lock.
    ///
    /// This is not a micro-optimisation, it is a deadlock fix. The old shape held
    /// the global map lock across `write_all` + `flush`, justified by "a PTY
    /// master write lands in the tty buffer and does not block on a child that
    /// has stopped reading". That is true of a pty master and FALSE of a pipe:
    /// a headless pane's stdin is a pipe, so a child that stops draining it
    /// blocks our `write_all` once ~64 KiB is in flight (Linux). Under the old
    /// shape that one stuck pane froze every other pane's write, resize, spawn
    /// and close — including the `close()` that would have killed it. Now it
    /// stalls only itself.
    /// (`concurrent_pane_writes_do_not_contend_measurably` still measures the
    /// uncontended cost: 12 panes writing concurrently, p50 ~1 µs.)
    fn write(&self, id: &str, data: &[u8]) {
        let writer = lock(&self.sessions).get(id).map(|s| Arc::clone(&s.writer));
        if let Some(writer) = writer {
            let mut w = lock(&writer);
            let _ = w.write_all(data);
            let _ = w.flush();
        }
    }

    /// No-op for a headless pane (no master, nothing with a window size) and for
    /// an unknown id.
    fn resize(&self, id: &str, rows: u16, cols: u16) {
        if let Some(s) = lock(&self.sessions).get(id) {
            if let Some(master) = &s.master {
                let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            }
        }
    }

    fn close(&self, id: &str) {
        if let Some(s) = lock(&self.sessions).remove(id) {
            wake_reader(&s.paused);
            kill_tree(s.pid, &s.child);
        }
    }

    fn close_all(&self) {
        for (_, s) in lock(&self.sessions).drain() {
            wake_reader(&s.paused);
            kill_tree(s.pid, &s.child);
        }
    }
}

/// The environment a pane child gets whatever its spawn mode: the `~/.local/bin`
/// PATH prepend, the caller's per-pane `env`, and `BIGBRAIN_URL`. Built in one
/// place so the PTY and piped paths cannot drift apart.
///
/// Also does the BigBrain config-file side effect, for the same reason: a
/// headless pane is still an agent that needs the memory contract.
///
/// TERM/COLORTERM are deliberately NOT here — see the note at their (PTY-only)
/// call site.
fn pane_env(opts: &SpawnOpts, brain_url: &str) -> Vec<(String, std::ffi::OsString)> {
    let mut out: Vec<(String, std::ffi::OsString)> = Vec::new();
    // A GUI-launched app inherits the systemd user PATH, which has no
    // ~/.local/bin — where npm-style installs put `claude`, `codex`, etc.
    // Only the login shell adds it, and startup commands run under a
    // non-login `sh -c`, so a "claude" startup command dies with
    // "command not found". Prepend it before the per-pane env so an
    // explicit PATH from the caller still wins.
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let path = std::env::var("PATH").unwrap_or_default();
        let local = home.join(".local/bin");
        let bin = home.join("bin");
        let missing = |d: &PathBuf| !std::env::split_paths(&path).any(|p| p == *d);
        let mut dirs: Vec<PathBuf> = [local, bin].into_iter().filter(missing).collect();
        if !dirs.is_empty() {
            dirs.extend(std::env::split_paths(&path));
            if let Ok(joined) = std::env::join_paths(dirs) {
                out.push(("PATH".to_string(), joined));
            }
        }
    }
    for (k, v) in opts.env.clone().into_iter().flatten() {
        out.push((k, v.into()));
    }
    // Every pane gets the brain address: the MCP config expands `${BIGBRAIN_URL}`
    // and swarm hooks/briefs assume it, and none of those panes carry
    // bigBrainTargets — gating the var on the file side effect left every swarm
    // agent with an unresolvable MCP server and a 401 brain (no tokened URL).
    // A caller-supplied BIGBRAIN_URL WINS: a swarm pane is spawned with its own
    // per-role AGENT-token URL (see brain::swarm_register_agents), and pushing
    // the session URL after it would hand the pane the unrestricted credential
    // the whole identity scheme exists to withhold.
    let caller_set_brain = opts.env.as_ref().is_some_and(|e| e.contains_key("BIGBRAIN_URL"));
    if !brain_url.is_empty() && !caller_set_brain {
        out.push(("BIGBRAIN_URL".to_string(), brain_url.into()));
    }
    // The config-file side effect stays opt-in: only a pane that names contract
    // files gets the managed block written into its cwd.
    let bb_targets = opts.big_brain_targets.clone().unwrap_or_default();
    if !bb_targets.is_empty() && !brain_url.is_empty() {
        let dir = opts
            .cwd
            .clone()
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok());
        if let Some(dir) = dir {
            ensure_bigbrain_files(&dir, brain_url, &bb_targets);
        }
    }
    out
}

/// Prefix the wrapper objects below carry in their `type` field. Namespaced so a
/// consumer can never confuse one with an event the CLI itself emitted.
const DIAG_TYPE: &str = "pixelmarch_stderr";

/// Read a piped child's stderr and push each LINE onto the main stream as a
/// JSON object, so the pane's byte stream stays valid line-delimited JSON.
///
/// Neither of the obvious alternatives is acceptable. Letting stderr through raw
/// splices non-JSON — possibly mid-line — into a stream a parser is reading as
/// NDJSON. Dropping it loses exactly the messages that explain why a headless
/// pane produced nothing: `claude` reports a bad `--mcp-config`, an auth
/// failure, or an unknown flag on stderr and then exits, and a pane that ate
/// those would look like a silent hang. Wrapping keeps both properties.
///
/// Line-buffered, so a partial write can never be emitted as a JSON object with
/// half a message in it. A final unterminated fragment is flushed at EOF.
/// Not gated on the flow-control pause: stderr is diagnostic and low volume, and
/// parking it would only hide the reason a paused pane is stuck.
fn diag_loop(reader: Box<dyn Read + Send>, tx: Sender<Vec<u8>>) {
    let mut reader = reader;
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    let emit = |line: &[u8], tx: &Sender<Vec<u8>>| -> bool {
        if line.is_empty() {
            return true;
        }
        let text = String::from_utf8_lossy(line);
        let msg = serde_json::json!({ "type": DIAG_TYPE, "text": text });
        match serde_json::to_vec(&msg) {
            Ok(mut bytes) => {
                bytes.push(b'\n');
                tx.send(bytes).is_ok()
            }
            Err(_) => true,
        }
    };
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' {
                        if !emit(&line, &tx) {
                            return;
                        }
                        line.clear();
                    } else if b != b'\r' {
                        line.push(b);
                    }
                }
            }
        }
    }
    emit(&line, &tx);
}

/// Drain PTY reads off `rx` and hand batches to `emit`, coalescing ADAPTIVELY:
/// a quiet pipe flushes at once (a typed character's echo must not sit in a
/// timer), and only a stream that is actually hot pays the full [`COALESCE`]
/// window that keeps a flood from melting the socket and the Tauri bridge.
///
/// Hotness is earned, not guessed: a batch big enough to be a burst, a channel
/// that still had more queued when we drained it, a window that kept filling,
/// or flushes landing closer together than [`HOT_GAP`] each count as a strike.
/// [`HOT_STRIKES`] in a row turns the window on for [`HOT_LINGER`], which any
/// further busy flush renews — so a flood coalesces from its second batch on and
/// stays coalesced, while idle typing never trips it. Runs until the reader
/// thread drops its sender.
fn coalesce_loop(rx: mpsc::Receiver<Vec<u8>>, mut emit: impl FnMut(&[u8])) {
    let mut hot_until: Option<Instant> = None;
    let mut last_flush: Option<Instant> = None;
    let mut strikes: u32 = 0;

    while let Ok(first) = rx.recv() {
        let mut batch = first;
        let start = Instant::now();

        // Free either way: take whatever is ALREADY queued without waiting.
        let mut backlog = false;
        while batch.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(more) => {
                    batch.extend_from_slice(&more);
                    backlog = true;
                }
                Err(_) => break,
            }
        }

        // Only a hot stream waits for more to show up.
        let mut window_fed = false;
        if hot_until.map_or(false, |t| start < t) {
            let deadline = start + COALESCE;
            loop {
                let now = Instant::now();
                if now >= deadline || batch.len() >= MAX_BATCH {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(more) => {
                        batch.extend_from_slice(&more);
                        window_fed = true;
                    }
                    Err(_) => break,
                }
            }
        }

        let now = Instant::now();
        let busy = backlog
            || window_fed
            || batch.len() >= HOT_BYTES
            || last_flush.map_or(false, |t| now.duration_since(t) < HOT_GAP);
        strikes = if busy { (strikes + 1).min(HOT_STRIKES) } else { 0 };
        if strikes >= HOT_STRIKES {
            hot_until = Some(now + HOT_LINGER);
        }
        last_flush = Some(now);

        emit(&batch);
    }
}

/// Clear a session's pause flag and wake its (possibly parked) reader thread, so
/// after the child is killed the reader unparks, reads EOF, and exits cleanly.
fn wake_reader(paused: &(Mutex<bool>, Condvar)) {
    let (m, cv) = paused;
    *m.lock().unwrap() = false;
    cv.notify_all();
}

// ── run loop ────────────────────────────────────────────────────────────────

/// Entry point when the exe is launched with `--host`. Never returns until the
/// GUI asks the host to shut down.
pub fn run_host() {
    remove_legacy_files();
    // Token before bind: the port file is what clients look for, so it must not
    // appear until the token they will need is already on disk.
    let token = new_token();
    write_token(&token);
    // The pid is published INSIDE `bind()`, next to the port and only on success —
    // see the note there for why writing it earlier is wrong.
    let listener = match bind() {
        Some(l) => l,
        None => return,
    };
    // BigBrain lives in the host so it stays up across GUI restarts/updates.
    // Publish its URL for the GUI to read.
    let brain_url = crate::brain::start().unwrap_or_default();
    let _ = std::fs::write(brain_url_file(), &brain_url);
    let host: Arc<Host> = Arc::new(Host::new(brain_url, token));

    // Serve every connection in its own thread; the NEWEST client owns the
    // output stream (generation-guarded). Serving inline used to block the
    // accept loop on the previous GUI's socket — if anything kept that socket
    // alive past the GUI's exit (self-update relaunch races, lingering handles),
    // the fresh GUI sat unaccepted in the backlog and its panes stayed blank
    // until a manual close + reopen.
    let next_gen = AtomicU64::new(1);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let gen = next_gen.fetch_add(1, Ordering::Relaxed);
        let host = Arc::clone(&host);
        thread::spawn(move || serve_client(&host, stream, gen));
    }
}

/// Bind the first free port in range and publish it — port AND pid — to disk.
///
/// Both files are written only after a successful bind, and for the same reason:
/// a process that failed to bind is not the host, and must not overwrite the
/// files of the one that is. Publishing the pid before the bind meant a second
/// `--host` (started by a second GUI, which then loses the race) clobbered the
/// LIVE host's pid with its own and, on the way out, deleted the file outright —
/// leaving the running host invisible to the updater's `stop_host`.
fn bind() -> Option<TcpListener> {
    for port in PORT_RANGE {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            let _ = std::fs::write(pid_file(), std::process::id().to_string());
            let _ = std::fs::write(port_file(), port.to_string());
            return Some(l);
        }
    }
    None
}

fn serve_client(host: &Arc<Host>, stream: TcpStream, gen: u64) {
    let mut reader = match stream.try_clone() {
        Ok(r) => r,
        Err(_) => return,
    };

    // Handshake first. Until it passes the connection owns nothing: no output
    // stream (so it cannot steal the live GUI's feed) and no dispatch (so it
    // cannot write to a pane or shut the host down). Returning drops the socket.
    let _ = reader.set_read_timeout(Some(AUTH_TIMEOUT));
    let authed = match read_frame(&mut reader) {
        Ok(f) => matches!(
            serde_json::from_slice::<ClientMsg>(&f),
            Ok(ClientMsg::Auth { token }) if token_eq(&token, &host.token)
        ),
        Err(_) => false,
    };
    if !authed {
        return;
    }
    let _ = reader.set_read_timeout(None);

    // Writer thread: drain frames -> socket. Owns the write half.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut wstream = stream;
    let writer = thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if write_frame(&mut wstream, &bytes).is_err() {
                break;
            }
        }
    });
    host.attach_client(gen, tx);

    // Read loop: dispatch client messages until disconnect.
    loop {
        let frame = match read_frame(&mut reader) {
            Ok(f) => f,
            Err(_) => break, // client gone
        };
        let Ok(msg) = serde_json::from_slice::<ClientMsg>(&frame) else { continue };
        match msg {
            ClientMsg::Auth { .. } => {} // already authenticated; a repeat is a no-op
            ClientMsg::Open { id, opts } => {
                let _ = host.open(id, opts);
            }
            ClientMsg::Write { id, data } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    host.write(&id, &bytes);
                }
            }
            ClientMsg::Resize { id, rows, cols } => host.resize(&id, rows, cols),
            ClientMsg::Pause { id } => host.set_paused(&id, true),
            ClientMsg::Resume { id } => host.set_paused(&id, false),
            ClientMsg::Close { id } => host.close(&id),
            ClientMsg::Shutdown => {
                host.close_all();
                let _ = std::fs::remove_file(port_file());
                let _ = std::fs::remove_file(token_file());
                let _ = std::fs::remove_file(pid_file());
                std::process::exit(0);
            }
        }
    }

    // Detached: keep every session running, just stop sending — unless a newer
    // GUI already took over, in which case leave its stream alone.
    host.detach_client(gen);
    drop(writer); // its channel is closed now; thread ends on its own
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const TEST_TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn test_host() -> Arc<Host> {
        Arc::new(Host::new(String::new(), TEST_TOKEN.to_string()))
    }

    fn auth_frame(w: &mut impl Write, token: &str) {
        let msg = format!(r#"{{"t":"auth","token":"{token}"}}"#);
        write_frame(w, msg.as_bytes()).unwrap();
    }

    fn wait_for(cond: &dyn Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for host state");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn current_gen(h: &Arc<Host>) -> Option<u64> {
        lock(&h.out).as_ref().map(|(g, _)| *g)
    }

    /// The self-update handoff bug: a stale GUI connection must never block a
    /// new GUI from attaching, and its teardown must never detach the new one.
    #[test]
    fn newest_client_preempts_stale_one() {
        let host = test_host();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();

        // Old GUI connects, authenticates, then goes quiet (lingering socket).
        let mut old_gui = TcpStream::connect(addr).unwrap();
        let (old_srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let old_thread = thread::spawn(move || serve_client(&h, old_srv, 1));
        auth_frame(&mut old_gui, TEST_TOKEN);
        wait_for(&|| current_gen(&host) == Some(1));

        // New GUI connects while the old socket is still open: it must be
        // served immediately and own the output stream.
        let mut new_gui = TcpStream::connect(addr).unwrap();
        let (new_srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let new_thread = thread::spawn(move || serve_client(&h, new_srv, 2));
        auth_frame(&mut new_gui, TEST_TOKEN);
        wait_for(&|| current_gen(&host) == Some(2));

        // A frame the new GUI sends is dispatched even though the old client
        // never disconnected (resize of an unknown id: valid, side-effect free).
        write_frame(&mut new_gui, br#"{"t":"resize","id":"nope","rows":1,"cols":1}"#).unwrap();

        // Old GUI finally dies; its serve thread must NOT detach the new client.
        drop(old_gui);
        old_thread.join().unwrap();
        assert_eq!(current_gen(&host), Some(2), "stale teardown clobbered the live client");

        drop(new_gui);
        new_thread.join().unwrap();
        assert_eq!(current_gen(&host), None);
    }

    /// A local process that guesses the port must not be able to steal the live
    /// GUI's output stream (which would blank every pane) or type into a pane.
    #[test]
    fn unauthenticated_client_never_attaches() {
        let host = test_host();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();

        let mut gui = TcpStream::connect(addr).unwrap();
        let (gui_srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let gui_thread = thread::spawn(move || serve_client(&h, gui_srv, 1));
        auth_frame(&mut gui, TEST_TOKEN);
        wait_for(&|| current_gen(&host) == Some(1));

        // Attacker: wrong token, then straight to the commands it wants.
        let mut evil = TcpStream::connect(addr).unwrap();
        let (evil_srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let evil_thread = thread::spawn(move || serve_client(&h, evil_srv, 2));
        auth_frame(&mut evil, "not-the-token");
        let _ = write_frame(&mut evil, br#"{"t":"resize","id":"nope","rows":1,"cols":1}"#);

        // Its serve thread returns without ever attaching, so the GUI keeps the
        // stream — generation 2 must never have appeared.
        evil_thread.join().unwrap();
        assert_eq!(current_gen(&host), Some(1), "unauthenticated client stole the output stream");

        drop(evil);
        drop(gui);
        gui_thread.join().unwrap();
        assert_eq!(current_gen(&host), None);
    }

    /// Skipping the handshake entirely is just as dead as failing it.
    #[test]
    fn first_frame_must_be_auth() {
        let host = test_host();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();

        let mut evil = TcpStream::connect(addr).unwrap();
        let (evil_srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let t = thread::spawn(move || serve_client(&h, evil_srv, 1));
        let _ = write_frame(&mut evil, br#"{"t":"shutdown"}"#);
        t.join().unwrap();
        assert_eq!(current_gen(&host), None);
    }

    #[test]
    fn token_eq_rejects_mismatch_and_empty() {
        assert!(token_eq(TEST_TOKEN, TEST_TOKEN));
        assert!(!token_eq(TEST_TOKEN, "0123456789abcdef0123456789abcdee"));
        assert!(!token_eq(TEST_TOKEN, "short"));
        assert!(!token_eq("", ""), "an unpublished token must not authenticate");
    }

    #[test]
    fn new_token_is_unique_and_long() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    /// Swarm panes carry no bigBrainTargets, but their MCP config expands
    /// `${BIGBRAIN_URL}` and their briefs assume it — gating the var on the
    /// contract-file side effect left every swarm agent with an unresolvable
    /// MCP server and a 401 brain. The var must reach EVERY pane; only the
    /// file writes stay opt-in.
    #[test]
    fn every_pane_gets_bigbrain_url_even_without_targets() {
        let opts = SpawnOpts {
            rows: 24,
            cols: 80,
            shell: None,
            args: None,
            cwd: None,
            startup_command: None,
            env: None,
            big_brain_targets: None,
            mode: None,
        };
        let url = "http://127.0.0.1:8734/t/sometoken";
        let env = pane_env(&opts, url);
        let found = env.iter().find(|(k, _)| k == "BIGBRAIN_URL");
        assert_eq!(found.map(|(_, v)| v.clone()), Some(url.into()));
        // No brain running = no var, never an empty one (agents treat unset
        // as "no brain" and an empty value as an address).
        assert!(!pane_env(&opts, "").iter().any(|(k, _)| k == "BIGBRAIN_URL"));
    }

    /// Anyone who can read the token file owns every terminal on this machine, so
    /// the file must NEVER be readable by another account — not even for the one
    /// syscall between `fs::write`'s 0644 and a follow-up chmod, which is a race a
    /// local attacker only has to win once.
    #[cfg(unix)]
    #[test]
    fn the_token_file_is_never_world_readable_even_for_an_instant() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pixelmarch-token-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pixelmarch-host.token");

        write_token_at(&path, TEST_TOKEN);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "token file is {mode:o}, must be 0600");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TEST_TOKEN);

        // A pre-existing world-readable file (older build, restored backup, copied
        // portable folder) must not have a fresh secret written INTO it — `fs::write`
        // reuses the inode and keeps its mode, so the file is replaced, not reused.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        write_token_at(&path, "second-token");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a loose old token file must be replaced, not reused ({mode:o})");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second-token");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A SYMLINK planted at the token path must not be followed. `remove_file`
    /// then `create` leaves a window in which anything that can write the exe
    /// directory can put a link there; `create` would follow it and write the
    /// session secret into a file the attacker owns and can read. `create_new`
    /// refuses to open through it.
    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_the_token_path_never_receives_the_token() {
        let dir = std::env::temp_dir().join(format!("pixelmarch-token-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pixelmarch-host.token");
        let decoy = dir.join("attacker-readable");
        std::fs::write(&decoy, "not the token").unwrap();
        std::os::unix::fs::symlink(&decoy, &path).unwrap();

        write_token_at(&path, TEST_TOKEN);

        // The link was unlinked and a fresh regular file created in its place…
        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TEST_TOKEN);
        // …and the target the link pointed at never saw the secret.
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "not the token");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The host is a terminal-execution service. Binding anything but loopback would
    /// publish "run commands as this user" to the network, so the address is pinned
    /// here — a wildcard-address typo in `bind()` is not a bug anyone would notice
    /// locally, and the machine that notices it is not ours.
    #[test]
    fn the_host_binds_loopback_only() {
        let src = include_str!("host.rs");
        // Every listener in this file, not just the one in `bind()` — asserting the
        // absence of a wildcard literal would only match this assertion's own source.
        let needle = "TcpListener::bind";
        let loopback = format!("(({}127.0.0.1{},", '"', '"');
        // Skip the mentions inside this test itself: a real call is followed by `(`,
        // the string literals here are followed by a quote.
        let sites: Vec<&str> = src
            .match_indices(needle)
            .map(|(i, _)| &src[i + needle.len()..])
            .filter(|rest| rest.starts_with('('))
            .collect();
        assert!(!sites.is_empty(), "the listener moved; this test no longer checks anything");
        for site in sites {
            assert!(
                site.starts_with(&loopback),
                "a listener binds something other than loopback: {}",
                &site[..site.len().min(40)]
            );
        }
        // ...and the range it walks is a fixed, small, non-privileged one.
        assert!(PORT_RANGE.clone().all(|p| p >= 1024));
        assert!(PORT_RANGE.clone().count() <= 64);
    }

    /// Every mutating message is behind the handshake. `serve_client` returns before
    /// dispatch on a bad token, so this pins the ONE property that makes that true:
    /// an unauthenticated connection is dropped, having changed nothing.
    #[test]
    fn no_message_is_dispatched_before_the_token_is_accepted() {
        let host = test_host();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let mut evil = TcpStream::connect(addr).unwrap();
        let (srv, _) = listener.accept().unwrap();
        let h = Arc::clone(&host);
        let t = thread::spawn(move || serve_client(&h, srv, 1));

        // No auth frame at all — straight to the commands an attacker wants.
        let _ = write_frame(&mut evil, br#"{"t":"open","id":"pwn","opts":{}}"#);
        let _ = write_frame(&mut evil, br#"{"t":"shutdown"}"#);
        t.join().unwrap();

        assert!(host.sessions.lock().unwrap().is_empty(), "an unauthenticated open must spawn nothing");
        assert_eq!(current_gen(&host), None, "...and must never own the output stream");
    }

    #[test]
    fn oversized_frame_is_refused_without_allocating() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&u32::MAX.to_be_bytes()); // 4 GiB "frame"
        let mut r = Cursor::new(buf);
        assert!(read_frame(&mut r).is_err());
    }

    #[test]
    fn frame_round_trips_including_empty_and_binary() {
        let mut buf: Vec<u8> = Vec::new();
        let a = b"hello".to_vec();
        let b: Vec<u8> = vec![0, 255, 10, 13, 0]; // NULs + CR/LF survive intact
        let c: Vec<u8> = Vec::new(); // zero-length frame
        write_frame(&mut buf, &a).unwrap();
        write_frame(&mut buf, &b).unwrap();
        write_frame(&mut buf, &c).unwrap();

        let mut r = Cursor::new(buf);
        assert_eq!(read_frame(&mut r).unwrap(), a);
        assert_eq!(read_frame(&mut r).unwrap(), b);
        assert_eq!(read_frame(&mut r).unwrap(), c);
        assert!(read_frame(&mut r).is_err()); // EOF past the last frame
    }

    /// Only the PTY-spawning tests use this, and they are all unix-gated.
    #[cfg(unix)]
    fn echo_opts(shell: &str) -> SpawnOpts {
        SpawnOpts {
            rows: 24,
            cols: 80,
            shell: Some(shell.to_string()),
            args: Some(vec![]),
            cwd: None,
            startup_command: None,
            env: None,
            big_brain_targets: None,
            mode: None, // absent = Pty = what this helper has always spawned
        }
    }

    /// A headless pane running `startup` through `/bin/sh`, which is the shape
    /// the frontend produces: a command LINE, not an argv.
    #[cfg(unix)]
    fn piped_opts(startup: &str) -> SpawnOpts {
        SpawnOpts {
            rows: 24,
            cols: 80,
            shell: Some("/bin/sh".to_string()),
            args: Some(vec![]),
            cwd: None,
            startup_command: Some(startup.to_string()),
            env: None,
            big_brain_targets: None,
            mode: Some(SpawnMode::Piped),
        }
    }

    /// Decode the base64 payload of every `Data` frame, concatenated. The frames
    /// are the real `ServerMsg` JSON the GUI receives, so this reads the pane
    /// exactly as the frontend would.
    ///
    /// Stops as soon as `done` is happy with what has arrived so far, or shortly
    /// after the pane's `Exit` frame — a short grace, because `Data` (coalescer
    /// thread) and `Exit` (waiter thread) race and the last output must not be
    /// truncated. `within` is the ceiling for a pane that does neither.
    #[cfg(unix)]
    fn drain_until(
        rx: &mpsc::Receiver<Vec<u8>>,
        within: Duration,
        done: impl Fn(&str) -> bool,
    ) -> String {
        let mut deadline = Instant::now() + within;
        let mut out = String::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(frame) = rx.recv_timeout(left) else { break };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&frame) else { continue };
            match v.get("t").and_then(|t| t.as_str()) {
                Some("data") => {
                    let Some(b64) = v.get("data").and_then(|d| d.as_str()) else { continue };
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                        out.push_str(&String::from_utf8_lossy(&bytes));
                    }
                    if done(&out) {
                        break;
                    }
                }
                Some("exit") => deadline = deadline.min(Instant::now() + Duration::from_millis(250)),
                _ => {}
            }
        }
        out
    }

    /// Is this pid still alive? `kill(pid, 0)` reports without signalling.
    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    /// The whole point of the mode: a JSON line written to the pane comes back
    /// out of the pane, through the SAME `Data` frames a PTY pane uses — so the
    /// frontend needs no second event channel to read a headless agent.
    #[cfg(unix)]
    #[test]
    fn a_piped_child_round_trips_a_json_line() {
        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        // `cat` is the smallest honest stand-in for a stream-json agent: read a
        // line on stdin, write a line on stdout.
        host.open("head".to_string(), piped_opts("cat")).unwrap();

        host.write("head", br#"{"type":"user","text":"hi"}"#);
        host.write("head", b"\n");
        let text = drain_until(&rx, Duration::from_secs(5), |t| t.contains('\n'));
        host.close("head");

        assert!(
            text.lines().any(|l| l == r#"{"type":"user","text":"hi"}"#),
            "the JSON line did not come back intact: {text:?}"
        );
    }

    /// A headless pane's stderr must reach the frontend, and must not corrupt
    /// the JSON stream on the way. `claude` reports a bad flag or a failed auth
    /// there and then exits; a pane that dropped it would look like a silent
    /// hang, which is the exact failure mode this phase exists to remove.
    #[cfg(unix)]
    #[test]
    fn piped_stderr_arrives_as_its_own_json_line() {
        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open(
            "err".to_string(),
            piped_opts("printf '{\"type\":\"result\"}\\n'; printf 'boom: bad --flag\\n' >&2"),
        )
        .unwrap();

        // The child exits on its own, so the drain ends on the Exit frame.
        let text = drain_until(&rx, Duration::from_secs(5), |_| false);
        host.close("err");

        // EVERY line is parseable JSON — the stderr text did not land raw.
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|e| panic!("non-JSON line {line:?} in a headless stream: {e}"));
        }
        let diag: Vec<serde_json::Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some(DIAG_TYPE))
            .collect();
        assert_eq!(diag.len(), 1, "expected exactly one stderr object in {text:?}");
        assert_eq!(diag[0]["text"], "boom: bad --flag");
        assert!(text.contains(r#""type":"result""#), "stdout was lost: {text:?}");
    }

    /// `kill_tree` signals a process GROUP and is only allowed to because the
    /// child is a session leader. A `std::process::Command` child is not one by
    /// default — it inherits ours — so without `new_process_group` the killpg
    /// misses and the GRANDCHILD survives, silently, while the pane still
    /// disappears from the UI. That is the regression this pins.
    #[cfg(unix)]
    #[test]
    fn closing_a_piped_pane_reaps_its_grandchild_too() {
        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open(
            "tree".to_string(),
            // Background a grandchild, report both pids, then stay alive.
            piped_opts("sleep 300 & printf '{\"kid\":%d,\"me\":%d}\\n' $! $$; sleep 300"),
        )
        .unwrap();

        let text = drain_until(&rx, Duration::from_secs(5), |t| t.contains('\n'));
        let line = text
            .lines()
            .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .unwrap_or_else(|| panic!("piped child never reported its pids: {text:?}"));
        let kid = line["kid"].as_i64().unwrap() as i32;
        let me = line["me"].as_i64().unwrap() as i32;
        assert!(alive(kid) && alive(me), "the test's own children died early");

        host.close("tree");
        // SIGTERM, 150 ms, SIGKILL inside kill_tree, plus reaping slack.
        let deadline = Instant::now() + Duration::from_secs(5);
        while (alive(kid) || alive(me)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!alive(me), "the piped child itself survived close()");
        assert!(
            !alive(kid),
            "the GRANDCHILD survived close() — kill_tree missed the process group"
        );
    }

    /// A headless child that stops draining its stdin must stall ITSELF ONLY.
    ///
    /// This is the pipe-vs-pty asymmetry that made the old global-lock write
    /// unsafe the moment anything wrote to a headless pane: a pty master write
    /// lands in the tty buffer and returns, a pipe write blocks once ~64 KiB is
    /// in flight and nobody is reading. With the writer under the `sessions`
    /// lock, that one blocked write froze every other pane's write, resize,
    /// spawn and close — including the close that would have killed the
    /// offender. So the freeze was app-wide AND unrecoverable.
    #[cfg(unix)]
    #[test]
    fn a_stuck_headless_pane_cannot_block_the_other_panes() {
        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        // Never reads stdin, so its pipe buffer fills and stays full.
        host.open("stuck".to_string(), piped_opts("sleep 60")).unwrap();
        host.open("live".to_string(), piped_opts("cat")).unwrap();

        let blocked = {
            let host = Arc::clone(&host);
            thread::spawn(move || host.write("stuck", &vec![b'x'; 1 << 20])) // 1 MiB >> 64 KiB
        };
        // Give the blocking write time to actually be in flight and holding
        // whatever lock it is going to hold.
        thread::sleep(Duration::from_millis(300));

        // Every one of these used to queue behind the blocked write.
        let (done_tx, done_rx) = mpsc::channel::<&'static str>();
        {
            let host = Arc::clone(&host);
            thread::spawn(move || {
                host.write("live", b"still alive\n");
                let _ = done_tx.send("write");
                host.resize("live", 30, 100);
                let _ = done_tx.send("resize");
                host.open("third".to_string(), piped_opts("sleep 60")).unwrap();
                let _ = done_tx.send("spawn");
                host.close("stuck"); // the recovery that the freeze also swallowed
                let _ = done_tx.send("close");
            });
        }
        for step in ["write", "resize", "spawn", "close"] {
            let got = done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|_| panic!("`{step}` was blocked behind a stuck headless pane"));
            assert_eq!(got, step);
        }
        // ...and the pane that stayed healthy really did get its bytes.
        let text = drain_until(&rx, Duration::from_secs(5), |t| t.contains("still alive"));
        assert!(text.contains("still alive"), "healthy pane never echoed: {text:?}");

        blocked.join().unwrap(); // killing the child releases the stuck write
        host.close("live");
        host.close("third");
    }

    /// THE WIRE, with the real agent on the far end of it.
    ///
    /// Everything above proves the plumbing with stand-ins. This drives an
    /// actual `claude` through `spawn_piped` — the product's own spawn path,
    /// with the command line the frontend will build — and reads real
    /// line-delimited JSON back out of the pane's `Data` frames. It is the
    /// difference between "our pipes work" and "a headless agent works".
    ///
    /// It costs no API turn: an input message the CLI does not recognise makes
    /// it run its session lifecycle, emit those events as stream-json, and exit
    /// 0 without ever calling the model.
    ///
    /// `--verbose` is not optional and not decoration — VERIFIED against claude
    /// 2.1.218, which refuses the combination without it:
    ///   "Error: When using --print, --output-format=stream-json requires --verbose"
    /// Nothing in `--help` says so. The frontend must emit it, and this test is
    /// where that stops being a thing someone has to remember.
    ///
    /// Skips (does not fail) where `claude` is absent, same as
    /// `real_pty_flood_stays_coalesced` does for `yes` — the other four piped
    /// tests still cover the mode on such a host.
    #[cfg(unix)]
    #[test]
    fn a_real_headless_agent_streams_json_through_a_piped_pane() {
        let Some(claude) = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .map(|d| d.join("claude"))
            .find(|p| p.is_file())
        else {
            eprintln!("no `claude` binary found; skipping a_real_headless_agent_streams_json_through_a_piped_pane");
            return;
        };

        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open(
            "agent".to_string(),
            piped_opts(&format!(
                "{} -p --verbose --input-format stream-json --output-format stream-json",
                claude.display()
            )),
        )
        .unwrap();

        host.write("agent", b"{\"type\":\"pixelmarch_probe\"}\n");
        // Stops at the first complete line. NOT at the pane's exit: a headless
        // pane holds the CLI's stdin open, so a real agent waits for the next
        // message instead of exiting — which is the behaviour the pane wants and
        // the reason a drain that waited for `Exit` would sit here for its whole
        // ceiling.
        let text = drain_until(&rx, Duration::from_secs(60), |t| t.contains('\n'));
        host.close("agent");

        let objs: Vec<serde_json::Value> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                serde_json::from_str(l)
                    .unwrap_or_else(|e| panic!("claude emitted a non-JSON line {l:?}: {e}"))
            })
            .collect();
        eprintln!(
            "REAL HEADLESS AGENT: {} JSON objects, types {:?}",
            objs.len(),
            objs.iter()
                .filter_map(|v| v.get("type").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
        );
        assert!(!objs.is_empty(), "a real headless agent produced nothing: {text:?}");
        assert!(
            objs.iter().all(|v| v.get("type").is_some()),
            "an object arrived without a `type`: {objs:?}"
        );
        // If `--verbose` were missing this is what would come back instead, on
        // stderr, wrapped by `diag_loop` — assert we did NOT hit it.
        assert!(
            !text.contains("requires --verbose"),
            "the command line the product builds is rejected by the CLI: {text}"
        );
    }

    /// The PTY path is the default and must stay it: an `Open` frame with no
    /// `mode` — every frame the GUI has ever sent — still means a real terminal.
    #[test]
    fn a_spawn_request_without_a_mode_is_still_a_pty() {
        let opts: SpawnOpts = serde_json::from_str(
            r#"{"rows":24,"cols":80,"shell":"/bin/sh","args":[],"cwd":null,
                "startupCommand":null,"env":null,"bigBrainTargets":null}"#,
        )
        .expect("an existing Open frame must still deserialize");
        assert_eq!(opts.mode, None);
        assert_eq!(opts.mode.unwrap_or_default(), SpawnMode::Pty);
        // ...and the mode is spelled the way the frontend will send it.
        let piped: SpawnOpts =
            serde_json::from_str(r#"{"rows":24,"cols":80,"mode":"piped"}"#).unwrap();
        assert_eq!(piped.mode, Some(SpawnMode::Piped));
    }

    /// Resizing a headless pane is meaningless, not fatal: there is no master
    /// behind it. The GUI resizes on every layout change, so an unwrapped
    /// `master` here would take the host down the first time a pane moved.
    #[cfg(unix)]
    #[test]
    fn resizing_a_headless_pane_is_a_no_op() {
        let host = test_host();
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open("nores".to_string(), piped_opts("sleep 5")).unwrap();
        host.resize("nores", 10, 40);
        host.resize("unknown-id", 10, 40);
        host.close("nores");
    }

    /// Keystroke echo latency, measured end to end through a real PTY: write one
    /// byte, wait for the Data frame carrying its echo. This is the floor every
    /// typed character pays; the fixed coalescing window used to make it ~16 ms.
    /// Unix-only: it spawns a real `cat` child. The coalescer itself stays
    /// covered on Windows by the pure-channel tests below.
    #[cfg(unix)]
    #[test]
    fn idle_keystroke_echo_does_not_wait_for_the_coalesce_window() {
        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open("echo".to_string(), echo_opts("/bin/cat")).unwrap();

        // Let the PTY settle and swallow anything it says on startup.
        thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}

        let mut samples: Vec<u128> = Vec::new();
        for _ in 0..20 {
            let t0 = Instant::now();
            host.write("echo", b"a");
            let frame = rx.recv_timeout(Duration::from_secs(2)).expect("no echo frame");
            samples.push(t0.elapsed().as_micros());
            assert!(!frame.is_empty());
            thread::sleep(Duration::from_millis(60)); // idle between keystrokes
        }
        host.close("echo");

        samples.sort_unstable();
        let median = samples[samples.len() / 2] as f64 / 1000.0;
        let worst = *samples.last().unwrap() as f64 / 1000.0;
        eprintln!("ECHO LATENCY: median {median:.2} ms, max {worst:.2} ms over {} keystrokes", samples.len());
        assert!(median < 8.0, "idle keystroke echo still costs {median:.2} ms");
    }

    /// The other half of the contract: a flood must still be coalesced into a
    /// few big frames, not one frame per PTY read.
    #[test]
    fn flood_still_coalesces_into_few_frames() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (out_tx, out_rx) = mpsc::channel::<usize>();
        let h = thread::spawn(move || {
            coalesce_loop(rx, |batch| {
                let _ = out_tx.send(batch.len());
            });
        });

        const CHUNKS: usize = 4000;
        const CHUNK: usize = 4096; // one 8 KiB-ish PTY read's worth
        let t0 = Instant::now();
        for _ in 0..CHUNKS {
            tx.send(vec![b'x'; CHUNK]).unwrap();
        }
        drop(tx);
        h.join().unwrap();
        let elapsed = t0.elapsed();

        let mut frames = 0usize;
        let mut bytes = 0usize;
        while let Ok(n) = out_rx.try_recv() {
            frames += 1;
            bytes += n;
        }
        let mib = bytes as f64 / (1024.0 * 1024.0);
        eprintln!(
            "FLOOD: {bytes} B in {frames} frames over {:.1} ms ({:.0} MiB/s, {:.0} frames/s)",
            elapsed.as_secs_f64() * 1000.0,
            mib / elapsed.as_secs_f64(),
            frames as f64 / elapsed.as_secs_f64(),
        );
        assert_eq!(bytes, CHUNKS * CHUNK, "flood lost bytes");
        assert!(frames * 20 < CHUNKS, "flood degenerated into per-read frames: {frames}");
    }

    /// The case the instant-fill flood above cannot cover: a producer that is
    /// fast but PACED, so the channel is usually empty when we look. This is
    /// what `yes` in a real PTY looks like, and it is where adaptive coalescing
    /// could regress into one frame per read if hotness did not stick.
    #[test]
    fn paced_flood_does_not_regress_into_one_frame_per_read() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (out_tx, out_rx) = mpsc::channel::<usize>();
        let h = thread::spawn(move || coalesce_loop(rx, |b| { let _ = out_tx.send(b.len()); }));

        // ~1 KiB every 500 µs for 500 ms: ~1000 reads, ~2 MiB/s.
        let t0 = Instant::now();
        let mut sent = 0usize;
        while t0.elapsed() < Duration::from_millis(500) {
            tx.send(vec![b'y'; 1024]).unwrap();
            sent += 1024;
            thread::sleep(Duration::from_micros(500));
        }
        drop(tx);
        h.join().unwrap();
        let elapsed = t0.elapsed().as_secs_f64();

        let (mut frames, mut bytes) = (0usize, 0usize);
        while let Ok(n) = out_rx.try_recv() {
            frames += 1;
            bytes += n;
        }
        eprintln!(
            "PACED FLOOD: {bytes} B in {frames} frames over {:.0} ms ({:.0} frames/s)",
            elapsed * 1000.0,
            frames as f64 / elapsed,
        );
        assert_eq!(bytes, sent, "paced flood lost bytes");
        // The fixed window emitted ~62 frames/s; adaptive must stay in that class,
        // not track the ~2000 reads/s the producer is doing.
        assert!(
            (frames as f64 / elapsed) < 150.0,
            "paced flood emits {:.0} frames/s",
            frames as f64 / elapsed
        );
    }

    /// `Host::write` takes the global `sessions` mutex only long enough to CLONE
    /// the target session's `Arc` writer, then does the write under that session's
    /// own lock — so panes contend with each other only for the lookup, never for
    /// the write itself. This measures that with many panes writing at once.
    ///
    /// It used to hold the global mutex across the write, and that is what this
    /// test was written to price. Don't read it as pricing that any more: the
    /// trade it was measuring for has happened, and the reason it had to was not
    /// contention but a FREEZE — one pane whose child stopped reading its stdin
    /// blocked the whole app inside the global lock. Cheap is not the property
    /// being defended here; per-session is.
    /// Unix-only: it spawns real `cat` children.
    #[cfg(unix)]
    #[test]
    fn concurrent_pane_writes_do_not_contend_measurably() {
        const PANES: usize = 12;
        const WRITES: usize = 200;

        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        for i in 0..PANES {
            host.open(format!("p{i}"), echo_opts("/bin/cat")).unwrap();
        }
        thread::sleep(Duration::from_millis(300));

        let workers: Vec<_> = (0..PANES)
            .map(|i| {
                let h = Arc::clone(&host);
                thread::spawn(move || {
                    let id = format!("p{i}");
                    let mut us: Vec<u128> = Vec::with_capacity(WRITES);
                    for _ in 0..WRITES {
                        let t0 = Instant::now();
                        h.write(&id, b"a");
                        us.push(t0.elapsed().as_micros());
                        thread::sleep(Duration::from_micros(200));
                    }
                    us
                })
            })
            .collect();
        let mut us: Vec<u128> = workers.into_iter().flat_map(|w| w.join().unwrap()).collect();
        for i in 0..PANES {
            host.close(&format!("p{i}"));
        }
        while rx.try_recv().is_ok() {}

        us.sort_unstable();
        let p50 = us[us.len() / 2] as f64;
        let p99 = us[us.len() * 99 / 100] as f64;
        let worst = *us.last().unwrap() as f64;
        eprintln!(
            "WRITE UNDER {PANES}-PANE CONTENTION: p50 {p50:.0} µs, p99 {p99:.0} µs, max {:.2} ms ({} writes)",
            worst / 1000.0,
            us.len()
        );
        // Keystroke-scale, not frame-scale: if this ever creeps toward a
        // millisecond the global lock has become worth splitting.
        assert!(p99 < 1000.0, "write p99 is {p99:.0} µs under contention");
    }

    /// End-to-end version of the same worry, through a real PTY and a real
    /// flooding child: bytes must keep flowing and frames must stay coalesced.
    /// Unix-only: it needs a real `yes`.
    #[cfg(unix)]
    #[test]
    fn real_pty_flood_stays_coalesced() {
        // `yes` is not at one fixed path on every unix, so try the usual homes
        // and skip rather than fail where it is absent.
        let Some(yes) = ["/usr/bin/yes", "/bin/yes", "/usr/local/bin/yes"]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists())
        else {
            eprintln!("no `yes` binary found; skipping real_pty_flood_stays_coalesced");
            return;
        };

        let host = test_host();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        host.attach_client(1, tx);
        host.open("flood".to_string(), echo_opts(yes)).unwrap();

        let t0 = Instant::now();
        let (mut frames, mut bytes) = (0usize, 0usize);
        while t0.elapsed() < Duration::from_millis(500) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(f) => {
                    frames += 1;
                    bytes += f.len();
                }
                Err(_) => break,
            }
        }
        let elapsed = t0.elapsed().as_secs_f64();
        host.close("flood");
        while rx.try_recv().is_ok() {}

        eprintln!(
            "REAL PTY FLOOD: {bytes} B (base64 frames) in {frames} frames over {:.0} ms ({:.0} frames/s, {:.1} MiB/s)",
            elapsed * 1000.0,
            frames as f64 / elapsed,
            bytes as f64 / (1024.0 * 1024.0) / elapsed,
        );
        assert!(frames > 0 && bytes > 0, "no output from the flooding child");
        assert!(
            (frames as f64 / elapsed) < 150.0,
            "real flood emits {:.0} frames/s",
            frames as f64 / elapsed
        );
    }
}
