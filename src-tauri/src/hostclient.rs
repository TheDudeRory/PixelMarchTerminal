//! GUI-side client for the detached PTY host (`host.rs`).
//!
//! Launches the host on first need (as `this-exe --host`, detached so it
//! outlives the GUI), connects over localhost TCP, proxies the pty_* Tauri
//! commands to it, and re-emits the host's output frames as the same
//! `pty://data` / `pty://exit` events the frontend already listens for — so the
//! frontend only had to switch from "spawn -> new id" to "open(paneId)".

use std::net::TcpStream;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::host::{port_file, read_frame, read_token, write_frame};
use crate::pty::SpawnOpts;

/// What the writer thread accepts. `Flush` is how a caller that cannot afford
/// to lose its frame (shutdown) waits for the queue to drain.
enum OutMsg {
    Frame(Vec<u8>),
    Flush(Sender<()>),
}

/// Outbound frames go to a dedicated writer thread instead of being written
/// inline. A `pty_write` used to hold a mutex across a BLOCKING framed socket
/// write, serialized against every other host message — so one keystroke could
/// queue behind an open/resize/close, on the main thread. Now the command side
/// only does a channel push; the socket write happens off-thread and frames
/// still leave in exactly the order they were queued.
pub struct HostClient {
    out: Mutex<Option<Sender<OutMsg>>>,
}

#[derive(Deserialize, Serialize, Clone)]
struct DataPayload {
    id: String,
    data: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: Option<i32>,
}

impl HostClient {
    /// Connect to the host (starting it if needed) and wire up the read loop.
    /// The host owns BigBrain; the GUI reads its URL via `host::read_brain_url`.
    pub fn connect(app: AppHandle) -> Self {
        let client = HostClient { out: Mutex::new(None) };
        if let Some(stream) = ensure_host() {
            if let Ok(reader) = stream.try_clone() {
                *client.out.lock().unwrap() = Some(spawn_write_loop(stream));
                spawn_read_loop(app, reader);
            }
        }
        client
    }

    /// False when `connect` never reached a host: every pty_* call is then a
    /// silent no-op, so the caller must tell the user rather than hand them a
    /// window whose terminals do nothing.
    pub fn connected(&self) -> bool {
        self.out.lock().unwrap().is_some()
    }

    fn send(&self, msg: &serde_json::Value) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            if let Ok(bytes) = serde_json::to_vec(msg) {
                let _ = tx.send(OutMsg::Frame(bytes));
            }
        }
    }

    /// Block until everything queued so far has hit the socket. Only for the
    /// paths that exit the process straight afterwards — otherwise a frame the
    /// writer thread has not reached yet would die with us.
    fn drain(&self, timeout: Duration) {
        let (ack, done) = mpsc::channel();
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            if tx.send(OutMsg::Flush(ack)).is_err() {
                return;
            }
        } else {
            return;
        }
        let _ = done.recv_timeout(timeout);
    }

    pub fn open(&self, id: &str, opts: SpawnOpts) {
        self.send(&json!({ "t": "open", "id": id, "opts": opts }));
    }

    pub fn write(&self, id: &str, data: &str) {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data.as_bytes());
        self.send(&json!({ "t": "write", "id": id, "data": b64 }));
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) {
        self.send(&json!({ "t": "resize", "id": id, "rows": rows, "cols": cols }));
    }

    pub fn close(&self, id: &str) {
        self.send(&json!({ "t": "close", "id": id }));
    }

    /// Flow control: ask the host to stop / resume reading this PTY. Sent by the
    /// GUI when a pane's render queue backs up (and drains), so a runaway
    /// producer is throttled to what the terminal can actually paint.
    pub fn pause(&self, id: &str) {
        self.send(&json!({ "t": "pause", "id": id }));
    }

    pub fn resume(&self, id: &str) {
        self.send(&json!({ "t": "resume", "id": id }));
    }

    /// Kill every session and stop the host ("Close all & quit"). The caller
    /// exits the process next, so wait for the frame to actually go out.
    pub fn shutdown(&self) {
        self.send(&json!({ "t": "shutdown" }));
        self.drain(Duration::from_secs(2));
    }
}

/// Owns the socket's write half. Serializes frames in queue order and dies with
/// the host connection.
fn spawn_write_loop(mut stream: TcpStream) -> Sender<OutMsg> {
    let (tx, rx) = mpsc::channel::<OutMsg>();
    thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                OutMsg::Frame(bytes) => {
                    if write_frame(&mut stream, &bytes).is_err() {
                        break; // host gone
                    }
                }
                OutMsg::Flush(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    });
    tx
}

fn spawn_read_loop(app: AppHandle, mut reader: TcpStream) {
    thread::spawn(move || loop {
        let frame = match read_frame(&mut reader) {
            Ok(f) => f,
            Err(_) => break, // host gone
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&frame) else { continue };
        match v.get("t").and_then(|t| t.as_str()) {
            Some("data") => {
                if let Ok(p) = serde_json::from_value::<DataPayload>(v) {
                    let _ = app.emit("pty://data", p);
                }
            }
            Some("exit") => {
                if let Ok(p) = serde_json::from_value::<ExitPayload>(v) {
                    let _ = app.emit("pty://exit", p);
                }
            }
            _ => {}
        }
    });
}

fn try_connect() -> Option<TcpStream> {
    let port: u16 = std::fs::read_to_string(port_file()).ok()?.trim().parse().ok()?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    // The host drops us if this is not the first frame and does not match the
    // token it published; nothing else on the connection works until it lands.
    let auth = serde_json::to_vec(&json!({ "t": "auth", "token": read_token() })).ok()?;
    write_frame(&mut stream, &auth).ok()?;
    Some(stream)
}

/// Connect to a running host, or spawn one (detached) and wait for it.
fn ensure_host() -> Option<TcpStream> {
    if let Some(s) = try_connect() {
        return Some(s);
    }
    spawn_host();
    for _ in 0..60 {
        thread::sleep(Duration::from_millis(50));
        if let Some(s) = try_connect() {
            return Some(s);
        }
    }
    None
}

/// Launch `this-exe --host` as an independent, window-less process that keeps
/// running after the GUI exits (that's what lets terminals survive an update).
fn spawn_host() {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            eprintln!("host: cannot resolve own exe path: {e}");
            return;
        }
    };
    // An exe whose backing file was replaced (an update) or moved reads back as
    // "<path> (deleted)" on Linux; spawning that path fails with ENOENT every
    // time. Strip the marker so we launch the file that is actually there.
    let exe = crate::update::intended_install_path(&exe);
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--host")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
    // Never swallow this: a host that does not spawn takes every terminal with
    // it, and the failure is otherwise completely silent.
    if let Err(e) = cmd.spawn() {
        eprintln!("host: failed to spawn {} --host: {e}", exe.display());
    }
}
