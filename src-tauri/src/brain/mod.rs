//! BigBrain — folded natively into PixelMarch.
//!
//! A local memory service (no Python, no external server — PixelMarch stays a
//! single portable exe). Notes are project-scoped `.md` files under `brain/` next
//! to the exe. An embedded HTTP server exposes the SAME API agents already know
//! from BigBrain (`/info`, `/recall`, `/remember`, `/keys`, `/memory/<p>/<k>`), so
//! any coding agent running in a PixelMarch terminal can use it via `curl` — point
//! it at `/info` and it catches on.
//!
//! ponytail: file-per-note on disk (the portable-files ethos, unchanged — every note
//! is still a plain `.md` you can read, edit or grep without PixelMarch) served from a
//! process-wide in-RAM index. Disk stays the source of truth: every writer writes the
//! file FIRST, then updates the index, both under the same lock. Reads never touch
//! disk. See the `in-RAM index` section below for the one behavioural consequence
//! (out-of-band edits are picked up by a rescan, not instantly).

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

/// MCP (Model Context Protocol) served from this same listener, same token — see
/// `mcp::rpc`. Every tool there is a thin wrapper over a function in this file, so
/// an MCP client and a `curl` see exactly one bus.
mod mcp;

/// Brain root: `brain/` in the profile (reuses the portable state dir).
fn root() -> PathBuf {
    crate::state::state_dir().unwrap_or_else(|_| PathBuf::from(".")).join("brain")
}

/// Default project when a request omits `project=` (matches BigBrain).
const DEFAULT_PROJECT: &str = "_system";

// ── store (file-per-note: brain/<project>/<key>.md) ─────────────────────────

/// Sanitize a project or key segment into a safe, round-trippable file/dir name:
/// path separators and odd chars become '-', so read and write always agree.
/// (BigBrain allows '/' in keys like `BigBrain/Info`; we flatten to `BigBrain-Info`.)
fn safe_seg(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if out.is_empty() { "_".into() } else { out }
}

fn note_path(project: &str, key: &str) -> PathBuf {
    root().join(safe_seg(project)).join(format!("{}.md", safe_seg(key)))
}

/// mtime as epoch seconds (for the `updated` field + recency sort). 0 if unknown.
fn updated_secs(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// File size in bytes, 0 if unknown. Paired with the mtime it is what the rescan
/// compares — mtime alone has one-second granularity, so an out-of-band edit made
/// within the same second as the last write would be invisible.
///
/// The pair is not a perfect fingerprint: an edit landing in the SAME second as the
/// snapshot AND leaving the file exactly as long reads as "unchanged", so the rescan
/// may hold a stale body for one more pass. It self-heals on the next differing
/// (mtime, len) — and in-process writes never rely on this, they update the index
/// directly under the write lock.
fn len_bytes(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

// ── in-RAM index ────────────────────────────────────────────────────────────
// Every read (note/keys/projects/recall/search/tasks) is served from here; disk is
// touched only by writers and by the rescan. Loaded by ONE disk walk on first use.
//
// WHY: a single `GET /recall?q=` used to read the WHOLE store off disk and re-tokenize
// every note body, and the GUI fires several of those a second. 3.2 MB and ~400 file
// opens per keystroke-adjacent request is what the typing lag was made of.
//
// THE ONE BEHAVIOURAL CHANGE — read this before blaming the index:
// the index is PER PROCESS, and PixelMarch runs two that read notes — the detached
// `--host` process (HTTP, i.e. every agent) and the GUI (the `brain_*` IPC commands).
// A write is instant in the process that made it (writers update the index under the
// same lock) but reaches the OTHER process only when that process next re-stats disk.
// Same for a note a human edits in a text editor. That is what `rescan_once()` is for,
// and `start_index_watch()` is what puts it on a thread — BOTH processes must call it,
// or the one that does not freezes at whatever disk held when it first read.
// CHOSEN over an mtime-check-per-read because a stat per note per request puts the
// ~400-syscall fan-out straight back on the read path — the exact cost the index exists
// to remove. Cross-process visibility is therefore bounded by the rescan gap below
// instead of instant, which is the one thing callers can notice.

/// Rescan pacing. The GUI's fastest note consumers poll at 400 ms (`swarmReset`) and
/// 1.5 s (`SwarmHealthStrip`), with SwarmChat/SwarmMission at 2 s, so worst-case staleness
/// for a swarm message is poll + rescan: at 500 ms that is 2.5 s against the 2 s it was
/// before the index, which is the closest a bounded scheme gets without paying per read.
const RESCAN_MIN: Duration = Duration::from_millis(500);
/// Upper bound once the store is big enough that passes get expensive.
const RESCAN_MAX: Duration = Duration::from_secs(2);
/// Sleep at least this many times the last pass's cost, so the watch can never take
/// more than 1/N of one core no matter how large the store grows. A stat-only pass over
/// today's ~400 notes is ~1 ms release, so this clamps to RESCAN_MIN until the store is
/// ~15x bigger; past that the gap stretches instead of the CPU bill.
const RESCAN_DUTY: u32 = 40;

/// One note as the index holds it.
struct Entry {
    value: String,
    /// mtime, epoch seconds — the same number `updated_secs` used to stat for.
    updated: u64,
    /// Size on disk, for change detection by the rescan.
    len: u64,
    /// Sorted, de-duplicated lowercase words of `key + " " + value`, precomputed at
    /// write time so a query never re-tokenizes a note body. Sorted so a prefix test
    /// is a binary search rather than a scan (`words_have_prefix`).
    words: Vec<String>,
    /// `parse_task` output, cached for `task-<n>` keys only. Keeps `tasks()` — and the
    /// once-per-second `/wait` loop of every idle agent — entirely off disk.
    task: Option<Value>,
}

/// project dir name -> key stem -> entry. BOTH segments are the `safe_seg` forms,
/// i.e. the exact strings the files on disk carry, so a write and the read that
/// follows it can never disagree. A project with no notes still gets an (empty) map:
/// `projects()` must keep listing note-less dirs.
type Notes = BTreeMap<String, BTreeMap<String, Entry>>;

fn index() -> &'static RwLock<Notes> {
    static IDX: OnceLock<RwLock<Notes>> = OnceLock::new();
    IDX.get_or_init(|| RwLock::new(load_from_disk()))
}

fn read_index() -> std::sync::RwLockReadGuard<'static, Notes> {
    index().read().unwrap_or_else(|e| e.into_inner())
}

fn write_index() -> std::sync::RwLockWriteGuard<'static, Notes> {
    index().write().unwrap_or_else(|e| e.into_inner())
}

/// Sorted, unique lowercase words — the precomputed token set behind every match.
fn sorted_words(text: &str) -> Vec<String> {
    let mut w = words_lower(text);
    w.sort();
    w.dedup();
    w
}

fn make_entry(key: &str, value: String, updated: u64, len: u64) -> Entry {
    let words = sorted_words(&format!("{key} {value}"));
    let task = key
        .strip_prefix("task-")
        .and_then(|n| n.parse::<u64>().ok())
        .map(|_| parse_task(key, &value, updated));
    Entry { value, updated, len, words, task }
}

/// One walk of `brain/`, building the whole index. Called once, lazily.
fn load_from_disk() -> Notes {
    let mut out: Notes = BTreeMap::new();
    let Ok(dirs) = std::fs::read_dir(root()) else { return out };
    for d in dirs.flatten() {
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project = d.file_name().to_string_lossy().into_owned();
        let mut notes: BTreeMap<String, Entry> = BTreeMap::new();
        if let Ok(files) = std::fs::read_dir(d.path()) {
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                // Sweep `write_atomic` temps orphaned by a crash between the write and
                // the rename. They are invisible to every walk (no `.md` suffix), which
                // is what keeps them from becoming phantom notes — and also means
                // nothing would ever remove them, so one kill -9 mid-write leaks a full
                // copy of a note forever. Only ones untouched for a minute: another
                // process may be filling its own temp right now and this walk holds no
                // lock on it.
                if name.starts_with('.') && name.contains(".tmp") {
                    let stale = f
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age.as_secs() >= 60);
                    if stale {
                        let _ = std::fs::remove_file(f.path());
                    }
                    continue;
                }
                let Some(key) = name.strip_suffix(".md") else { continue };
                let path = f.path();
                // Stat, read, stat again — and take the note only if the file did not
                // move underneath the read. Without this, a walk that overlaps a write
                // can capture a HALF-WRITTEN body together with the post-write mtime,
                // which then looks perfectly current to the rescan and gets installed
                // over the real value. (Caught by the bench test's 200 concurrent
                // writes: one note came back empty.)
                // IT NARROWS THE WINDOW, IT DOES NOT CLOSE IT — mtime has 1-second
                // granularity and a length can repeat, so a truncating writer can be
                // caught in a state that stats identical before and after. What closes
                // it is `write_atomic`: in-process writes rename a complete file into
                // place, so there is no partial state to read in the first place.
                let (updated, len) = (updated_secs(&path), len_bytes(&path));
                let Ok(value) = std::fs::read_to_string(&path) else { continue };
                if updated_secs(&path) != updated || len_bytes(&path) != len {
                    continue;
                }
                notes.insert(key.to_string(), make_entry(key, value, updated, len));
            }
        }
        out.insert(project, notes);
    }
    out
}

/// project dir name -> key stem -> (mtime, len). What one STAT-ONLY walk of the store
/// yields: no file is opened, no body is read, nothing is tokenized.
type Stats = BTreeMap<String, BTreeMap<String, (u64, u64)>>;

/// One walk of `brain/` that only stats. This is what every rescan pass runs;
/// reading and tokenizing whole bodies unconditionally would put the very cost the index
/// removes back on a timer (the real store is ~400 notes / 3.4 MB — a full re-read and
/// re-tokenize 30x a minute, at idle, all of it thrown away because nothing changed).
fn stat_walk() -> Stats {
    let mut out: Stats = BTreeMap::new();
    let Ok(dirs) = std::fs::read_dir(root()) else { return out };
    for d in dirs.flatten() {
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let project = d.file_name().to_string_lossy().into_owned();
        let mut notes: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        if let Ok(files) = std::fs::read_dir(d.path()) {
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                let Some(key) = name.strip_suffix(".md") else { continue };
                // One metadata call, not the two `updated_secs`/`len_bytes` would make.
                let Ok(m) = f.metadata() else { continue };
                let updated = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                notes.insert(key.to_string(), (updated, m.len()));
            }
        }
        out.insert(project, notes);
    }
    out
}

/// Re-stat the store and fold in anything that changed underneath us (a note edited
/// in a text editor, a project dir dropped in by hand).
///
/// STAT FIRST, READ SECOND: the walk only stats; a body is opened, read and tokenized
/// ONLY for a key whose (mtime, len) differs from the index or that the index lacks.
/// The common case — nothing changed — costs one stat per note and zero parsing.
/// Bodies are read OUTSIDE the lock, then re-stated while holding it: if the file moved
/// again in between the snapshot is dropped and the next pass picks it up, so this can
/// never install a stale value over a fresher in-process write.
///
/// Returns the number of notes it added, refreshed or dropped (0 = nothing changed,
/// the overwhelmingly common case).
pub fn rescan_once() -> usize {
    let disk = stat_walk();

    // Decide what needs reading while holding only a READ lock.
    let mut needed: Vec<(String, String, u64, u64)> = Vec::new();
    {
        let idx = read_index();
        for (project, disk_notes) in &disk {
            let cur = idx.get(project);
            for (key, (updated, len)) in disk_notes {
                let stale = match cur.and_then(|c| c.get(key)) {
                    Some(have) => have.updated != *updated || have.len != *len,
                    None => true,
                };
                if stale {
                    needed.push((project.clone(), key.clone(), *updated, *len));
                }
            }
        }
    }

    // Read the changed bodies with no lock held.
    let mut fresh: Vec<(String, String, Entry)> = Vec::new();
    for (project, key, updated, len) in needed {
        let path = note_path(&project, &key);
        let Ok(value) = std::fs::read_to_string(&path) else { continue };
        // Stat again — take the note only if the file did not move underneath the read.
        // Without this, a walk that overlaps a write can capture a HALF-WRITTEN body
        // together with the post-write mtime, which then looks perfectly current to the
        // next pass and gets installed over the real value. (Caught by the bench test's
        // 200 concurrent writes: one note came back empty.)
        // It NARROWS the window rather than closing it — a truncating writer can be
        // caught 0 bytes long and stat identical (0, same second) on both sides, which
        // is how an empty body once reached the index and made a live task vanish from
        // `tasks()`. `write_atomic` is what closes it for in-process writes.
        if updated_secs(&path) != updated || len_bytes(&path) != len {
            continue; // moved again mid-scan; next pass gets it
        }
        fresh.push((project, key.clone(), make_entry(&key, value, updated, len)));
    }

    let mut changed = 0usize;
    let mut idx = write_index();

    // Projects that vanished from disk. Guarded by an exists() check for the same
    // reason the note branch below is: `create_project` (or a `write_note` into a
    // fresh project) may have landed between the snapshot and this lock, and dropping
    // it here would make projects()/keys()/note() lie until the next pass.
    let gone: Vec<String> = idx
        .keys()
        .filter(|p| !disk.contains_key(*p) && !root().join(p).exists())
        .cloned()
        .collect();
    for p in gone {
        changed += idx.remove(&p).map(|n| n.len().max(1)).unwrap_or(0);
    }

    for (project, disk_notes) in &disk {
        // The snapshot may name a project `forget_project` has since removed; re-adding
        // it here would resurrect a deleted project in the index.
        if !root().join(project).exists() {
            continue;
        }
        let cur = idx.entry(project.clone()).or_default();
        let dropped: Vec<String> =
            cur.keys().filter(|k| !disk_notes.contains_key(*k)).cloned().collect();
        for k in dropped {
            // Only drop it if it really is absent from disk RIGHT NOW — an in-process
            // write may have landed between the snapshot and this lock.
            if !note_path(project, &k).exists() {
                cur.remove(&k);
                changed += 1;
            }
        }
    }

    for (project, key, e) in fresh {
        // Re-stat under the write lock. Gone since the snapshot (forget/forget_project)
        // or written again while we were reading: either way what we hold is not what
        // is on disk, so drop it and let the next pass take the real value. Without
        // this, an in-process write landing in the same second as the snapshot loses to
        // the body we read just before it.
        let path = note_path(&project, &key);
        if !path.exists() || updated_secs(&path) != e.updated || len_bytes(&path) != e.len {
            continue;
        }
        // And an in-process write with a strictly newer mtime always wins outright.
        let cur = idx.entry(project).or_default();
        let beaten = cur.get(&key).is_some_and(|have| have.updated > e.updated);
        if beaten {
            continue;
        }
        cur.insert(key, e);
        changed += 1;
    }
    changed
}

pub fn note(project: &str, key: &str) -> Option<String> {
    let idx = read_index();
    let e = idx.get(&safe_seg(project))?.get(&safe_seg(key))?;
    (!e.value.trim().is_empty()).then(|| e.value.clone())
}

/// A project's note keys (sanitized stems), sorted.
pub fn keys(project: &str) -> Vec<String> {
    read_index().get(&safe_seg(project)).map(|n| n.keys().cloned().collect()).unwrap_or_default()
}

/// Project names, sorted. EVERY project dir counts, including one with no notes
/// yet: a project created out-of-band used to be invisible until its first save,
/// so the panel showed nothing and users assumed the create had failed. The dir
/// on disk is the authority — which is why the index keeps an empty map for one.
fn projects() -> Vec<String> {
    read_index().keys().cloned().collect()
}

/// Create an empty project (just its dir). Paired with `projects()` listing
/// note-less dirs, this makes "new project" a real, visible state.
pub fn create_project(project: &str) -> std::io::Result<()> {
    let mut idx = write_index();
    std::fs::create_dir_all(root().join(safe_seg(project)))?;
    idx.entry(safe_seg(project)).or_default();
    Ok(())
}

fn row(project: &str, key: &str, value: String, updated: u64) -> Value {
    json!({ "project": project, "key": key, "value": value, "updated": updated })
}

/// Recall by exact `key`, or by query `q` (BigBrain semantics: every query token is
/// a prefix of some whole word in key+value). Rows sorted newest-first.
fn recall(project: &str, key: Option<&str>, q: Option<&str>) -> Vec<Value> {
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let mut rows: Vec<(u64, Value)> = Vec::new();
    match (key, q) {
        (Some(k), _) => {
            if let Some(e) = notes.get(&safe_seg(k)).filter(|e| !e.value.trim().is_empty()) {
                rows.push((e.updated, row(project, k, e.value.clone(), e.updated)));
            }
        }
        (None, Some(query)) => {
            let toks = tokens(query);
            if !toks.is_empty() {
                for (k, e) in notes {
                    if !e.value.trim().is_empty() && entry_hit(&toks, &e.words) {
                        rows.push((e.updated, row(project, k, e.value.clone(), e.updated)));
                    }
                }
            }
        }
        (None, None) => {}
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, r)| r).collect()
}

/// Notes in OTHER projects that also match `q` — appended to a recall so an agent
/// searching one project still learns a relevant note lives elsewhere. Pointer only
/// (project + key + a ready `recall` URL), marked `elsewhere:true`, newest-first, capped.
/// ponytail: served from the in-RAM index against precomputed token sets, so a broad
/// query is map walks and binary searches rather than a full disk scan; the cap still
/// stops one dumping the store.
fn cross_project(exclude: &str, q: &str) -> Vec<Value> {
    const MAX: usize = 8;
    let toks = tokens(q);
    if toks.is_empty() {
        return Vec::new();
    }
    let idx = read_index();
    let skip = safe_seg(exclude);
    let mut rows: Vec<(u64, Value)> = Vec::new();
    for (p, notes) in idx.iter() {
        if *p == skip {
            continue;
        }
        for (k, e) in notes {
            // project-scoped bookkeeping notes (canonical settings, /claude-clear
            // handoffs) are noise outside their own project — never point at them.
            if k == "project_settings" || k == "session-handoff" {
                continue;
            }
            if !e.value.trim().is_empty() && entry_hit(&toks, &e.words) {
                let u = e.updated;
                rows.push((u, json!({
                    "elsewhere": true, "project": p, "key": k, "updated": u,
                    "recall": format!("/recall?project={p}&key={k}"),
                })));
            }
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().take(MAX).map(|(_, r)| r).collect()
}

/// Keys a whole-body note write must never land on, because the BODY IS STRUCTURE
/// somebody else parses.
///
/// A task note is the task's STATE: `parse_task` reads its `status:/role:/owner:/files:`
/// header, and a plain note write replaces the whole file, header included. That is not
/// theoretical — a builder whose `task_status` call it could not get through wrote
/// `{"status":"done","log":"…"}` (the tool's ARGUMENTS) into note `task-2` with
/// `note_set`. The header vanished, so the bus read the finished task as
/// `open / owner - / files -`: the work looked unstarted, its file scope was released
/// for anyone to claim, the reviewer's `approved` was refused ("only a done task can be
/// approved"), and the owner reported the task "not found on server" because no
/// owner filter matched it any more. Nothing in the store said a thing.
///
/// Protocol notes are the same shape of hazard one level up — the host seeds them once
/// per swarm and every agent reads them as the contract, so an agent overwriting one
/// (note `protocol-core` came back as the single byte `1`) rewrites the rules the rest
/// of the swarm is following. The host's own seeding goes through `write_note`/`brain_save`
/// and is unaffected; so is a human editing one in the note manager.
///
/// The refusal is deliberately NOT a silent repair: the caller reached for the wrong
/// door and gets told which one is right, with the state intact behind it.
fn note_write_refusal(key: &str, actor: Option<&Actor>) -> Option<Value> {
    let k = safe_seg(key);
    if k.strip_prefix("task-").is_some_and(|n| n.parse::<u64>().is_ok()) {
        return Some(json!({
            "ok": false, "reason": "task note is task state", "key": k,
            "hint": "a whole-body write erases the status/role/owner/files header — move the task with task_status (POST /task-status?project=&task=&status=&log=), take it with task_claim, and edit only its text with note_patch"
        }));
    }
    if actor.is_some() && k.starts_with("protocol-") {
        return Some(json!({
            "ok": false, "reason": "protocol note is host-owned", "key": k,
            "hint": "the swarm protocol is written once by PixelMarch and read by every agent — you cannot rewrite the contract; if it is wrong, say so in chat"
        }));
    }
    None
}

/// Trusted-caller shim (tests): same as [`remember_as`] with no actor. Every live
/// caller is an HTTP/MCP door and passes the actor it authenticated.
#[cfg(test)]
fn remember(project: &str, key: &str, value: &str, override_: bool) -> Value {
    remember_as(project, key, value, override_, None)
}

/// Upsert a note. Without `override`, refuses (ok:false) when a different key holds
/// very similar content — the caller reuses that key or resends with override:true.
/// Keys that carry structure somebody else parses are refused outright
/// ([`note_write_refusal`]).
fn remember_as(project: &str, key: &str, value: &str, override_: bool, actor: Option<&Actor>) -> Value {
    if let Some(refusal) = note_write_refusal(key, actor) {
        return refusal;
    }
    if !override_ {
        let sim = similar(project, key, value);
        if !sim.is_empty() {
            return json!({
                "ok": false, "reason": "possible duplicate", "project": project, "key": key,
                "similar": sim,
                "hint": "reuse one of the keys in \"similar\" (remember upserts to refine it), or resend with \"override\": true to save as a new note"
            });
        }
    }
    match write_note(project, key, value) {
        Ok(_) => json!({ "ok": true, "project": project, "key": safe_seg(key) }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Raw upsert of a note file (creates the project dir). Used by the HTTP
/// `remember`, the path-shortcut `POST /memory/<p>/<k>`, the task writers and the
/// `brain_save` IPC command — i.e. EVERY note write in the process goes through here.
/// Disk first, then the index, both under the index's write lock: an index that lies
/// about one note is worse than no index at all, so there is exactly one door.
///
/// THE WRITE IS ATOMIC — a complete temp file renamed over the target, never a
/// truncate-then-fill in place. The index write lock does NOT protect the file: the
/// rescan reads bodies with no lock held (deliberately — that is what keeps an idle
/// pass off the CPU), so an in-place write publishes a window in which the file is 0
/// bytes long. A rescan landing in it read an empty body AND stat-ed 0 both before and
/// after, so its stat-read-stat guard saw a perfectly consistent empty file and
/// installed it. Every read is served from the index, and `note`/`tasks` treat an empty
/// body as no note at all, so a live task went briefly ABSENT from `/tasks` — a false
/// negative for anything that reads "not in the list" as "does not exist" (claim
/// guards, orphan sweeps, plan gates). `rename` gives readers only the old file or the
/// new one, never a half of either. Pinned by
/// `a_rescan_beside_a_write_never_publishes_an_empty_body`.
pub fn write_note(project: &str, key: &str, value: &str) -> std::io::Result<()> {
    let p = note_path(project, key);
    let mut idx = write_index();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_atomic(&p, value)?;
    let (updated, len) = (updated_secs(&p), len_bytes(&p));
    let key = safe_seg(key);
    idx.entry(safe_seg(project))
        .or_default()
        .insert(key.clone(), make_entry(&key, value.to_string(), updated, len));
    Ok(())
}

/// Write `value` to `path` so no reader can ever see a partial file: fill a temp
/// sibling, then `rename` it over the target (atomic on unix, `MOVEFILE_REPLACE_EXISTING`
/// on Windows). The temp name deliberately does NOT end in `.md`, so the store walks
/// (`stat_walk`, `load_from_disk`) skip it and a temp left behind by a crash is invisible
/// rather than a phantom note — `load_from_disk` also sweeps stale ones, since nothing
/// else ever would. It is unique per (process, call) because concurrent writers to two
/// different notes share the directory.
///
/// THE ATOMICITY IS FOR IN-PROCESS WRITES — which is every write this app makes, because
/// `write_note` is the only door. It says nothing about a note file written by ANOTHER
/// process, and that is a real case (`the_watch_thread_makes_another_processs_write_visible`):
/// an outside writer truncates in place, and the rescan's stat-read-stat guard is all that
/// stands between it and a torn read. That guard narrows the window, it does not close it.
///
/// The fallback matters on Windows, where a rename can lose to another process holding
/// the destination open: a note that fails to save is worse than one saved through the
/// old racy path, so the last resort is the plain in-place write.
fn write_atomic(path: &Path, value: &str) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp{}-{n}", std::process::id()));
    match std::fs::write(&tmp, value).and_then(|_| std::fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, value).map_err(|_| e)
        }
    }
}

/// Raw delete of one note file + its index entry. The other half of `write_note`:
/// `brain_delete` used to call `fs::remove_file` itself, which would leave the note
/// alive in RAM forever.
pub fn delete_note(project: &str, key: &str) -> std::io::Result<()> {
    let mut idx = write_index();
    std::fs::remove_file(note_path(project, key))?;
    if let Some(notes) = idx.get_mut(&safe_seg(project)) {
        notes.remove(&safe_seg(key));
    }
    Ok(())
}

fn forget(project: &str, key: &str) -> Value {
    let deleted = delete_note(project, key).is_ok();
    json!({ "ok": true, "deleted": deleted as u8 })
}

pub fn forget_project(project: &str) -> Value {
    let mut idx = write_index();
    let dir = root().join(safe_seg(project));
    let _ = std::fs::remove_dir_all(&dir);
    // Drop the index entry only if the files really went. A failed remove_dir_all that
    // still evicted the index would leave the index claiming the project is gone while
    // every note is still on disk — and the rescan would then read it all back anyway.
    if dir.exists() {
        return json!({ "ok": false, "project": project, "deleted": 0 });
    }
    let n = idx.remove(&safe_seg(project)).map(|n| n.len()).unwrap_or(0);
    json!({ "ok": true, "project": project, "deleted": n })
}

// ── task bus (swarm M2 — see swarm.md) ──────────────────────────────────────
// Tasks are ordinary notes keyed `task-<n>` so they stay visible in every
// existing surface (Manage tab, /recall, curl). The endpoints below add the one
// thing plain notes can't give concurrent agents: an ATOMIC claim. All task
// mutations serialize on TASK_LOCK (the brain lives in exactly one process — the
// host — so a process-wide mutex is sufficient).

static TASK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A task note whose header did not survive. NOT "open": a headerless note used to
/// parse as a fresh open task, so a clobbered `done` task silently re-entered the bus
/// as claimable work with no owner and no file scope (see `note_write_refusal`). It is
/// a status of its own so the state is legible instead of plausible — the bus shows it,
/// `claim_task` refuses it, and the host nags the coordinator to rebuild the header.
pub const MALFORMED: &str = "malformed";

/// A task a HUMAN killed from the mission board. Terminal and host-only: agents
/// cannot post it (it is not in their status vocabulary) and cannot move a task
/// OFF it — the point of a cancel is that the work stops and stays stopped. The
/// branch and worktree are deliberately left alone: cancelling ends the agent's
/// turn, it does not throw away commits a human may still want.
pub const CANCELLED: &str = "cancelled";

/// Header lines every task note starts with; anything after is the description.
fn parse_task(key: &str, value: &str, updated: u64) -> Value {
    let mut status = MALFORMED.to_string();
    let mut owner = String::new();
    let mut files = String::new();
    let mut role = String::new();
    let mut desc_at = 0usize;
    for (i, line) in value.lines().enumerate() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("status:") {
            let v = v.trim();
            // An empty `status:` is as headerless as no line at all.
            status = if v.is_empty() { MALFORMED.to_string() } else { v.to_string() };
        }
        else if let Some(v) = l.strip_prefix("owner:") { owner = v.trim().trim_matches('-').trim().to_string(); }
        else if let Some(v) = l.strip_prefix("files:") { files = v.trim().to_string(); }
        else if let Some(v) = l.strip_prefix("role:") { role = v.trim().trim_matches('-').trim().to_string(); }
        else if !l.is_empty() { desc_at = i; break; }
        desc_at = i + 1;
    }
    let desc: String = value.lines().skip(desc_at).collect::<Vec<_>>().join("\n").trim().to_string();
    json!({ "key": key, "status": status, "role": role, "owner": owner, "files": files, "desc": desc, "updated": updated })
}

fn render_task(status: &str, role: &str, owner: &str, files: &str, desc: &str) -> String {
    let role = if role.is_empty() { "-" } else { role };
    let owner = if owner.is_empty() { "-" } else { owner };
    let files = if files.is_empty() { "-" } else { files };
    format!("status: {status}\nrole: {role}\nowner: {owner}\nfiles: {files}\n\n{desc}\n")
}

/// The role a task belongs to; untagged tasks are builder work.
fn task_role(t: &Value) -> String {
    let r = t["role"].as_str().unwrap_or("").to_string();
    if r.is_empty() { "builder".to_string() } else { r }
}

/// "builder-2" matches role "builder"; "scout" matches role "scout".
fn role_matches(owner: &str, role: &str) -> bool {
    owner == role || owner.starts_with(&format!("{role}-"))
}

/// Plain-text task list for cheap agent polling: one task per line
/// (`key | status | role | owner | files | first desc line`), empty body = no tasks.
/// A fraction of the tokens of the pretty JSON and trivially grep-able.
fn compact_tasks(rows: &[Value]) -> String {
    rows.iter()
        .map(|t| {
            let f = |k: &str| t[k].as_str().unwrap_or("").to_string();
            let dash = |s: String| if s.is_empty() { "-".to_string() } else { s };
            let desc = f("desc");
            let first = desc.lines().next().unwrap_or("");
            format!("{} | {} | {} | {} | {} | {}\n", f("key"), f("status"), task_role(t), dash(f("owner")), dash(f("files")), first)
        })
        .collect()
}

/// Task list narrowed by the query's `status=` (csv), `role=` (untagged = builder),
/// `owner=` (exact) and `mine=` (unowned OR owned by me — "claimable/actionable by me")
/// filters. Shared by GET /tasks and the /wait long-poll. `mine=` exists because a
/// task left `open` with a stale owner made every other builder's /wait fire
/// instantly on work it could never claim (busy loop, live BREAKPOINT run).
fn filtered_tasks(pairs: &[(String, String)]) -> Vec<Value> {
    let project = qget(pairs, "project").unwrap_or_else(|| DEFAULT_PROJECT.to_string());
    let mut rows = tasks(&project);
    if let Some(filter) = qget(pairs, "status") {
        let want: Vec<String> = filter.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
        if !want.is_empty() {
            rows.retain(|t| want.iter().any(|w| t["status"].as_str().unwrap_or("") == w));
        }
    }
    if let Some(role) = qget(pairs, "role") {
        rows.retain(|t| task_role(t) == role.trim().to_lowercase());
    }
    if let Some(owner) = qget(pairs, "owner") {
        rows.retain(|t| t["owner"].as_str().unwrap_or("") == owner.trim());
    }
    if let Some(mine) = qget(pairs, "mine") {
        let me = mine.trim().to_string();
        rows.retain(|t| {
            let o = t["owner"].as_str().unwrap_or("");
            o.is_empty() || o == me
        });
    }
    rows
}

/// All `task-<n>` notes of a project, parsed, sorted by n. Served from the cached
/// `parse_task` output in the index — this is the hot one: every `/tasks`, `/claim`,
/// `/task-status` and every idle agent's once-per-second `/wait` tick lands here.
fn tasks(project: &str) -> Vec<Value> {
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let mut rows: Vec<(u64, Value)> = notes
        .iter()
        .filter_map(|(k, e)| {
            let n: u64 = k.strip_prefix("task-")?.parse().ok()?;
            if e.value.trim().is_empty() {
                return None;
            }
            Some((n, e.task.clone()?))
        })
        .collect();
    rows.sort_by_key(|(n, _)| *n);
    rows.into_iter().map(|(_, r)| r).collect()
}

/// Statuses whose `files` are LIVE scope — someone is (or is about to be) editing
/// them. A merged/approved/done/blocked task has released its files, so it must not
/// block a follow-up task over the same paths.
///
/// KNOWN SOFT SPOT: `blocked` is also the DEFAULT status of a freshly created builder
/// task (a batch is posted blocked, then opened), so two blocked tasks over one file
/// are not caught until one of them is opened — at which point creating the second is
/// already refused. Adding "blocked" here would close that, at the cost of a parked
/// task holding scope forever; the current call is the one brain-findings 2.1 asks for.
const LIVE_SCOPE_STATUSES: [&str; 3] = ["open", "claimed", "changes"];

/// One `files` entry, normalised for comparison: trimmed, unquoted, `\` → `/`,
/// lower-cased, `./` and duplicate/edge slashes gone. `-` is the on-disk placeholder
/// for "no files" (see `render_task`) and normalises to nothing.
fn normalize_scope_path(raw: &str) -> String {
    let mut p = raw.trim().trim_matches(['"', '\'']).trim().replace('\\', "/").to_lowercase();
    if p == "-" {
        return String::new();
    }
    while let Some(rest) = p.strip_prefix("./") {
        p = rest.trim_start().to_string();
    }
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    p.trim_matches('/').to_string()
}

/// A task's `files` field as a normalised, de-duplicated path set. The field is a
/// comma-separated list written by hand by an LLM, so ` src/lib/swarm.ts ` and
/// `src/lib/swarm.ts` are the SAME path and must compare equal.
fn scope_paths(files: &str) -> Vec<String> {
    let mut out: Vec<String> = files.split(',').map(normalize_scope_path).filter(|p| !p.is_empty()).collect();
    out.sort();
    out.dedup();
    out
}

/// Two scope entries collide when they are the same path, or when one is a
/// directory containing the other (`src/brain` owns `src/brain/mod.rs`).
fn scopes_overlap(a: &str, b: &str) -> bool {
    a == b || b.starts_with(&format!("{a}/")) || a.starts_with(&format!("{b}/"))
}

/// The THIRD leg of the control plane. The claim guard makes "two owners, one task"
/// impossible; this makes "two tasks, one scope" impossible. Live failure it exists
/// for (notes two-builders-one-scope, salvage-task-11-branch): a coordinator created
/// a NEW task for files a builder was mid-edit on, both builders shipped the same
/// feature, and one complete implementation was thrown away.
///
/// Returns the refusal for the FIRST live task whose files overlap `files`, naming
/// the task that owns them and the sanctioned way to change scope. No `files` at all
/// stays permissive — plenty of real tasks (docs, decisions) declare no paths.
fn scope_conflict(project: &str, files: &str) -> Option<Value> {
    let want = scope_paths(files);
    if want.is_empty() {
        return None;
    }
    for t in tasks(project) {
        let status = t["status"].as_str().unwrap_or("");
        if !LIVE_SCOPE_STATUSES.contains(&status) {
            continue;
        }
        let held = scope_paths(t["files"].as_str().unwrap_or(""));
        let hits: Vec<String> = want.iter().filter(|w| held.iter().any(|h| scopes_overlap(w, h))).cloned().collect();
        if hits.is_empty() {
            continue;
        }
        let key = t["key"].as_str().unwrap_or("");
        let owner = t["owner"].as_str().unwrap_or("");
        let owned_by = if owner.is_empty() { String::new() } else { format!(" (owner {owner})") };
        return Some(json!({
            "ok": false,
            "reason": "scope overlap",
            "task": key,
            "status": status,
            "owner": owner,
            "overlap": hits,
            "hint": format!(
                "{key} is {status}{owned_by} and already owns {} — a second task over the same files is how a swarm ships two competing implementations and throws one away. \
To change that scope, patch {key}'s desc (note_patch on {key}) or post a correction-{key}-scope note; do not create a new task for files an existing one owns.",
                hits.join(", ")
            ),
        }));
    }
    None
}

/// Create `task-<next n>`. Locked so two concurrent creators can't share an n.
/// Builder tasks default to `blocked` when no status is given — a coordinator posting a
/// batch must explicitly open tasks once the whole batch (and the plan note) is up, so
/// builders can't grab work mid-batch. Scout tasks default `open` (they're requested
/// before the plan exists).
/// Trusted-caller shim (IPC, tests): same as [`create_task_as`] with no actor.
#[cfg(test)]
fn create_task(project: &str, desc: &str, files: &str, status: &str, role: &str) -> Value {
    create_task_as(project, desc, files, status, role, None)
}

fn create_task_as(project: &str, desc: &str, files: &str, status: &str, role: &str, actor: Option<&Actor>) -> Value {
    // Tasks come from the coordinator (or the trusted host/human). A builder
    // inventing its own task is a builder inventing its own scope.
    if let Some(a) = actor {
        if a.project != project {
            return json!({ "ok": false, "reason": "wrong project", "actor": a.role, "hint": format!("your token is for project \"{}\"", a.project) });
        }
        if a.role != "coordinator" {
            return json!({ "ok": false, "reason": "coordinator only", "actor": a.role, "hint": "tasks are created by the coordinator — message it via chat if you need one" });
        }
    }
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Inside the lock: the overlap check and the write that would create the overlap
    // must not interleave with a concurrent creator's.
    if let Some(refusal) = scope_conflict(project, files) {
        return refusal;
    }
    let next = keys(project)
        .iter()
        .filter_map(|k| k.strip_prefix("task-")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let key = format!("task-{next}");
    let status = if status.is_empty() {
        if role == "scout" { "open" } else { "blocked" }
    } else {
        status
    };
    match write_note(project, &key, &render_task(status, role, "", files, desc)) {
        Ok(_) => {
            let mut out = json!({ "ok": true, "project": project, "key": key, "status": status, "role": if role.is_empty() { "builder" } else { role } });
            // A swarm project always has a "mission" note. Landing a task in one
            // that doesn't is almost always a typo'd/stale project name — the
            // task is written (nothing is lost) but say so loudly, with the
            // projects that DO look like live swarms.
            if note(project, "mission").is_none() {
                let live: Vec<String> = projects().into_iter().filter(|p| note(p, "mission").is_some()).collect();
                out["warning"] = json!(format!(
                    "project \"{project}\" has no \"mission\" note — is that the right swarm? the task was still created"
                ));
                if !live.is_empty() {
                    out["projects_with_a_mission"] = json!(live);
                }
            }
            out
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Atomic claim: succeeds only if the task is currently `open` and unowned — or
/// `open` and already owned by the claimant (a task re-opened for rework stays
/// with its builder; without this the owner itself couldn't re-claim it).
/// The claimant's role must match the task's role (untagged tasks are builders').
///
/// An AGENT claims as itself, whatever `owner` it sent: the actor's role IS the
/// owner, so no pane can claim on another pane's behalf.
#[cfg(test)]
fn claim_task(project: &str, task: &str, owner: &str) -> Value {
    claim_task_as(project, task, owner, None)
}

fn claim_task_as(project: &str, task: &str, owner: &str, actor: Option<&Actor>) -> Value {
    let owner = match actor {
        Some(a) if a.project != project => {
            return json!({ "ok": false, "reason": "wrong project", "actor": a.role, "hint": format!("your token is for project \"{}\"", a.project) });
        }
        Some(a) => a.role.as_str(),
        None => owner,
    };
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(v) = note(project, task) else {
        return json!({ "ok": false, "error": format!("no task {task}"), "hint": "GET /tasks?project= lists them" });
    };
    let t = parse_task(task, &v, 0);
    let (status, cur_owner) = (t["status"].as_str().unwrap_or(""), t["owner"].as_str().unwrap_or(""));
    if status != "open" || !(cur_owner.is_empty() || cur_owner == owner) {
        // A task handed back to its own builder is refused here on purpose —
        // /claim is the fresh-claim path — but "pick another open task" sent that
        // builder to an empty bus and it stopped, wake after wake, while its
        // rework never started (note swarm-changes-wake-builder-loop). Name the
        // retake call instead: the task is already the caller's.
        let hint = if status == "changes" && cur_owner == owner {
            format!("this one is YOURS to redo - retake it with task_status {{task: \"{task}\", status: \"claimed\", owner: \"{owner}\"}}, fix it on branch swarm/{task}, then post done")
        } else {
            "pick another open task".to_string()
        };
        return json!({ "ok": false, "reason": "not claimable", "status": status, "owner": cur_owner, "hint": hint });
    }
    let role = task_role(&t);
    if !role_matches(owner, &role) {
        return json!({ "ok": false, "reason": "role mismatch", "role": role, "hint": format!("{task} is {role} work — leave it for a {role} and pick a task matching your role") });
    }
    // Builder work is claimable only once the coordinator has posted the plan note —
    // hard guard against builders jumping on tasks created mid-batch. Scout tasks are
    // exempt (scouting happens before the plan exists). Review flow is unaffected:
    // approved/changes/re-claims all ride /task-status, never /claim.
    if role == "builder" && note(project, "plan").is_none() {
        return json!({ "ok": false, "reason": "no plan yet", "hint": "the coordinator hasn't posted the plan note — keep waiting, tasks open after the plan is up" });
    }
    let files = t["files"].as_str().unwrap_or("");
    let desc = t["desc"].as_str().unwrap_or("");
    match write_note(project, task, &render_task("claimed", t["role"].as_str().unwrap_or(""), owner, files, desc)) {
        Ok(_) => json!({ "ok": true, "project": project, "key": task, "status": "claimed", "owner": owner }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Transition a task's status (done/approved/changes/blocked/open/…), optionally
/// reassigning owner and appending a log line to the description.
///
/// With an AGENT actor the transition table (`lifecycle_refusal`) gates the
/// write and the client-sent `owner` is ignored — the actor cannot reassign
/// ownership or speak as someone else, and the log line is attributed to the
/// actor, not to whoever the caller claims to be. `as_who` names a trusted
/// caller in the log ("host" for PixelMarch's own merges) without touching the
/// stored owner.
#[cfg(test)]
fn set_task_status(project: &str, task: &str, status: &str, owner: Option<&str>, log: &str) -> Value {
    set_task_status_as(project, task, status, owner, log, None, None)
}

fn set_task_status_as(project: &str, task: &str, status: &str, owner: Option<&str>, log: &str, actor: Option<&Actor>, as_who: Option<&str>) -> Value {
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(v) = note(project, task) else {
        return json!({ "ok": false, "error": format!("no task {task}") });
    };
    let t = parse_task(task, &v, 0);
    let cur_owner = t["owner"].as_str().unwrap_or("").to_string();
    if let Some(refusal) = lifecycle_refusal(actor, project, t["status"].as_str().unwrap_or(""), &cur_owner, status) {
        return refusal;
    }
    let owner = match actor {
        Some(_) => cur_owner.as_str(), // agents never reassign — the guard above already ruled on ownership
        None => owner.unwrap_or(cur_owner.as_str()),
    };
    let who = actor.map(|a| a.role.as_str()).or(as_who).unwrap_or(owner);
    let files = t["files"].as_str().unwrap_or("");
    let mut desc = t["desc"].as_str().unwrap_or("").to_string();
    if !log.trim().is_empty() {
        desc = format!("{desc}\n[{status} by {who}] {}", log.trim());
    }
    match write_note(project, task, &render_task(status, t["role"].as_str().unwrap_or(""), owner, files, &desc)) {
        Ok(_) => json!({ "ok": true, "project": project, "key": task, "status": status, "owner": owner }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── agent chat + reset requests ─────────────────────────────────────────────
//
// Both were conventions rather than APIs: a swarm message was a note named
// `chat-<sender>-<n>` whose FIRST LINE happened to read `to: <role>`, and a
// context reset was a note named `reset-<role>`. Every reader re-derived that
// convention for itself — the dispatcher scanned note keys with a prefix test and
// re-parsed the `to:` header out of prose, which is a parser living in the wrong
// process and a routing rule nobody owns.
//
// So the STORAGE stays exactly what it was — the same note keys, the same bodies,
// still plain `.md` files, still visible to `/keys`, `/recall`, the feed and the
// Coordinator tab, so a `curl`-only pane keeps working unchanged and no message
// ever written is orphaned — and the PARSING moves in here, behind typed reads
// (`GET /chat`, `GET /resets`, the `chat_inbox` MCP tool). Callers get rows with
// `from`/`to`/`text` already split out; nobody downstream needs to know the
// convention exists.
//
// NOT an in-process ring like the agent-event store above: an event says "a turn
// ended" and is worthless a minute later, while a chat message is the durable
// record a human scrolls back through and MUST survive a host restart.

/// `chat-<from>-<n>` → (`from`, `n`). `from` may itself contain '-' ("builder-1"),
/// so the split is from the RIGHT: the trailing number is the only fixed part.
fn parse_chat_key(key: &str) -> Option<(String, u64)> {
    let rest = key.strip_prefix("chat-")?;
    let (from, n) = rest.rsplit_once('-')?;
    if from.is_empty() {
        return None;
    }
    Some((from.to_string(), n.parse().ok()?))
}

/// A chat note body → (`to`, `text`, `addressed`). The `to:` header is optional; a
/// body without one is treated as "all" rather than dropped, because the
/// alternative is a message that exists on disk and reaches nobody. `addressed`
/// says whether the header was actually there, so a caller that would rather NOT
/// broadcast a headerless note can tell the two apart (the dispatcher's old rule).
fn split_chat_body(body: &str) -> (String, String, bool) {
    let mut lines = body.lines();
    let first = lines.next().unwrap_or("");
    match first.trim().strip_prefix("to:").or_else(|| first.trim().strip_prefix("To:")) {
        Some(to) => {
            let to = to.trim().to_lowercase();
            let text = lines.collect::<Vec<_>>().join("\n").trim().to_string();
            (if to.is_empty() { "all".into() } else { to }, text, true)
        }
        None => ("all".to_string(), body.trim().to_string(), false),
    }
}

/// The `to:` header split into the roles it actually addresses. The header is a
/// '|'-separated LIST — `to: builder-2|reviewer-1` is a real message shape the
/// swarm sends — so matching it as one opaque string delivers it to nobody.
/// Empty segments are dropped; an empty result means "all".
fn chat_targets(to: &str) -> Vec<String> {
    let out: Vec<String> = to
        .split('|')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if out.is_empty() { vec!["all".to_string()] } else { out }
}

/// Every chat message of a project, oldest first, with the convention already
/// parsed off: `{key, from, n, to, targets, text, updated}`. `to` is the raw
/// header, `targets` the parsed list — no caller downstream re-parses either.
fn chat_rows(project: &str) -> Vec<Value> {
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let mut rows: Vec<Value> = notes
        .iter()
        .filter_map(|(k, e)| {
            let (from, n) = parse_chat_key(k)?;
            if e.value.trim().is_empty() {
                return None;
            }
            let (to, text, addressed) = split_chat_body(&e.value);
            let targets = chat_targets(&to);
            Some(json!({ "key": k, "from": from, "n": n, "to": to, "targets": targets, "addressed": addressed, "text": text, "updated": e.updated }))
        })
        .collect();
    // Wall-clock order, tie-broken on (from, n): mtime has one-second granularity
    // and a busy swarm posts several messages inside one second. The tie-break is
    // the sequence number, NOT the key — `chat-x-10` sorts before `chat-x-2` as a
    // string.
    rows.sort_by(|a, b| {
        let t = |v: &Value| v["updated"].as_u64().unwrap_or(0);
        let f = |v: &Value| v["from"].as_str().unwrap_or("").to_string();
        let n = |v: &Value| v["n"].as_u64().unwrap_or(0);
        t(a).cmp(&t(b)).then_with(|| f(a).cmp(&f(b))).then_with(|| n(a).cmp(&n(b)))
    });
    rows
}

/// Post one message. Numbering is per sender and takes `TASK_LOCK`, so two panes
/// posting at once can't land on the same `chat-<from>-<n>` and lose one.
/// An AGENT always sends as itself — its `from` is the actor's role, whatever
/// the caller wrote, so no pane can put words in another pane's mouth.
fn chat_send(project: &str, from: &str, to: &str, text: &str) -> Value {
    chat_send_as(project, from, to, text, None)
}

fn chat_send_as(project: &str, from: &str, to: &str, text: &str, actor: Option<&Actor>) -> Value {
    let from = actor.map(|a| a.role.as_str()).unwrap_or(from);
    let from = if from.trim().is_empty() { "unknown" } else { from.trim() };
    let to = if to.trim().is_empty() { "all" } else { to.trim() };
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let next = keys(project)
        .iter()
        .filter_map(|k| parse_chat_key(k))
        .filter(|(f, _)| f == from)
        .map(|(_, n)| n)
        .max()
        .unwrap_or(0)
        + 1;
    let key = format!("chat-{from}-{next}");
    // The stored body keeps the historical shape — first line `to: <role>` — so a
    // pane still reading these as notes sees what it has always seen.
    match write_note(project, &key, &format!("to: {to}\n{}\n", text.trim())) {
        Ok(_) => json!({ "ok": true, "project": project, "key": key, "from": from, "to": to.to_lowercase() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Messages addressed to `role` — named in the `to:` list, or the `all`
/// broadcast — with anything the role sent itself left out. A header naming
/// several roles (`to: builder-2|reviewer-1`) reaches every one of them.
/// `since` is an epoch-seconds cursor (exclusive); it is as coarse as mtime, so
/// a caller polling faster than 1 Hz should de-duplicate on `key` rather than
/// trust it alone.
fn chat_inbox(project: &str, role: &str, since: u64) -> Vec<Value> {
    let role = role.trim().to_lowercase();
    chat_rows(project)
        .into_iter()
        .filter(|m| {
            let from = m["from"].as_str().unwrap_or("").to_lowercase();
            let addressed = m["targets"]
                .as_array()
                .map(|ts| ts.iter().any(|t| matches!(t.as_str(), Some(s) if s == role || s == "all")))
                .unwrap_or(false);
            from != role && addressed && m["updated"].as_u64().unwrap_or(0) > since
        })
        .collect()
}

/// A role asking to be re-briefed with a fresh context. Same `reset-<role>` note
/// the reset watcher has always consumed — the tool is a name for it, not a
/// replacement store. An AGENT resets itself only.
#[cfg(test)]
fn reset_request(project: &str, role: &str) -> Value {
    reset_request_as(project, role, None)
}

fn reset_request_as(project: &str, role: &str, actor: Option<&Actor>) -> Value {
    let role = actor.map(|a| a.role.as_str()).unwrap_or(role);
    let role = role.trim();
    if role.is_empty() {
        return json!({ "ok": false, "error": "need role" });
    }
    let key = format!("reset-{role}");
    match write_note(project, &key, "ready") {
        Ok(_) => json!({ "ok": true, "project": project, "key": key, "role": role }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Outstanding reset requests: `{role, key, state, updated}`, oldest first.
fn reset_requests(project: &str) -> Vec<Value> {
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let mut rows: Vec<Value> = notes
        .iter()
        .filter_map(|(k, e)| {
            let role = k.strip_prefix("reset-")?;
            if role.is_empty() || e.value.trim().is_empty() {
                return None;
            }
            Some(json!({ "key": k, "role": role, "state": e.value.trim(), "updated": e.updated }))
        })
        .collect();
    rows.sort_by_key(|r| r["updated"].as_u64().unwrap_or(0));
    rows
}

// ── scope reclaim: requested here, PERFORMED by the host ────────────────────
//
// brain-findings 2.2: last run's duplication landed because the coordinator's
// "please stop" chat reached the second builder AFTER it had already started
// (salvage-task-11-branch). A chat message is not a lock — it is a request that
// costs a turn to read and may be read too late, or never.
//
// So reassignment goes through the control plane instead, in TWO halves that
// must not be separable:
//   1. the COORDINATOR requests it here — `reclaim-<task>` records who loses the
//      scope and who gets it, and NOTHING is flipped yet;
//   2. PixelMarch performs it — it fences the losing pane (no further turn can
//      be injected into it), calls `reclaim_task` below to flip the owner, and
//      wipes that pane's context, as one operation (src/lib/swarmReset.ts).
// The flip deliberately does NOT happen on the request: the brain cannot reset a
// pane, so a brain-side flip would reassign the task while the losing builder
// was still free to take another turn — exactly the window that produced the
// duplicate work.

/// Statuses a task can be reclaimed FROM. done/approved/merged have left the
/// builder's hands already (the reviewer or the host owns them), so taking the
/// scope back there would race the review/merge gate rather than a live builder.
const RECLAIMABLE_STATUSES: [&str; 4] = ["open", "claimed", "changes", "blocked"];

fn reclaim_key(task: &str) -> String { format!("reclaim-{task}") }

/// A `reclaim-<task>` note body → `{from, to, why}`. Same shape as every other
/// convention note here: `key: value` header lines, free text after them.
fn parse_reclaim(key: &str, value: &str, updated: u64) -> Value {
    let (mut from, mut to, mut why) = (String::new(), String::new(), String::new());
    for line in value.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("from:") { from = v.trim().trim_matches('-').trim().to_string(); }
        else if let Some(v) = l.strip_prefix("to:") { to = v.trim().trim_matches('-').trim().to_string(); }
        else if let Some(v) = l.strip_prefix("why:") { why = v.trim().to_string(); }
    }
    let task = key.strip_prefix("reclaim-").unwrap_or(key).to_string();
    json!({ "key": key, "task": task, "from": from, "to": to, "why": why, "updated": updated })
}

/// Ask the host to take a task's scope off its current owner. Coordinator-only:
/// this force-resets another agent's pane, which is not a builder's or a
/// reviewer's call to make. `to` empty = release the task back to `open` and
/// leave it unowned.
fn request_reclaim_as(project: &str, task: &str, to: &str, why: &str, actor: Option<&Actor>) -> Value {
    let refuse = |reason: &str, hint: String| json!({ "ok": false, "reason": reason, "hint": hint });
    if let Some(a) = actor {
        if a.project != project {
            return refuse("wrong project", format!("your token authenticates you for project \"{}\"", a.project));
        }
        if a.role != "coordinator" {
            return refuse("coordinator only", "a reclaim resets another agent's pane — only the coordinator asks for one".into());
        }
    }
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(v) = note(project, task) else {
        return json!({ "ok": false, "error": format!("no task {task}"), "hint": "GET /tasks?project= lists them" });
    };
    let t = parse_task(task, &v, 0);
    let (status, from) = (t["status"].as_str().unwrap_or(""), t["owner"].as_str().unwrap_or("").to_string());
    if !RECLAIMABLE_STATUSES.contains(&status) {
        return refuse("not reclaimable", format!("{task} is \"{status}\" — it has already left its builder's hands, so there is no live scope to take back"));
    }
    let to = to.trim();
    if !to.is_empty() && to == from {
        return refuse("already the owner", format!("{task} is already owned by {to}"));
    }
    let key = reclaim_key(task);
    let body = format!("from: {}\nto: {}\nwhy: {}\n", if from.is_empty() { "-" } else { &from }, if to.is_empty() { "-" } else { to }, why.trim());
    match write_note(project, &key, &body) {
        Ok(_) => json!({
            "ok": true, "project": project, "key": key, "task": task, "from": from, "to": to, "pending": true,
            "hint": "PixelMarch performs it: the losing pane is fenced and wiped and the owner flipped in one operation — do not chat the builder about it",
        }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Outstanding reclaim requests, oldest first. The host's work queue.
fn reclaim_requests(project: &str) -> Vec<Value> {
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let mut rows: Vec<Value> = notes
        .iter()
        .filter_map(|(k, e)| {
            let task = k.strip_prefix("reclaim-")?;
            if task.is_empty() || e.value.trim().is_empty() {
                return None;
            }
            Some(parse_reclaim(k, &e.value, e.updated))
        })
        .collect();
    rows.sort_by_key(|r| r["updated"].as_u64().unwrap_or(0));
    rows
}

/// Flip a task's owner — the HOST half of a reclaim, and the only caller is
/// PixelMarch (`brain_reclaim_task`), holding the losing pane fenced across this
/// call. No agent path reaches it: `set_task_status` refuses an agent-sent owner
/// change, and that stays true.
/// `to` empty = the task goes back to `open` with no owner; otherwise it is
/// handed to `to` as `claimed`, so it is not left dangling for a third builder
/// to grab in the same tick.
fn reclaim_task(project: &str, task: &str, to: &str) -> Value {
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(v) = note(project, task) else {
        return json!({ "ok": false, "error": format!("no task {task}") });
    };
    let t = parse_task(task, &v, 0);
    let status = t["status"].as_str().unwrap_or("");
    if !RECLAIMABLE_STATUSES.contains(&status) {
        return json!({ "ok": false, "reason": "not reclaimable", "status": status, "key": task });
    }
    let from = t["owner"].as_str().unwrap_or("").to_string();
    let to = to.trim();
    let next = if to.is_empty() { "open" } else { "claimed" };
    // Already where it is meant to be. The host retries a reclaim whose pane wipe
    // failed, so this runs more than once by design — rewriting the task each time
    // would stack an identical log line per retry.
    if from == to && status == next {
        return json!({ "ok": true, "project": project, "key": task, "status": next, "from": from, "to": to, "already": true });
    }
    let mut desc = t["desc"].as_str().unwrap_or("").to_string();
    desc = format!(
        "{desc}\n[{next} by host] scope reclaimed from {} and given to {}",
        if from.is_empty() { "-" } else { &from },
        if to.is_empty() { "the pool" } else { to },
    );
    match write_note(project, task, &render_task(next, t["role"].as_str().unwrap_or(""), to, t["files"].as_str().unwrap_or(""), &desc)) {
        Ok(_) => json!({ "ok": true, "project": project, "key": task, "status": next, "from": from, "to": to }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── partial edits: patch one note, search-and-replace across many ───────────
//
// WHY THIS EXISTS: before it, changing one line of a note meant GET the whole body,
// edit it in the caller's context, POST the whole body back — every byte of the note
// through the agent's context window TWICE per edit. Sweeping every `1.X.X` version
// reference out of the store that way cost ~60k tokens. These endpoints move the
// read-modify-write INSIDE the brain, so the caller sends only what it wants changed.
//
// BOTH TAKE `TASK_LOCK`, the same guard every task mutation takes, because tasks ARE
// notes (`task-<n>`, see the task-bus section). A patch that raced `set_task_status`
// would read the pre-claim body, write it back, and hand one task to two builders.
// Reads inside these functions therefore go through the index like every other read;
// the lock is what makes the read-then-write pair atomic against the bus.
//
// KEYS ARE NEVER REWRITTEN. A replace edits note BODIES only. A note whose *key*
// contains the search string is not renamed and is not touched unless its body also
// matches — renaming a note is a different operation (write the new key, forget the
// old one) and doing it silently inside a bulk pass would break every `[[key]]` link
// pointing at it. Every response reports the SANITIZED key (`safe_seg`), so a caller
// can re-target what it just changed.

/// Per-note cap on the line-level preview a patch/replace reports. A dry run over the
/// whole store must stay readable (and small) in an agent's context — the `hits` count
/// is always exact, only the shown lines are capped.
const PREVIEW_LINES_PER_NOTE: usize = 12;

/// Default ceiling on how many notes ONE `/replace` may write. A bulk replace is the
/// single most destructive thing this API can do; refusing an oversized apply (rather
/// than doing it) turns "my regex was broader than I thought" into an error message
/// instead of a corrupted store. Dry runs are never capped — you always get the full
/// picture before you commit.
const REPLACE_APPLY_LIMIT: usize = 200;

/// A literal-substring or regex matcher, compiled ONCE and reused across every note of
/// a bulk pass. `regex` is already an unconditional dependency of this crate, so the
/// regex mode costs no new dep — which is why it is offered at all: the motivating
/// sweep (`1\.\d+\.\d+`) is a regex, not a literal.
enum Matcher {
    Literal(String),
    Re(regex::Regex),
}

impl Matcher {
    fn build(find: &str, use_regex: bool) -> Result<Matcher, String> {
        if find.is_empty() {
            return Err("`find` must be non-empty".into());
        }
        if use_regex {
            let re = regex::Regex::new(find).map_err(|e| format!("bad regex: {e}"))?;
            // A pattern that can match the empty string turns replace_all into "insert
            // the replacement between every character" — refuse it rather than shred
            // the note. (`a*`, `x?`, `(?:)` and friends all land here.)
            if re.find("").is_some() {
                return Err(format!(
                    "regex `{find}` matches the empty string — it would insert the replacement between every character"
                ));
            }
            Ok(Matcher::Re(re))
        } else {
            Ok(Matcher::Literal(find.to_string()))
        }
    }

    fn count(&self, s: &str) -> usize {
        match self {
            Matcher::Literal(f) => s.matches(f.as_str()).count(),
            Matcher::Re(r) => r.find_iter(s).count(),
        }
    }

    /// `all` false replaces only the FIRST occurrence. Regex replacements expand
    /// capture groups (`$1`), which is documented in /info — the literal mode does not.
    fn apply(&self, s: &str, rep: &str, all: bool) -> String {
        match self {
            Matcher::Literal(f) if all => s.replace(f.as_str(), rep),
            Matcher::Literal(f) => s.replacen(f.as_str(), rep, 1),
            Matcher::Re(r) if all => r.replace_all(s, rep).into_owned(),
            Matcher::Re(r) => r.replace(s, rep).into_owned(),
        }
    }

    /// Could a match — or its replacement — span a line boundary? If so, a per-line
    /// preview would misreport what happens, so the caller falls back to a whole-note
    /// summary rather than showing a diff it cannot compute line-wise.
    fn spans_lines(&self, rep: &str) -> bool {
        rep.contains('\n')
            || match self {
                Matcher::Literal(f) => f.contains('\n'),
                Matcher::Re(r) => r.as_str().contains('\n') || r.as_str().contains("\\n"),
            }
    }

    fn pattern(&self) -> &str {
        match self {
            Matcher::Literal(f) => f.as_str(),
            Matcher::Re(r) => r.as_str(),
        }
    }
}

/// The line-level preview of a replace: `[{line, before, after}]` (1-based line
/// numbers), plus how many changed lines were elided by [`PREVIEW_LINES_PER_NOTE`].
///
/// Computed by applying the SAME matcher line by line, which is exactly equivalent to
/// the whole-body replace as long as neither pattern nor replacement contains a newline
/// — `spans_lines` is what decides whether this is called at all.
fn preview_lines(before: &str, m: &Matcher, rep: &str, all: bool) -> (Vec<Value>, usize) {
    let mut rows: Vec<Value> = Vec::new();
    let mut elided = 0usize;
    let mut done = false;
    for (i, line) in before.lines().enumerate() {
        if done {
            break;
        }
        if m.count(line) == 0 {
            continue;
        }
        let after = m.apply(line, rep, all);
        if !all {
            done = true; // only the first occurrence in the whole body changes
        }
        if after == line {
            continue;
        }
        if rows.len() < PREVIEW_LINES_PER_NOTE {
            rows.push(json!({ "line": i + 1, "before": line, "after": after }));
        } else {
            elided += 1;
        }
    }
    (rows, elided)
}

/// The raw stored body, INCLUDING a blank/whitespace-only one. `note()` hides those
/// (an empty note reads as absent everywhere else in the API), but a patch must be
/// able to append to a note someone blanked rather than claim it does not exist.
fn note_raw(project: &str, key: &str) -> Option<String> {
    let idx = read_index();
    idx.get(&safe_seg(project))?.get(&safe_seg(key)).map(|e| e.value.clone())
}

/// Parse a line spec — `"3"`, `"3-7"`, `"1,4,9-11"` — into 1-based line numbers,
/// rejecting anything out of range so a typo can't silently delete nothing (or, worse,
/// look like it worked).
fn parse_line_spec(spec: &str, total: usize) -> Result<Vec<usize>, String> {
    let mut out: Vec<usize> = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let lo: usize = a.parse().map_err(|_| format!("bad line spec `{part}`"))?;
        let hi: usize = b.parse().map_err(|_| format!("bad line spec `{part}`"))?;
        if lo == 0 || hi < lo {
            return Err(format!("bad line range `{part}` (lines are 1-based, lo<=hi)"));
        }
        if hi > total {
            return Err(format!("line {hi} is past the end of the note ({total} lines)"));
        }
        out.extend(lo..=hi);
    }
    if out.is_empty() {
        return Err("`lines` is empty — pass e.g. lines=3 or lines=3-7 or lines=1,4,9-11".into());
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Join lines back into a body, preserving whether the original ended with a newline.
fn rejoin(lines: &[&str], trailing_newline: bool) -> String {
    let mut s = lines.join("\n");
    if trailing_newline && !s.is_empty() {
        s.push('\n');
    }
    s
}

/// Patch ONE note in place. `op` is one of:
/// - `replace`      — `find` → `replace` (literal, or `regex=1`); `all=0` for first only
/// - `append`       — `text` added as a new line at the end
/// - `prepend`      — `text` added as a new line at the start
/// - `delete-lines` — drop the lines named by `lines` (1-based, `3` / `3-7` / `1,4,9-11`)
/// - `set-line`     — replace the single line named by `lines` with `text`
///
/// `expect`, when given, must appear in the current body or the patch is refused: the
/// optimistic-concurrency guard for "edit this note only if it still says what I read".
/// `dry` previews without writing.
#[allow(clippy::too_many_arguments)]
fn patch_note(
    project: &str,
    key: &str,
    op: &str,
    find: &str,
    replace: &str,
    text: &str,
    lines_spec: &str,
    all: bool,
    use_regex: bool,
    expect: &str,
    dry: bool,
) -> Value {
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let skey = safe_seg(key);
    let sproject = safe_seg(project);
    let Some(before) = note_raw(project, key) else {
        return json!({
            "ok": false, "project": sproject, "key": skey, "error": format!("no note {sproject}/{skey}"),
            "hint": format!("GET /keys?project={sproject} lists its keys; POST /memory/{sproject}/{skey} creates the note first")
        });
    };

    // Infer the obvious op so the common calls need no `op=` at all.
    let op = match op.trim() {
        "" if !find.is_empty() => "replace",
        "" if !text.is_empty() => "append",
        "" => {
            return json!({
                "ok": false, "project": sproject, "key": skey, "error": "need op",
                "hint": "op=replace|append|prepend|delete-lines|set-line (omit it and find= implies replace, text= implies append)"
            })
        }
        o => o,
    };

    if !expect.is_empty() && !before.contains(expect) {
        return json!({
            "ok": false, "project": sproject, "key": skey, "op": op, "reason": "expect not found",
            "hint": "the note no longer contains `expect` — re-read it (GET /memory/<p>/<k>) and patch again"
        });
    }

    let src_lines: Vec<&str> = before.lines().collect();
    let trailing_nl = before.ends_with('\n');

    let (after, mut changed): (String, Vec<Value>) = match op {
        "replace" | "sub" => {
            let m = match Matcher::build(find, use_regex) {
                Ok(m) => m,
                Err(e) => {
                    return json!({ "ok": false, "project": sproject, "key": skey, "op": op, "error": e })
                }
            };
            let after = m.apply(&before, replace, all);
            let rows = if m.spans_lines(replace) {
                Vec::new()
            } else {
                preview_lines(&before, &m, replace, all).0
            };
            (after, rows)
        }
        "append" => {
            let mut s = before.clone();
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(text);
            if trailing_nl {
                s.push('\n');
            }
            (s, vec![json!({ "line": src_lines.len() + 1, "before": Value::Null, "after": text })])
        }
        "prepend" => {
            let mut s = String::from(text);
            s.push('\n');
            s.push_str(&before);
            (s, vec![json!({ "line": 1, "before": Value::Null, "after": text })])
        }
        "delete-lines" | "delete_lines" => {
            let nums = match parse_line_spec(lines_spec, src_lines.len()) {
                Ok(n) => n,
                Err(e) => {
                    return json!({ "ok": false, "project": sproject, "key": skey, "op": op, "error": e })
                }
            };
            let drop: HashSet<usize> = nums.iter().copied().collect();
            let kept: Vec<&str> = src_lines
                .iter()
                .enumerate()
                .filter(|(i, _)| !drop.contains(&(i + 1)))
                .map(|(_, l)| *l)
                .collect();
            let rows = nums
                .iter()
                .take(PREVIEW_LINES_PER_NOTE)
                .map(|n| json!({ "line": n, "before": src_lines[n - 1], "after": Value::Null }))
                .collect();
            (rejoin(&kept, trailing_nl), rows)
        }
        "set-line" | "set_line" => {
            let nums = match parse_line_spec(lines_spec, src_lines.len()) {
                Ok(n) => n,
                Err(e) => {
                    return json!({ "ok": false, "project": sproject, "key": skey, "op": op, "error": e })
                }
            };
            let mut out = src_lines.clone();
            let mut rows = Vec::new();
            for n in &nums {
                if rows.len() < PREVIEW_LINES_PER_NOTE {
                    rows.push(json!({ "line": n, "before": out[n - 1], "after": text }));
                }
                out[n - 1] = text;
            }
            (rejoin(&out, trailing_nl), rows)
        }
        other => {
            return json!({
                "ok": false, "project": sproject, "key": skey, "error": format!("unknown op `{other}`"),
                "hint": "op=replace|append|prepend|delete-lines|set-line"
            })
        }
    };

    let hits = if matches!(op, "replace" | "sub") {
        Matcher::build(find, use_regex).map(|m| m.count(&before)).unwrap_or(0)
    } else {
        changed.len()
    };

    if after == before {
        changed.clear();
        return json!({
            "ok": true, "project": sproject, "key": skey, "op": op, "dry": dry, "changed": 0,
            "hits": hits, "note": "no change — the note already reads that way"
        });
    }

    let mut out = json!({
        "ok": true, "project": sproject, "key": skey, "op": op, "dry": dry,
        "hits": hits, "changed": changed.len(), "lines": changed,
        "bytes": { "before": before.len(), "after": after.len() },
    });

    if dry {
        out["hint"] = json!("dry run — nothing was written; resend without dry=1 to apply");
        return out;
    }
    if let Err(e) = write_note(project, key, &after) {
        return json!({ "ok": false, "project": sproject, "key": skey, "op": op, "error": e.to_string() });
    }
    out
}

/// Search-and-replace across MANY notes: one project, or every project with `all_projects`.
///
/// DRY RUN IS THE DEFAULT. Nothing is written unless `apply` is true — the caller must
/// look at the reported notes and lines and then explicitly commit. A bulk replace with
/// a broader pattern than intended corrupts the whole store, and the store is the only
/// copy, so the safe mode is the one you get by accident.
///
/// `task-<n>` notes are SKIPPED unless `include_tasks` is true: their bodies are a
/// machine-parsed header (`status:`/`owner:`/`files:`/`role:`) and a stray replace in
/// one silently re-opens or re-assigns live work.
#[allow(clippy::too_many_arguments)]
fn bulk_replace(
    project: Option<&str>,
    find: &str,
    replace: &str,
    use_regex: bool,
    key_filter: &[String],
    include_tasks: bool,
    apply: bool,
    limit: usize,
) -> Value {
    let _g = TASK_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let m = match Matcher::build(find, use_regex) {
        Ok(m) => m,
        Err(e) => {
            return json!({ "ok": false, "error": e, "hint": "find= is a literal substring unless regex=1" })
        }
    };
    let scope = project.map(safe_seg);
    let filter: HashSet<String> = key_filter.iter().map(|k| safe_seg(k)).collect();

    // Snapshot the candidates out of the index, then drop the read guard: `write_note`
    // below takes the index's WRITE lock, and an RwLock read guard held across it would
    // deadlock the process.
    let candidates: Vec<(String, String, String)> = {
        let idx = read_index();
        let mut v = Vec::new();
        for (p, notes) in idx.iter() {
            if scope.as_deref().is_some_and(|s| s != p) {
                continue;
            }
            for (k, e) in notes {
                if !filter.is_empty() && !filter.contains(k) {
                    continue;
                }
                if !include_tasks && k.starts_with("task-") && k["task-".len()..].parse::<u64>().is_ok() {
                    continue;
                }
                // Matching on the BODY only — a note whose key contains the search
                // string keeps its key (see the section header).
                if m.count(&e.value) == 0 {
                    continue;
                }
                v.push((p.clone(), k.clone(), e.value.clone()));
            }
        }
        v
    };

    let mut rows: Vec<Value> = Vec::new();
    let mut edits: Vec<(String, String, String)> = Vec::new();
    let mut total_hits = 0usize;
    for (p, k, before) in candidates {
        let after = m.apply(&before, replace, true);
        if after == before {
            continue; // matched, but the replacement is what it already says
        }
        let hits = m.count(&before);
        total_hits += hits;
        let (lines, elided) = if m.spans_lines(replace) {
            (Vec::new(), 0)
        } else {
            preview_lines(&before, &m, replace, true)
        };
        let mut row = json!({ "project": p, "key": k, "hits": hits, "lines": lines });
        if elided > 0 {
            row["lines_elided"] = json!(elided);
        }
        if m.spans_lines(replace) {
            row["multiline"] = json!(true);
        }
        rows.push(row);
        edits.push((p, k, after));
    }

    let scope_label = scope.clone().unwrap_or_else(|| "*".into());
    let mut out = json!({
        "ok": true, "dry": !apply, "scope": scope_label, "find": m.pattern(),
        "regex": use_regex, "replace": replace, "include_tasks": include_tasks,
        "notes_matched": rows.len(), "hits": total_hits, "notes": rows,
    });

    if !apply {
        out["written"] = json!(0);
        out["hint"] = json!("DRY RUN — nothing was written. Check `notes`, then resend the SAME request with apply=1 to commit.");
        return out;
    }
    if edits.len() > limit {
        return json!({
            "ok": false, "dry": true, "scope": scope_label, "find": m.pattern(),
            "notes_matched": edits.len(), "hits": total_hits, "limit": limit, "notes": out["notes"],
            "reason": "too many notes for one apply",
            "hint": format!("{} notes would change, over the {limit}-note safety limit. Narrow it (project=, keys=), or pass limit={} if that really is what you want.", edits.len(), edits.len())
        });
    }

    let mut written = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    for (p, k, after) in edits {
        match write_note(&p, &k, &after) {
            Ok(()) => written += 1,
            Err(e) => failed.push(json!({ "project": p, "key": k, "error": e.to_string() })),
        }
    }
    out["written"] = json!(written);
    if !failed.is_empty() {
        out["ok"] = json!(false);
        out["failed"] = json!(failed);
        out["hint"] = json!("some notes were written and some were not — the `failed` rows still hold the old text, re-run the same replace to finish");
    }
    out
}

/// Split a `keys=a,b,c` filter. Empty in, empty out (= no filter).
fn csv(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect()
}

// ── text matching (BigBrain-faithful, no regex dep) ─────────────────────────

fn words_lower(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_ascii_lowercase())
        .collect()
}

fn tokens(q: &str) -> Vec<String> {
    words_lower(q)
}

/// True if EVERY query token is a prefix of some whole word in `text`.
/// Tokenizes `text` on the spot — only for callers that have no indexed entry
/// (tests, ad-hoc text); the query paths use `entry_hit` against precomputed words.
/// Test-only since the index landed: it is kept as the reference implementation the
/// equivalence test measures `entry_hit`/`words_have_prefix` against.
#[cfg(test)]
fn note_hit(query_tokens: &[String], text: &str) -> bool {
    entry_hit(query_tokens, &sorted_words(text))
}

/// Is any word in this SORTED, unique word list prefixed by `tok`? Binary search:
/// the first word `>= tok` is the only candidate, since any word starting with `tok`
/// sorts immediately after it and before anything that doesn't.
fn words_have_prefix(words: &[String], tok: &str) -> bool {
    let i = words.partition_point(|w| w.as_str() < tok);
    words.get(i).is_some_and(|w| w.starts_with(tok))
}

/// `note_hit` against an index entry's precomputed word list.
fn entry_hit(query_tokens: &[String], words: &[String]) -> bool {
    query_tokens.iter().all(|t| words_have_prefix(words, t))
}

/// Notes under a DIFFERENT key whose content overlaps this one (≥3 shared terms and
/// ≥60% of this note's terms present). The duplicate-key guard behind remember.
fn similar(project: &str, key: &str, value: &str) -> Vec<Value> {
    let want: HashSet<String> =
        words_lower(&format!("{key} {value}")).into_iter().filter(|w| w.len() >= 3).collect();
    if want.len() < 3 {
        return Vec::new();
    }
    let idx = read_index();
    let Some(notes) = idx.get(&safe_seg(project)) else { return Vec::new() };
    let me = safe_seg(key);
    let mut hits: Vec<(f64, String)> = Vec::new();
    for (k, e) in notes {
        if *k == me || e.value.trim().is_empty() {
            continue;
        }
        // Every term in `want` is already >= 3 chars, so membership in the entry's
        // full word list is the same count the old "filter then intersect" gave.
        let shared = want.iter().filter(|t| e.words.binary_search(t).is_ok()).count();
        let frac = shared as f64 / want.len() as f64;
        if shared >= 3 && frac >= 0.6 {
            hits.push(((frac * 100.0).round() / 100.0, k.clone()));
        }
    }
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().take(3).map(|(o, k)| json!({ "key": k, "overlap": o })).collect()
}

// ── build stamp + capability handshake ──────────────────────────────────────
// The brain's HTTP contract keeps growing, but the SHIPPED exe only picks that up
// after a pack + update + restart. A caller talking to a stale host doesn't get an
// error — the guard it relies on (plan gate, `mine=` filter, query-string POST
// fields) is simply absent, which is how the busy-loop and deadlock bugs came back.
// So the running binary states what it is and what it can do, and callers CHECK.

/// HTTP contract version. Bump it whenever an endpoint's shape or a guard changes,
/// and add the matching name to `CAPABILITIES`.
pub const BRAIN_API_VERSION: u32 = 10;

/// Named features of THIS build's contract. Callers ask for a capability by name
/// rather than inferring it from a version number.
pub const CAPABILITIES: &[&str] = &[
    "cross-project-recall",   // a q= recall appends elsewhere:true pointers
    "query-string-post",      // every JSON field is also accepted as a query param
    "tasks-status-filter",    // GET /tasks?status=<csv>
    "tasks-role-filter",      // GET /tasks?role=
    "tasks-owner-filter",     // GET /tasks?owner=
    "tasks-mine-filter",      // GET /tasks?mine= (unowned OR mine)
    "tasks-compact",          // GET /tasks?compact=1 — plain-text rows
    "wait-long-poll",         // GET /wait
    "claim-plan-gate",        // builder claims refused until note "plan" exists
    "claim-owner-reclaim",    // an owner may re-claim its own re-opened task
    "agent-tokens",           // per-role agent tokens authenticate swarm panes
    "task-lifecycle-guard",   // agent task writes gated by actor identity (no self-approval, no agent merge)
    "projects-include-empty", // /projects lists note-less project dirs too
    "cors-deny",              // cross-origin fetch is refused loudly, not silently
    "build-stamp",            // GET /version + the BUILD line in /info
    "host-header-guard",      // requests addressed to a non-loopback name are refused
    "body-size-cap",          // a POST body is read under a fixed cap
    "note-patch",             // POST /patch — edit one note without resending its body
    "note-patch-lines",       // /patch op=delete-lines|set-line, 1-based `lines=` spec
    "note-patch-expect",      // /patch expect= — refuse unless the note still says that
    "note-patch-regex",       // /patch + /replace regex=1 (capture groups expand in `replace`)
    "bulk-replace",           // POST /replace — search-and-replace across many notes
    "bulk-replace-dry-run",   // …and it is a DRY RUN unless apply=1
    "bulk-replace-limit",     // an apply over `limit=` (default 200) is refused, not truncated
    "info-override",          // POST /info replaces this guide; empty body restores the built-in
    "info-sections",          // GET /info/<section> — deep-dive pages behind a short core /info
    "note-index",             // reads served from an in-RAM index, refreshed on a rescan gap
    "mcp",                    // POST /mcp — streamable-HTTP MCP on this port, this token
    "chat-routed",            // GET/POST /chat — chat-<from>-<n> notes, parsed and routed
    "reset-requests",         // GET /resets + POST /reset-request — the reset-<role> notes
    "scope-reclaim",          // POST /reclaim-request + GET /reclaims — host-performed reassignment
];

/// Machine-readable identity of the running binary (`GET /version`, and the
/// `brain_build_stamp` IPC command the frontend compares against).
pub fn build_stamp() -> Value {
    json!({
        "name": "BigBrain",
        "app": "pixelmarch",
        "version": env!("CARGO_PKG_VERSION"),
        "commit": env!("PIXELMARCH_GIT_SHA"),
        "built": env!("PIXELMARCH_BUILD_TIME"),
        "built_epoch": env!("PIXELMARCH_BUILD_EPOCH").parse::<u64>().unwrap_or(0),
        "api": BRAIN_API_VERSION,
        "capabilities": CAPABILITIES,
    })
}

/// The same stamp as one human line, carried at the top of `/info` so an agent
/// reading the guide sees which build it is actually talking to.
pub fn build_stamp_line() -> String {
    format!(
        "BUILD pixelmarch {} · commit {} · built {} · brain api v{} · GET /version for the \
         machine-readable form — compare `api` and `capabilities` BEFORE relying on a guard; \
         a stale host lacks it silently, with no error.",
        env!("CARGO_PKG_VERSION"),
        env!("PIXELMARCH_GIT_SHA"),
        env!("PIXELMARCH_BUILD_TIME"),
        BRAIN_API_VERSION,
    )
}

// ── the /info page + copyable setup snippet ─────────────────────────────────
//
// /info used to be one 14.8 KB page, and CLAUDE.md sends every agent in the repo
// there — so every agent paid the whole guide on turn 0 to learn the two calls it
// actually needed. The CORE page below stays small (the loop, the token rule, a
// one-line API map) and everything situational lives behind GET /info/<section>,
// fetched only when its topic is at hand. Every fact that moved out is reachable
// from a section, and the core page says which one.

/// The `/info` guide agents fetch to learn the API (BigBrain-branded for
/// PixelMarch). CORE page only — the deep dives live in `info_section`.
pub fn info_text(base: &str) -> String {
    format!(
"BigBrain — your long-term memory, shared with every agent in this repo ({base}).
Short project-scoped .md notes: what & where (facts, decisions, gotchas, file:line
pointers). Notes outlive context clears — recalling one beats re-reading code to relearn
what an agent already wrote down. Project = the working folder's name; omit it and notes
land in the shared \"_system\".

━━━━━━ THE TOKEN — every request needs it ━━━━━━
The `/t/<token>/` segment of the URL above IS the credential — use that whole string as
your base and every example works unchanged. Do NOT strip it or hardcode it; it is minted
fresh every PixelMarch launch. In a PixelMarch terminal $BIGBRAIN_URL already carries it.
Outside one, read the file next to the exe (pixelmarch-brain.token, mode 0600), or send it
as the X-Brain-Token header to keep it out of shell history. `401` = missing or stale —
re-read the file, do not retry the old value. GET /version answers without it, so a client
can always ask which build it is talking to (and which `capabilities` it has — check
before relying on a guard; a stale host lacks it silently). This is not a sandbox: a
process running as YOU can read the token file and is therefore trusted.

━━━━━━ THE LOOP — run it every task ━━━━━━
① RECALL before you read code or plan. Big picture first, then the topic at hand:
     curl -s \"{base}/memory/<project>/project_settings\"      # architecture + conventions
     curl -s -G \"{base}/recall?project=<project>\" --data-urlencode \"q=<topic>\"   # notes matching a topic (multi-word safe)
   Found the answer? Trust the note. 404 on project_settings? Create it before you build.
② REMEMBER after anything non-obvious — fact + location, not a saga. Upserts instantly:
     curl -s -X POST \"{base}/memory/<project>/<key>\" -d \"JWT + 15m refresh, see auth.rs:42\"

━━━━━━ project_settings — the canonical note (rule 0) ━━━━━━
EVERY project keeps ONE note keyed \"project_settings\": its architecture + conventions.
The always-there big picture — recall it FIRST, keep it current, create it if missing.

━━━━━━ API MAP — one line each ━━━━━━
GET  /version (no token; build stamp + capabilities) · /projects · /keys?project= ·
     /recall?project=&(q=|key=) · /memory/<p>/<k> · /tasks?project=&status=&role=&owner=&mine=&compact=1 ·
     /wait (long-poll for a matching task) · /chat?project=&role=&since= · /resets?project= ·
     /reclaims?project=
POST /memory/<p>/<k> (body = note) · /remember · /forget · /forget-project ·
     /patch (edit ONE note in place) · /replace (bulk sweep, DRY RUN until apply=1) ·
     /task · /claim · /task-status · /chat · /reset-request · /reclaim-request · /mcp (JSON-RPC) ·
     /info (override THIS page; empty body restores the built-in — see /info/override)

━━━━━━ DEEP DIVES — GET {base}/info/<section> when the topic is at hand ━━━━━━
search       how q= matches (prefix, AND), cross-project recall, /keys
editing      /patch ops (replace/append/prepend/delete-lines/set-line), expect=, dry=, regex trap
bulk         /replace across many notes — preview vs apply=1, regex, limit=, lock warning
freshness    when another process's write becomes visible; why /wait beats poll loops
windows      PowerShell curl traps + the no-quoting query-param form of every POST
tasks        task bus semantics — /task, /claim refusal reasons, /wait filters, chat + resets
mcp          the same bus as typed MCP tools over POST /mcp
conventions  one-topic-one-key, [[links]], the /remember dupe guard, agent work rules
override     POST /info contract, how sections interact with it, the in-app IPC/CORS rule
Unknown section? The 404 lists them all.
"
    )
}

/// Every deep-dive section name, in the order the core page lists them. The 404
/// for an unknown section hands this back so a typo self-corrects.
pub const INFO_SECTION_NAMES: &[&str] = &[
    "search", "editing", "bulk", "freshness", "windows", "tasks", "mcp", "conventions", "override",
];

/// One deep-dive page: `GET /info/<name>`. Built-in text only — the POST /info
/// override replaces the CORE page, never these (see the "override" section).
/// Every fact that used to live on the big /info page is in here somewhere.
pub fn info_section(name: &str, base: &str) -> Option<String> {
    let body = match name {
        "search" => format!(
"SEARCH — q=
q= hits a note when EVERY word you pass is the prefix of some word in it (key + body),
case-insensitive. q=pty+resize → notes with a \"pty…\" word AND a \"resize…\" word. Go broad
first (\"pty\"), then narrow. recall NEEDS key= or q= — it won't dump a project.
A q= recall also appends pointers to matching notes in OTHER projects (rows with
\"elsewhere\":true) — follow each row's \"recall\" URL to pull one in. See it all:
     curl -s \"{base}/keys?project=<project>\"       # this project's keys   (/projects lists all)
"),
        "editing" => format!(
"EDITING — never resend a whole note
Changing one line used to mean GET the note, edit it in your context, POST the whole body
back — the note through your context TWICE per edit. Don't. Send only the change:
     curl -s -X POST \"{base}/patch?project=<p>&key=<k>&find=<old text>&replace=<new text>\"
op is inferred: find= means replace, text= means append. Full set —
     op=replace       find= replace= [all=0 for first occurrence only] [regex=1]
     op=append        text=<line>            op=prepend  text=<line>
     op=delete-lines  lines=3 | 3-7 | 1,4,9-11        (1-based, past-the-end is an error)
     op=set-line      lines=<n> text=<new line>
     expect=<text>    refuse the patch unless the note STILL contains this — use it when
                      you read the note a while ago and something else may have written it
     dry=1            preview only: same reply, nothing written
Reply carries the SANITIZED key, hits, and the changed lines ({{line, before, after}}).
REGEX TRAP: with regex=1 the REPLACEMENT expands capture references, so a literal `$` is eaten —
replace=$BIGBRAIN_URL writes an EMPTY string. Escape it `$$`, or drop regex=1 (literal mode never
expands). Second trap: op=delete-lines / op=set-line rebuild the note from its lines, which
normalizes CRLF to LF; op=replace does not.
"),
        "bulk" => format!(
"BULK — one search-and-replace over many notes
     curl -s -X POST \"{base}/replace?project=<p>&find=<old>&replace=<new>\"          # PREVIEW
     curl -s -X POST \"{base}/replace?project=<p>&find=<old>&replace=<new>&apply=1\"   # COMMIT
IT IS A DRY RUN UNLESS YOU PASS apply=1. Read the `notes` rows first — project, key, hit
count and the exact lines that would change — then resend the SAME request with apply=1.
     regex=1          find= is a regex; $1 in replace= expands capture groups
                      (e.g. find=1\\.\\d+\\.\\d+  replace=0.1.x  to sweep version strings)
     all_projects=1   every project, not just one. Off by default: a forgotten project=
                      must narrow the blast radius, not widen it.
     keys=a,b,c       only these keys        include_tasks=1  also edit task-<n> notes
                      (skipped by default — their header is machine-parsed and a stray
                      replace re-opens or re-assigns live work)
     limit=<n>        safety ceiling on notes written in one apply (default 200; an
                      apply over it is REFUSED, and tells you the real count). The DRY RUN
                      does not pre-check it, so a >200-hit sweep previews fine and the first
                      apply comes back refused — resend it with limit=<the count it reported>.
Bodies only — a note whose KEY contains the search string is never renamed.
A pattern or replacement that spans a line boundary gets no per-line diff — those notes are
previewed by name and hit count only. And an apply holds the same lock the task bus takes, so a
big sweep stalls /claim, /task-status and /wait for its duration: don't run one mid-dispatch.
"),
        "freshness" => "FRESHNESS — reads come from an index, not from disk
Notes are served out of an in-RAM index (that is why recall over hundreds of notes costs no disk
reads). Your OWN writes are visible to your next read instantly. A write made by ANOTHER process —
the app while you are curling, or the reverse — lands within one rescan gap: 500 ms normally,
stretching toward 2 s only if the store gets big. So after posting a task or a note, give a peer a
beat before concluding it isn't there. Don't hand-roll a tight poll for it either: GET /wait blocks
server-side until the task actually matches.
".to_string(),
        "windows" => format!(
"WINDOWS + SHELL QUOTING
In PowerShell `curl` is an ALIAS for Invoke-WebRequest, so plain curl examples fail there
(and -d/-s are read as PowerShell params). Use `curl.exe -s ...` verbatim, or the native
form: Invoke-RestMethod -Uri \"{base}/recall?project=<p>&q=$([uri]::EscapeDataString('<topic>'))\" (POST: -Method POST
-ContentType \"application/json\" -Body '{{...}}'). CMD and Git Bash run curl examples as-is.
NO-QUOTING FORM (use it whenever a -d '{{...}}' body fights your shell — PowerShell mangles the
inner double quotes before curl.exe sees them): EVERY field of EVERY JSON endpoint can be sent
as a query param instead, e.g.
     curl.exe -s -X POST \"{base}/task?project=<p>&desc=<what>&files=<paths>&status=open&role=builder\"
     curl.exe -s -X POST \"{base}/memory/<p>/<key>?value=<note text>\"
Same semantics, nothing to quote. URL-encode spaces (%20) and &. Long/awkward values: write them
to a temp file and send \"--data-binary @<file>\". No need for HttpWebRequest or python.
The project is ALWAYS whatever you pass in the URL — your shell's working directory never picks it.
"),
        "tasks" => "TASK BUS — swarm coordination (tasks are ordinary task-<n> notes + an atomic claim)
GET /tasks?project=[&status=open,done,…][&role=builder|scout][&owner=][&mine=][&compact=1]
     owner= is an exact match; mine=<me> keeps unowned tasks OR tasks owned by <me> —
     use it in waits so someone else's re-opened rework can't wake you.
GET /wait?project=&status=&role=&owner=&mine=&timeout=55&compact=1 — LONG-POLL: blocks
     until a matching task exists (or timeout secs, max 120), then returns it; empty
     body = nothing yet, just call it again. Use this instead of hand-rolled poll
     loops (for/seq/watch/grep pipelines die silently in shell timeouts).
POST /task {project,desc,files,status,role?} — role defaults to builder; status omitted =
     blocked for builder tasks, open for scout — open builder tasks explicitly once the
     whole batch is posted. REFUSED (reason \"scope overlap\") when files= overlap the files
     of a live task (open/claimed/changes): to change a task's scope, patch that task's
     desc or post a correction-task-<n>-scope note — never a second task over the same files.
POST /claim {project,task,owner} — ok:false if not open, owned by someone else, the owner's
     role doesn't match the task's role, or — builder tasks only — the project has no
     \"plan\" note yet.
POST /task-status {project,task,status,owner?,log?}
Filter every read with &status=<only what you act on>&role=<yours>&compact=1 —
plain text, one task per line (key | status | role | owner | files | desc).

CHAT + RESETS — the chat-<from>-<n> / reset-<role> notes, read back already parsed;
write them with these instead of hand-formatting a \"to:\" header:
POST /chat {project,from,to,text} · GET /chat?project=[&role=<yours>][&since=<epoch s>]
     (role= = addressed to you or to all, your own messages left out)
POST /reset-request {project,role} · GET /resets?project=

SCOPE RECLAIM — coordinator only. Chat is NOT a lock: a \"please stop\" reaches a builder a
turn late, or after it has already started, which is how one task was built twice.
POST /reclaim-request {project,task,to?,why?} · GET /reclaims?project=
     Records who loses the task and who gets it; PixelMarch then performs it as ONE
     operation — the losing pane is fenced (no turn can be injected into it), the owner is
     flipped, the pane's context is wiped. to= omitted releases the task back to open.
     Refused for done/approved/merged: that scope has already left its builder's hands.
".to_string(),
        "mcp" => "MCP — the same bus as typed tools
POST /mcp speaks streamable-HTTP JSON-RPC on THIS port behind THIS token — same bus,
typed results (tasks_list, task_create, task_claim, task_status, note_get, note_set,
note_patch, recall, chat_send, chat_inbox, reset_request, plan_get). If your CLI
speaks MCP, point it here; if not, every one of those is a plain HTTP route (see the
API map on /info and the tasks section).
".to_string(),
        "conventions" => format!(
"ONE TOPIC, ONE KEY — no duplicates
Keys are lower-kebab-case, one topic each (reuse \"auth-flow\"; don't coin \"AuthFlow\"). Before
coining a key, recall the topic and REUSE the exact existing key — remember upserts, so reusing
refines it. Link notes inline with [[key]]. The JSON form guards against near-dupes:
     curl -s -X POST {base}/remember -d '{{\"project\":\"<p>\",\"key\":\"<k>\",\"value\":\"<what & where>\"}}'
   ok:false + \"similar\":[...] means a close note already exists under another key — reuse it,
   or resend with \"override\":true. (The /memory/<p>/<k> shortcut always overrides.)

Rules you carry into the work:
1. VERIFY BEFORE BUILD — recall/read/run to confirm current state and assumptions before
   writing code. Don't rebuild what exists or build on a guess; check first.
2. LAUNCH SUBAGENTS — delegate non-trivial or parallelizable work (explore / implement /
   verify) to subagents rather than doing it all in one thread.
3. USE EVERY TOOL — \"I can't do X\" is unacceptable. Python, PowerShell, the shell, MCP
   servers, subagents; install what's missing. Find a way and get the job done.
4. PROJECT SETTINGS — every project keeps ONE \"project_settings\" note (architecture +
   conventions); recall it first, keep it current. Rule 0.
"),
        "override" => format!(
"THE CORE PAGE IS EDITABLE
     curl -s -X POST \"{base}/info\" --data-binary @guide.md      # replaces the /info page
     curl -s -X POST \"{base}/info\" -d \"\"                          # empty body restores the built-in
The override is stored as info.md in the brain store dir, and {{base}} in it expands to the live
token-carrying URL. The BUILD line is prepended either way, so it can never be edited away.
Editable in the app too: the BigBrain panel's Setup tab. Put durable house rules here — every agent
that fetches /info reads them.
SECTIONS ARE NOT OVERRIDDEN: /info/<section> pages are built-in and always serve this build's
text. The override replaces the CORE page only — so house rules go there, and a custom page
that still wants the deep dives just keeps pointing at /info/<section>.

IN-APP CODE USES IPC, NOT fetch()
The server sends NO CORS headers, on purpose. A webview fetch() to it reads as empty on a GET and
still WRITES while reporting failure on a POST — silent corruption. Frontend code calls the Tauri
brain_* commands (src/lib/ipc.ts) instead. This HTTP API is for agents in a terminal.
"),
        _ => return None,
    };
    Some(body)
}

/// Optional /info override: `brain/info.md` next to the note projects.
fn info_override_path() -> PathBuf {
    root().join("info.md")
}

/// The text /info actually serves: the `info.md` override when present (with a
/// literal `{base}` placeholder expanded to the service URL), else the built-in
/// default from `info_text`. Either way the build stamp leads — an override must
/// not be able to hide which binary is answering.
pub fn current_info(base: &str) -> String {
    format!("{}\n\n{}", build_stamp_line(), info_body(base))
}

/// `/info` without the build-stamp header: the override, or the built-in guide.
fn info_body(base: &str) -> String {
    match std::fs::read_to_string(info_override_path()) {
        Ok(s) if !s.trim().is_empty() => s.replace("{base}", base),
        _ => info_text(base),
    }
}

/// Non-empty value replaces the info page (writes `brain/info.md`); an empty
/// value deletes the override, resetting to the built-in default.
fn write_info(value: &str) -> Value {
    if value.trim().is_empty() {
        let _ = std::fs::remove_file(info_override_path());
        return json!({ "ok": true, "custom": false, "reset": true });
    }
    if let Some(dir) = info_override_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(info_override_path(), value) {
        Ok(()) => json!({ "ok": true, "custom": true }),
        Err(e) => json!({ "error": format!("write info.md failed: {e}") }),
    }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

fn header(ctype: &str) -> Header {
    Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).expect("valid header")
}

/// Minimal percent-decode for query/path segments (no url crate).
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = |c: u8| (c as char).to_digit(16);
                match (hex(b[i + 1]), hex(b[i + 2])) {
                    (Some(h), Some(l)) => { out.push((h * 16 + l) as u8); i += 3; }
                    _ => { out.push(b'%'); i += 1; }
                }
            }
            b'+' => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse `a=1&b=two%20words` into pairs (decoded).
fn query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) => (pct_decode(k), pct_decode(v)),
            None => (pct_decode(kv), String::new()),
        })
        .collect()
}

fn qget(pairs: &[(String, String)], k: &str) -> Option<String> {
    pairs.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty())
}

/// Bind the brain server, trying 8734 then a few fallbacks (so a stale Python
/// BigBrain on 8734 doesn't stop us). Returns the server + the port it took.
fn bind() -> Option<(Server, u16)> {
    for port in 8734u16..=8744 {
        if let Ok(s) = Server::http(("127.0.0.1", port)) {
            return Some((s, port));
        }
    }
    None
}

// ── authentication ──────────────────────────────────────────────────────────
//
// Loopback is not a permission boundary. Before this, ANY local process — any
// script, any dependency's postinstall, any browser page that could reach
// 127.0.0.1 — could read and rewrite every note and every task on the swarm bus.
// The rebinding and body-size guards that shipped earlier need no credential;
// this is the credential.
//
// WHAT IT BUYS, precisely, so nobody reads more into it than is there:
//   * a browser page cannot use the bus at all — it cannot read a 0600 file, and
//     240-odd bits of token are not guessable;
//   * a process running as ANOTHER user account cannot read the token file;
//   * a process running as THIS user can read the file and is therefore fully
//     trusted. That is not a hole this design closes, and nothing local can:
//     the same process could read `brain/` off disk directly.
//
// The token travels as a PATH PREFIX (`/t/<token>/recall?…`) as well as a header.
// The prefix is what makes the change survivable: every doc, brief and snippet
// interpolates one `{base}` string, so the credential rides along without
// rewriting a hundred example curls into a form agents would get wrong. The
// cost is that the token appears in argv, visible to another account's `ps` on a
// box where `hidepid` is not set. The `X-Brain-Token` header form exists for
// exactly that case and is documented next to it.

/// Path segment the token prefix lives under: `/t/<token>/…`.
const TOKEN_PREFIX: &str = "/t/";
/// Header form, for callers who do not want the token in their command line.
const TOKEN_HEADER: &str = "X-Brain-Token";

/// File in the profile holding the brain's session token, 0600 (unix).
/// Separate from the host's token: they are different services with different
/// lifetimes, and one file per secret means revoking one never touches the other.
pub fn token_file() -> PathBuf {
    crate::state::state_dir().unwrap_or_else(|_| PathBuf::from(".")).join("pixelmarch-brain.token")
}

/// Split `/t/<token>/rest` into `(Some(token), "/rest")`; anything else is
/// `(None, path)` unchanged. A bare `/t/<token>` addresses `/`.
fn split_token_prefix(path: &str) -> (Option<&str>, &str) {
    let Some(rest) = path.strip_prefix(TOKEN_PREFIX) else { return (None, path) };
    match rest.find('/') {
        Some(i) => (Some(&rest[..i]), &rest[i..]),
        None => (Some(rest), "/"),
    }
}

/// Length-independent compare, so a wrong guess leaks nothing through timing.
/// An empty expected token never matches — a host that failed to publish one
/// must refuse everything, not accept everything.
fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Endpoints reachable WITHOUT the token, and why.
///
/// `/version` only. It is the build stamp — no note content, no task content —
/// and it is the one thing a client must be able to read to find out whether the
/// binary it is talking to enforces this guard at all. Everything else, including
/// every GET, requires the token: a bus that hands its whole contents to any
/// local reader is most of the problem, so read access is not free either.
fn is_public(path: &str) -> bool {
    path == "/version"
}

/// Does this request carry the session token?
///
/// `expected` is `None` when no token was ever published — i.e. in unit tests,
/// which call `route` directly and never start a server. The HTTP path always
/// passes `Some`, because `start()` refuses to bind without one.
fn token_ok(expected: Option<&str>, presented: Option<&str>) -> bool {
    let Some(expected) = expected else { return true };
    presented.map(|p| token_eq(p, expected)).unwrap_or(false)
}

// ── swarm agent identity ────────────────────────────────────────────────────
//
// The task-bus rules used to be prose in the role briefs, and prose is not
// enforcement: a builder that kept working after `done`, self-narrated a
// reviewer's approval and merged its own branch broke nothing the server could
// see, because every pane presented the same session token and the bus took
// any status from anyone (finding-builder-continues-after-done).
//
// So a swarm pane no longer gets the session token. At launch the GUI registers
// one AGENT TOKEN per role — `swarm_register_agents` — and each pane is spawned
// with ITS token baked into its `$BIGBRAIN_URL` and its MCP config. The brain
// resolves every request's token back to (project, role) and the task-bus
// writes below are refused or rewritten by WHO IS ASKING, not by what the
// caller claims to be:
//   - a claim's owner IS the actor — an agent cannot claim as someone else;
//   - `done` only from the owner; verdicts only from a reviewer/coordinator
//     that does not own the task; `merged` from NO agent, ever (the host runs
//     the merge itself and posts the status with the session token);
//   - task creation stays with the coordinator; chat `from` and reset `role`
//     are stamped with the actor so nothing can speak as another pane.
// The session token (and every in-process/IPC caller) stays unrestricted: the
// human and the host operate the bus, they are not participants to be policed.
//
// The registry is a 0600 file next to the token file because registration
// happens in the GUI process while authentication happens in the `--host`
// process — disk is the one channel they already share. It is tiny, read
// through an mtime-checked cache, and dies with the swarm (unregistered at
// mission end; a stale entry is just a token nobody holds).

/// Identity an agent token resolved to. `None` actor everywhere = trusted.
#[derive(Clone, Debug, PartialEq)]
pub struct Actor {
    pub project: String,
    pub role: String,
}

/// Registry file: `{ "<token>": { "project": "...", "role": "..." } }`, 0600.
fn agents_file() -> PathBuf {
    crate::state::config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("pixelmarch-brain-agents.json")
}

type AgentMap = BTreeMap<String, (String, String)>; // token -> (project, role)

/// mtime-checked cache: the hot path (every authenticated request in the host
/// process) stats one file and only re-reads it when a registration changed it.
fn agents_cache() -> &'static RwLock<Option<(SystemTime, AgentMap)>> {
    static C: OnceLock<RwLock<Option<(SystemTime, AgentMap)>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(None))
}

fn parse_agents(raw: &str) -> AgentMap {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else { return AgentMap::new() };
    map.into_iter()
        .filter_map(|(token, v)| {
            let project = v.get("project")?.as_str()?.to_string();
            let role = v.get("role")?.as_str()?.to_string();
            (!token.is_empty() && !project.is_empty() && !role.is_empty()).then_some((token, (project, role)))
        })
        .collect()
}

fn read_agents() -> AgentMap {
    let path = agents_file();
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let Some(mtime) = mtime else {
        // No file = no agents registered. Drop any cached map so a deleted
        // registry revokes immediately.
        *agents_cache().write().unwrap_or_else(|e| e.into_inner()) = None;
        return AgentMap::new();
    };
    if let Some((cached_at, map)) = agents_cache().read().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *cached_at == mtime {
            return map.clone();
        }
    }
    let map = parse_agents(&std::fs::read_to_string(&path).unwrap_or_default());
    *agents_cache().write().unwrap_or_else(|e| e.into_inner()) = Some((mtime, map.clone()));
    map
}

fn write_agents(map: &AgentMap) {
    let obj: serde_json::Map<String, Value> = map
        .iter()
        .map(|(t, (p, r))| (t.clone(), json!({ "project": p, "role": r })))
        .collect();
    let body = pretty(&Value::Object(obj));
    crate::host::write_token_at(&agents_file(), &body); // 0600, symlink-refusing
    *agents_cache().write().unwrap_or_else(|e| e.into_inner()) = None; // re-read next lookup
}

/// Serializes registry read-modify-write so two concurrent registrations (two
/// swarms launched at once) cannot clobber each other's rows.
static AGENTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Mint one token per role for `project`, replacing any previous registration
/// for that project (a relaunch revokes the old swarm's tokens). Returns
/// role → token.
pub fn register_agents(project: &str, roles: &[String]) -> Vec<(String, String)> {
    let _g = AGENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_agents();
    map.retain(|_, (p, _)| p != project);
    let mut out = Vec::new();
    for role in roles {
        let role = role.trim();
        if role.is_empty() {
            continue;
        }
        let token = crate::host::new_token();
        map.insert(token.clone(), (project.to_string(), role.to_string()));
        out.push((role.to_string(), token));
    }
    write_agents(&map);
    out
}

/// Revoke every agent token of `project` (mission end / swarm closed).
pub fn unregister_agents(project: &str) {
    let _g = AGENTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = read_agents();
    let before = map.len();
    map.retain(|_, (p, _)| p != project);
    if map.len() != before || map.is_empty() {
        write_agents(&map);
    }
}

/// Resolve a presented token to the agent it identifies, if it is one.
fn agent_actor(token: &str) -> Option<Actor> {
    let map = read_agents();
    map.iter()
        .find(|(t, _)| token_eq(t, token))
        .map(|(_, (project, role))| Actor { project: project.clone(), role: role.clone() })
}

/// Why this agent may NOT move `task` to `next`, or None when it may.
/// Trusted callers (no actor) are never refused. Split out so the whole rule
/// table is testable without HTTP.
fn lifecycle_refusal(actor: Option<&Actor>, project: &str, cur_status: &str, cur_owner: &str, next: &str) -> Option<Value> {
    let a = actor?;
    let me = a.role.as_str();
    let refuse = |reason: &str, hint: String| {
        Some(json!({ "ok": false, "reason": reason, "actor": me, "hint": hint }))
    };
    if a.project != project {
        return refuse("wrong project", format!("your token authenticates you for project \"{}\" — task writes elsewhere are refused", a.project));
    }
    let owns = me == cur_owner;
    // A malformed task has no trustworthy owner or status to reason from, so every
    // agent-side transition off it would be a guess ("done" by whoever asks first,
    // "approved" over work nobody can see). The coordinator owns the repair: it
    // rewrites the header with task_status, which is the only call that renders one.
    if cur_status == MALFORMED && me != "coordinator" {
        return refuse(
            "task note malformed",
            "this task's header (status/role/owner/files) is gone, so the bus cannot tell whose it is — do not re-post it; tell the coordinator in chat and let it rebuild the task".into(),
        );
    }
    // A cancelled task is OVER, by a human's decision at the mission board. Every
    // agent-side transition off it — a re-claim, a "done" the builder was mid-way
    // through, a coordinator re-opening it "to be safe" — would restart exactly the
    // work the cancel stopped, so the whole status is a wall from this side.
    if cur_status == CANCELLED {
        return refuse(
            "task cancelled",
            "a human cancelled this task from the mission board — it is finished and does not come back. \
             Do not claim it, re-open it, or post work against it; plan around it, and if you believe it \
             must return, say so in chat and let the human do it".into(),
        );
    }
    match next {
        // The host runs the merge and posts this itself. An agent-side "merged"
        // was exactly how a builder self-merged past review once.
        "merged" => refuse("host merges", "agents never post merged — PixelMarch merges an approved task itself and marks it merged when the merge lands".into()),
        // Cancelling is the HUMAN's call, made from PixelMarch's mission board, and
        // it is the only status that stops a pane as well as moving the bus.
        CANCELLED => refuse("human cancels", "agents never cancel a task — cancelling is the human's call from PixelMarch's mission board. If a task should not be done, say so in chat and let the coordinator block it".into()),
        "approved" | "changes" => {
            if !(me.starts_with("reviewer") || me == "coordinator") {
                return refuse("not a reviewer", "verdicts come from a reviewer (or the coordinator when the swarm runs none)".into());
            }
            if owns {
                return refuse("own task", "you cannot verdict a task you own — another role must gate it".into());
            }
            if next == "approved" && cur_status != "done" {
                return refuse("not done", format!("only a done task can be approved — this one is \"{cur_status}\""));
            }
            None
        }
        "done" if !owns => refuse("not the owner", format!("only the owner ({}) posts done", if cur_owner.is_empty() { "-" } else { cur_owner })),
        "blocked" if me != "coordinator" => refuse("coordinator only", "only the coordinator blocks tasks".into()),
        "open" if me != "coordinator" && !owns => refuse("coordinator or owner only", "open comes from the coordinator (unblocking) or the owner (releasing its claim)".into()),
        // "claimed" is re-taking your own task after "changes". A fresh claim
        // goes through /claim, which is the atomic path.
        "claimed" if !owns => refuse("not the owner", "re-take only your own task; fresh claims go through /claim".into()),
        "done" | "blocked" | "open" | "claimed" => None,
        other => refuse("unknown status", format!("\"{other}\" is not a task status — one of done|approved|changes|blocked|open|claimed")),
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────
// The built-in note manager is just a text editor over the on-disk store
// (brain/<project>/<key>.md in the profile). It edits the files directly through
// these — no HTTP round-trip. The HTTP server stays for external coding agents.

// The read commands are `async` ON PURPOSE: Tauri v2 runs a NON-async command on the
// main thread, so a sync `brain_search` put a whole-store walk between the webview's
// keystroke and its echo. `async` moves them onto the async runtime's pool. They do no
// awaiting — the index lookup is synchronous and short — the point is only which
// thread it happens on. Do not "simplify" these back to `fn`.

#[tauri::command]
pub async fn brain_projects() -> Vec<String> { projects() }

#[tauri::command]
pub async fn brain_keys(project: String) -> Vec<String> { keys(&project) }

/// Create an empty project so it shows up immediately (see `projects()`).
#[tauri::command]
pub fn brain_create_project(project: String) -> Result<(), String> {
    create_project(&project).map_err(|e| e.to_string())
}

/// The running binary's build stamp + capability list — the frontend's half of the
/// version handshake. IPC because the webview is cross-origin to the HTTP server
/// (which now refuses such requests outright); the HTTP twin is `GET /version`.
#[tauri::command]
pub fn brain_build_stamp() -> Value { build_stamp() }

#[tauri::command]
pub async fn brain_note(project: String, key: String) -> Option<String> { note(&project, &key) }

#[tauri::command]
pub fn brain_save(project: String, key: String, value: String) -> Result<(), String> {
    write_note(&project, &key, &value).map_err(|e| e.to_string())
}

/// Edit one note in place — the IPC twin of `POST /patch`. Same argument names, same
/// response object, so the panel and an agent's curl share one contract.
///
/// `async` for the same reason the read commands are (a Tauri non-async command runs on
/// the MAIN thread), and here it matters more: this one blocks on `TASK_LOCK`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn brain_patch(
    project: String,
    key: String,
    op: Option<String>,
    find: Option<String>,
    replace: Option<String>,
    text: Option<String>,
    lines: Option<String>,
    all: Option<bool>,
    regex: Option<bool>,
    expect: Option<String>,
    dry: Option<bool>,
) -> Value {
    let s = |o: Option<String>| o.unwrap_or_default();
    patch_note(
        &project,
        &key,
        &s(op),
        &s(find),
        &s(replace),
        &s(text),
        &s(lines),
        all.unwrap_or(true),
        regex.unwrap_or(false),
        &s(expect),
        dry.unwrap_or(false),
    )
}

/// Search-and-replace across many notes — the IPC twin of `POST /replace`.
/// DRY RUN unless `apply` is true; `all_projects` spans the whole store.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn brain_replace(
    project: Option<String>,
    all_projects: Option<bool>,
    find: String,
    replace: Option<String>,
    regex: Option<bool>,
    keys: Option<String>,
    include_tasks: Option<bool>,
    apply: Option<bool>,
    limit: Option<usize>,
) -> Value {
    let scope = if all_projects.unwrap_or(false) {
        None
    } else {
        Some(project.unwrap_or_else(|| DEFAULT_PROJECT.to_string()))
    };
    bulk_replace(
        scope.as_deref(),
        &find,
        &replace.unwrap_or_default(),
        regex.unwrap_or(false),
        &csv(&keys.unwrap_or_default()),
        include_tasks.unwrap_or(false),
        apply.unwrap_or(false),
        limit.unwrap_or(REPLACE_APPLY_LIMIT),
    )
}

#[tauri::command]
pub fn brain_delete(project: String, key: String) -> Result<(), String> {
    delete_note(&project, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn brain_delete_project(project: String) { forget_project(&project); }

/// Parsed task list for the swarm mission tree (same rows as GET /tasks).
#[tauri::command]
pub async fn brain_tasks(project: String) -> Vec<Value> { tasks(&project) }

/// Swarm chat, already routed. The webview CANNOT reach the HTTP bus — the brain
/// serves no CORS headers on purpose (see `handle`) — so the dispatcher needs the
/// parsed rows over IPC or it is back to scanning note keys itself.
/// `role` omitted = every message; `since` is the epoch-seconds cursor of `chat_inbox`.
#[tauri::command]
pub async fn brain_chat(project: String, role: Option<String>, since: Option<u64>) -> Vec<Value> {
    let since = since.unwrap_or(0);
    match role {
        Some(r) if !r.trim().is_empty() => chat_inbox(&project, &r, since),
        _ => chat_rows(&project).into_iter().filter(|m| m["updated"].as_u64().unwrap_or(0) > since).collect(),
    }
}

/// Outstanding reset requests, for the same reason as `brain_chat`.
#[tauri::command]
pub async fn brain_resets(project: String) -> Vec<Value> { reset_requests(&project) }

/// The coordinator's outstanding scope reclaims — the host's work queue.
#[tauri::command]
pub async fn brain_reclaims(project: String) -> Vec<Value> { reclaim_requests(&project) }

/// Flip a task's owner AS THE HOST: the bus half of a reclaim (brain-findings
/// 2.2). Only ever called from `reclaimScope` (src/lib/swarmReset.ts), which
/// fences the losing pane BEFORE this and wipes it after, so the losing builder
/// cannot take another turn anywhere across the pair. Never call it on its own —
/// a flip without the fence is the racy chat-as-a-lock behaviour it replaces.
#[tauri::command]
pub async fn brain_reclaim_task(project: String, task: String, to: Option<String>) -> Value {
    reclaim_task(&project, &task, to.unwrap_or_default().trim())
}

/// Transition a task AS THE HOST — the dispatcher's write path for the
/// host-performed merge ("merged" after the merge lands, "changes" after a
/// conflict). Trusted (no actor), attributed to "host" in the task log so the
/// history says who really did it.
#[tauri::command]
pub async fn brain_task_status(project: String, task: String, status: String, log: Option<String>) -> Value {
    set_task_status_as(&project, &task, &status, None, &log.unwrap_or_default(), None, Some("host"))
}

/// Send a swarm chat message as the host (repo-dirty warnings and other
/// facts only PixelMarch can see). Same note store the panes use.
#[tauri::command]
pub async fn brain_chat_send(project: String, from: String, to: String, text: String) -> Value {
    chat_send(&project, &from, &to, &text)
}

/// Mint per-role AGENT tokens for a swarm launch and hand back each role's
/// token-carrying base URL (`http://127.0.0.1:<port>/t/<agent token>`). The
/// panes are spawned with these instead of the session URL, which is what makes
/// every task-bus write attributable and gateable. Replaces any previous
/// registration for the project. `ok:false` when there is no running brain.
#[tauri::command]
pub fn swarm_register_agents(project: String, roles: Vec<String>) -> Value {
    let base = crate::host::read_brain_url();
    if base.trim().is_empty() {
        return json!({ "ok": false, "error": "no running brain — agent identities need the HTTP bus" });
    }
    let origin = crate::pty::base_without_token(&base).trim_end_matches('/').to_string();
    let mut urls = serde_json::Map::new();
    for (role, token) in register_agents(&project, &roles) {
        urls.insert(role, json!(format!("{origin}{TOKEN_PREFIX}{token}")));
    }
    json!({ "ok": true, "project": project, "urls": Value::Object(urls) })
}

/// Revoke a swarm's agent tokens (mission complete / workspace closed) and
/// drop its per-role MCP config files.
#[tauri::command]
pub fn swarm_unregister_agents(project: String) {
    unregister_agents(&project);
    crate::pty::remove_swarm_mcp_configs(&project);
}

/// The /info text as currently served (override or default). IPC because the
/// webview is cross-origin to the brain server, so it can't fetch() it directly.
#[tauri::command]
pub fn brain_info() -> String {
    current_info(&crate::host::read_brain_url())
}

/// Save (or, with an empty value, reset) the /info override — see `write_info`.
#[tauri::command]
pub fn brain_set_info(value: String) -> Result<(), String> {
    let out = write_info(&value);
    match out.get("error").and_then(Value::as_str) {
        Some(e) => Err(e.to_string()),
        None => Ok(()),
    }
}

/// Search EVERY project for `q` (same prefix-token match as /recall). Rows for the
/// selected `project` come first (elsewhere:false), then hits from other projects
/// (elsewhere:true); newest-first within each group. Feeds the Visualize tab's graph,
/// so unlike `cross_project` it returns full note values, not pointers.
#[tauri::command]
pub async fn brain_search(project: String, q: String) -> Vec<Value> {
    let toks = tokens(&q);
    if toks.is_empty() {
        return Vec::new();
    }
    let idx = read_index();
    let home_project = safe_seg(&project);
    let mut home: Vec<(u64, Value)> = Vec::new();
    let mut other: Vec<(u64, Value)> = Vec::new();
    for (p, notes) in idx.iter() {
        let elsewhere = *p != home_project;
        for (k, e) in notes {
            if e.value.trim().is_empty() || !entry_hit(&toks, &e.words) {
                continue;
            }
            let u = e.updated;
            let row = json!({ "project": p, "key": k, "value": e.value, "updated": u, "elsewhere": elsewhere });
            if elsewhere { other.push((u, row)) } else { home.push((u, row)) }
        }
    }
    home.sort_by(|a, b| b.0.cmp(&a.0));
    other.sort_by(|a, b| b.0.cmp(&a.0));
    home.into_iter().chain(other).map(|(_, r)| r).collect()
}

/// Warm the in-RAM index and keep it in step with disk. Idempotent; call it once per
/// process, as early as possible.
///
/// EVERY PROCESS THAT READS NOTES MUST CALL THIS. There are two: the detached `--host`
/// (via [`start`]) and the Tauri GUI (from its `setup`, since the `brain_*` IPC commands
/// read the GUI process's own index). The index is per process, so a process without
/// this thread never sees a note written by the other one — the GUI would sit frozen on
/// whatever disk held when it first read, which for a running swarm is everything.
///
/// BEHAVIOUR CHANGE, deliberate and bounded: before the index both processes read disk
/// per request, so a cross-process write was visible instantly. Now it is visible within
/// one rescan gap — [`RESCAN_MIN`] (500 ms) while passes are cheap, stretching toward
/// [`RESCAN_MAX`] only if the store grows big enough for [`RESCAN_DUTY`] to bite. In-process
/// writes stay instant. See the index section above for why not mtime-per-read.
/// Returns true if THIS call started the watch, false if it was already running (so a
/// second call is a no-op, not a second thread stat-walking the store).
pub fn start_index_watch() -> bool {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return false; // already watching in this process
    }
    // Notes are plain files, and the other process writes them. Own thread, so neither the
    // warm-up walk nor the periodic stat walk ever lands on the UI thread or an HTTP handler.
    //
    // The warm-up runs INSIDE the thread on purpose. It is one disk walk over the whole store
    // (~400 notes / 3.4 MB today, and this store can live on an encrypted volume, so a cold
    // cache costs far more than the ~9-18 ms a warm release walk does), and both callers are on
    // a hot path: the Tauri `setup` must reach `app.manage(client)` before the webview can call
    // `pty_open`, and `start` must reach `bind`. Nothing reads a note before the webview exists,
    // so nobody has to wait for this. A read that beats the thread is still correct — the lazy
    // OnceLock init IS the walk, so that reader just does it itself, exactly as before.
    std::thread::spawn(|| {
        drop(read_index()); // the warm-up: the lazy OnceLock init IS the walk
        loop {
            let t0 = Instant::now();
            rescan_once();
            let gap = (t0.elapsed() * RESCAN_DUTY).clamp(RESCAN_MIN, RESCAN_MAX);
            std::thread::sleep(gap);
        }
    });
    true
}

/// Start the embedded brain. Returns its base URL — WITH the token prefix, which
/// is what every caller must hand out — or None if the brain could not be started
/// (brain disabled: never fatal to the app).
///
/// Two ways to get None, and the second one is deliberate: no free port, or no
/// token could be published. Failing to publish means a client would have no way
/// to authenticate, so serving anyway would mean serving unauthenticated — the
/// exact state this exists to end. A read-only install therefore gets no HTTP
/// brain; the in-app note manager (the `brain_*` IPC commands) still works,
/// because it reads the files directly and never goes through this server.
pub fn start() -> Option<String> {
    start_index_watch();

    let token = publish_token()?;
    let (server, port) = bind()?;
    let base = format!("http://127.0.0.1:{port}{TOKEN_PREFIX}{token}");
    let base_for_thread = base.clone();
    let token_for_thread = token.clone();
    std::thread::spawn(move || serve(server, &base_for_thread, Some(&token_for_thread)));
    Some(base)
}

/// Mint a session token and write it in the profile, 0600. Returns None when it
/// cannot be written OR cannot be read back as written — a token nobody can read
/// is the same as no token, and finding that out here is better than serving a
/// bus every client is locked out of.
fn publish_token() -> Option<String> {
    let path = token_file();
    let token = crate::host::new_token();
    crate::host::write_token_at(&path, &token);
    match std::fs::read_to_string(&path) {
        Ok(back) if back.trim() == token => Some(token),
        _ => {
            eprintln!(
                "brain: could not publish {} — HTTP brain disabled (the in-app note manager still works)",
                path.display()
            );
            None
        }
    }
}

/// The token a request presented: header first, then the `/t/<token>/` path
/// prefix. Returns the token (if any) and the path with the prefix removed, so
/// routing never sees it.
fn presented_token<'a>(req: &tiny_http::Request, path: &'a str) -> (Option<String>, &'a str) {
    let header = req
        .headers()
        .iter()
        .find(|h| h.field.equiv(TOKEN_HEADER))
        .map(|h| h.value.as_str().trim().to_string())
        .filter(|v| !v.is_empty());
    let (from_path, rest) = split_token_prefix(path);
    (header.or_else(|| from_path.map(String::from)), rest)
}

/// The `Origin` header of a cross-origin (browser `fetch()`) request, if any.
/// `curl` and the like send none, so agents are unaffected.
fn request_origin(req: &tiny_http::Request) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string())
        .filter(|o| !o.is_empty() && o != "null")
}

/// The `Host` header a request arrived with, lowercased and without its port.
fn request_host(req: &tiny_http::Request) -> Option<String> {
    let raw = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .map(|h| h.value.as_str().trim().to_ascii_lowercase())?;
    // `[::1]:8734` and `127.0.0.1:8734` split differently.
    let host = match raw.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest).to_string(),
        None => raw.split(':').next().unwrap_or(&raw).to_string(),
    };
    (!host.is_empty()).then_some(host)
}

/// Was this request addressed to us by a loopback name, rather than to some other
/// name that merely *resolves* to loopback?
///
/// This is the DNS-rebinding guard, and it closes a hole the `Origin` check cannot.
/// A page on `http://evil.example` whose DNS is re-pointed at 127.0.0.1 is, to the
/// browser, talking to its OWN origin — so it sends no `Origin` header, the check
/// above waves it through, and the page can read every note in this store. What the
/// browser cannot forge is the `Host` header: it carries the name the user's page was
/// loaded from, `evil.example`, which is not a loopback name.
///
/// `curl http://127.0.0.1:8734/...` sends `Host: 127.0.0.1:8734` and is unaffected,
/// as is `localhost`. A request with no `Host` at all is HTTP/1.0 or a raw socket —
/// not a browser, and not something a rebinding attack can produce — so it passes.
fn host_header_is_loopback(host: Option<&str>) -> bool {
    let Some(host) = host else { return true };
    if host == "localhost" {
        return true;
    }
    host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Biggest request body the brain will read. Notes are prose; anything approaching
/// this is a local process trying to make us allocate, not somebody writing one down.
/// The cap is on the READ, not on a header, so lying about the length does not help.
const MAX_BODY_BYTES: u64 = 8 * 1024 * 1024;

/// The accept loop. Split out (and taking the expected token as an argument
/// rather than reading the global) so a test can stand a real server up on an
/// ephemeral port and prove an unauthenticated request is actually refused over
/// the wire — not merely that the guard compiles.
fn serve(server: Server, base: &str, expected: Option<&str>) {
    for req in server.incoming_requests() {
        handle(req, base, expected);
    }
}

fn handle(mut req: tiny_http::Request, base: &str, expected: Option<&str>) {
    // DNS rebinding: refuse anything addressed to a name that is not loopback, before
    // the Origin check — a rebound page is same-origin to itself and sends no Origin.
    let host = request_host(&req);
    if !host_header_is_loopback(host.as_deref()) {
        let body = pretty(&json!({
            "error": "request refused: not addressed to a loopback host",
            "host": host,
            "hint": "the brain answers only on 127.0.0.1 / localhost. A request arriving under another name is either a proxy or a DNS-rebinding attempt from a browser page; either way it is not an agent's curl.",
        }));
        respond(req, 403, "application/json", body);
        return;
    }

    // The brain deliberately sends NO CORS headers: the webview must go through the
    // Tauri IPC commands, not fetch(). But silence is the trap — without a response
    // the browser blocks the READ while the POST has already hit disk, so a write
    // that succeeded is reported as failed and then retried. Refuse cross-origin
    // requests loudly, before they can mutate anything. Shipped as a bug once (4aaa2e6).
    if let Some(origin) = request_origin(&req) {
        let body = pretty(&json!({
            "error": "cross-origin request refused",
            "origin": origin,
            "hint": "the brain serves no CORS headers on purpose — a webview fetch() would still WRITE while reporting failure. Use the Tauri IPC commands (brain_note / brain_save / brain_tasks / brain_info) from the app, or curl from a terminal.",
        }));
        respond(req, 403, "application/json", body);
        return;
    }

    let raw = req.url().to_string();
    let (full_path, query) = raw.split_once('?').unwrap_or((raw.as_str(), ""));

    // Authentication. Before anything is read, routed, or spawned onto a thread:
    // an unauthenticated caller must not be able to make us do work either.
    // Two credentials open the bus: the SESSION token (the human, the host, any
    // plain terminal — trusted, unrestricted) and a per-role AGENT token (a
    // swarm pane — authenticated but gated: see the swarm agent identity
    // section). The agent lookup only runs when the session token did not
    // match, so a swarm pane can never accidentally escalate.
    let (presented, path) = presented_token(&req, full_path);
    let session_ok = token_ok(expected, presented.as_deref());
    let actor = if session_ok { None } else { presented.as_deref().and_then(agent_actor) };
    if !is_public(path) && !session_ok && actor.is_none() {
        let body = pretty(&json!({
            "error": "unauthorized: the brain needs its session token",
            "hint": format!(
                "the token is in {} (0600, this user only). Put it in the URL — {}/t/$(cat <that file>)/recall?project=<p>&q=<topic> — or send it as the {} header. It is regenerated every time the host starts, so read the file, never a copy of it.",
                token_file().display(),
                base.split(TOKEN_PREFIX).next().unwrap_or(base),
                TOKEN_HEADER,
            ),
        }));
        respond(req, 401, "application/json", body);
        return;
    }

    let path = path.to_string();
    let pairs = query_pairs(query);
    let is_post = *req.method() == Method::Post;

    // Long-poll: the server loop is single-threaded, so a blocking wait gets its
    // own thread — the bus stays responsive for everyone else.
    if !is_post && path == "/wait" {
        std::thread::spawn(move || {
            let secs = qget(&pairs, "timeout").and_then(|t| t.parse::<u64>().ok()).unwrap_or(25).clamp(1, 120);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
            loop {
                let rows = filtered_tasks(&pairs);
                if !rows.is_empty() || std::time::Instant::now() >= deadline {
                    let (ctype, out) = if qget(&pairs, "compact").map_or(false, |v| v != "0") {
                        ("text/plain; charset=utf-8", compact_tasks(&rows))
                    } else {
                        ("application/json", pretty(&json!(rows)))
                    };
                    respond(req, 200, ctype, out);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        });
        return;
    }

    // Read the body up front (POST); the reader borrow ends before we respond.
    // Bounded: an unbounded `read_to_string` lets any local process hand the host
    // process an out-of-memory kill for the cost of one never-ending POST, taking
    // every terminal session down with it.
    //
    // ONE BYTE PAST THE CAP, and refuse when it arrives. `take(MAX)` alone silently
    // TRUNCATES: the caller gets 200 and believes their note was stored, while what
    // landed on disk is the note with its end cut off — and a half-written note is
    // worse than a refused one, because nothing about it looks wrong later. Same
    // shape as the manifest read in `update.rs`.
    let mut body = String::new();
    if is_post {
        use std::io::Read;
        let _ = req.as_reader().take(MAX_BODY_BYTES + 1).read_to_string(&mut body);
        if body.len() as u64 > MAX_BODY_BYTES {
            let out = pretty(&json!({
                "error": "request body too large",
                "limit_bytes": MAX_BODY_BYTES,
                "hint": "notes are prose — nothing legitimate approaches 8 MiB. Nothing was written.",
            }));
            respond(req, 413, "application/json", out);
            return;
        }
    }

    let (code, ctype, out) = route_as(&path, is_post, &pairs, &body, base, actor.as_ref());
    respond(req, code, ctype, out);
}

fn respond(req: tiny_http::Request, code: u16, ctype: &str, out: String) {
    let resp = Response::from_string(out).with_status_code(code).with_header(header(ctype));
    let _ = req.respond(resp);
}

// ── agent lifecycle events (in-process ring, NOT notes) ─────────────────────
//
// A hook-capable agent CLI POSTs one of these when its session starts, when a
// prompt is accepted and when a turn ends. The swarm watchers read them back
// instead of inferring pane idleness from terminal output going quiet, which is
// a guess that gets a long-running tool call wrong every time.
//
// They are deliberately NOT notes. They are high-frequency, worthless a minute
// later, and one note per turn would flood `/keys`, `/recall` and the feed the
// UI subscribes to — the very surfaces agents read to find real memory. So they
// live in a bounded per-project ring in THIS PROCESS: nothing on disk, nothing
// in the index, nothing for the filesystem watch to rescan. They die with the
// host, which is exactly the lifetime a "is this pane mid-turn" fact has.

/// The only accepted event kinds. Anything else is a caller bug — a typo in a
/// hook command — and is refused loudly rather than stored where nothing reads it.
const AGENT_EVENT_KINDS: [&str; 5] = ["session-start", "prompt-submitted", "turn-end", "notification", "compacting"];

/// Events retained per project. ~200 is many minutes of a busy swarm; a reader
/// that falls further behind than that has lost more than one turn boundary and
/// is better off re-reading state than replaying history.
const AGENT_EVENT_RING: usize = 200;

#[derive(Clone)]
struct AgentEvent {
    seq: u64,
    at: u64,
    role: String,
    event: String,
    session: String,
    detail: String,
}

impl AgentEvent {
    fn to_json(&self) -> Value {
        json!({
            "seq": self.seq,
            "at": self.at,
            "role": self.role,
            "event": self.event,
            "session": self.session,
            "detail": self.detail,
        })
    }
}

/// `(next seq, project -> ring)`. The sequence is GLOBAL and only ever counts
/// up, so a client cursor can never replay an event and never needs resetting —
/// even across projects, and even after a ring has dropped its oldest entries.
type AgentEvents = (u64, BTreeMap<String, VecDeque<AgentEvent>>);

fn agent_event_store() -> &'static RwLock<AgentEvents> {
    static EV: OnceLock<RwLock<AgentEvents>> = OnceLock::new();
    EV.get_or_init(|| RwLock::new((0, BTreeMap::new())))
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Append one event. `ok:false` (and a 400 from the route) for an unknown kind.
fn record_agent_event(project: &str, role: &str, event: &str, session: &str, detail: &str) -> Value {
    if !AGENT_EVENT_KINDS.contains(&event) {
        return json!({
            "ok": false,
            "error": format!("unknown event kind {event:?}"),
            "hint": format!("one of: {}", AGENT_EVENT_KINDS.join(", ")),
        });
    }
    let mut guard = agent_event_store().write().unwrap_or_else(|e| e.into_inner());
    let seq = guard.0 + 1;
    guard.0 = seq;
    let ring = guard.1.entry(project.to_string()).or_default();
    ring.push_back(AgentEvent {
        seq,
        at: now_millis(),
        role: role.to_string(),
        event: event.to_string(),
        session: session.to_string(),
        detail: detail.to_string(),
    });
    while ring.len() > AGENT_EVENT_RING {
        ring.pop_front();
    }
    json!({ "ok": true, "seq": seq })
}

/// Every retained event for `project` after `since`, plus the cursor to poll with
/// next. An unknown project is an empty list, not an error: a watcher started
/// before its first agent is the normal case, not a mistake.
fn agent_events_since(project: &str, since: u64) -> Value {
    let guard = agent_event_store().read().unwrap_or_else(|e| e.into_inner());
    let events: Vec<Value> = guard
        .1
        .get(project)
        .map(|ring| ring.iter().filter(|e| e.seq > since).map(AgentEvent::to_json).collect())
        .unwrap_or_default();
    json!({ "seq": guard.0, "events": events })
}

/// (status, content-type, body) for one request. Split out so it's testable.
/// Trusted-caller shim — the tests' entry point (no agent identity).
#[cfg(test)]
fn route(path: &str, is_post: bool, pairs: &[(String, String)], body: &str, base: &str) -> (u16, &'static str, String) {
    route_as(path, is_post, pairs, body, base, None)
}

/// The real router. `actor` is `Some` when the request authenticated with an
/// AGENT token (a swarm pane) — the task-bus writes are then gated and stamped
/// by that identity. `None` = the session token or an in-process caller.
fn route_as(path: &str, is_post: bool, pairs: &[(String, String)], body: &str, base: &str, actor: Option<&Actor>) -> (u16, &'static str, String) {
    let json_ct = "application/json";
    let text_ct = "text/plain; charset=utf-8";
    let project = || qget(pairs, "project").unwrap_or_else(|| DEFAULT_PROJECT.to_string());

    if !is_post {
        match path {
            "/" => return (200, "text/html; charset=utf-8", format!("<!doctype html><meta charset=utf-8><title>BigBrain</title><pre style='white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;max-width:820px;margin:24px auto;padding:0 16px'>{}</pre>", html_escape(&current_info(base)))),
            "/info" => return (200, text_ct, current_info(base)),
            // Deep-dive pages behind the short core /info — built-in text, never
            // touched by the POST /info override (see the "override" section).
            _ if path.starts_with("/info/") => {
                let name = &path["/info/".len()..];
                return match info_section(name, base) {
                    Some(s) => (200, text_ct, s),
                    None => (404, json_ct, pretty(&json!({
                        "error": format!("no info section '{name}'"),
                        "hint": format!("GET /info for the guide; sections: {}", INFO_SECTION_NAMES.join(", ")),
                    }))),
                };
            }
            // Machine-readable build stamp: which binary is answering, and what
            // its HTTP contract actually supports. Check it before assuming a guard.
            "/version" => return (200, json_ct, pretty(&build_stamp())),
            "/projects" => return (200, json_ct, pretty(&json!(projects()))),
            "/keys" => return (200, json_ct, pretty(&json!(keys(&project())))),
            "/tasks" => {
                let rows = filtered_tasks(pairs);
                if qget(pairs, "compact").map_or(false, |v| v != "0") {
                    return (200, text_ct, compact_tasks(&rows));
                }
                return (200, json_ct, pretty(&json!(rows)));
            }
            // Agent lifecycle events since a cursor. No long-poll variant: the
            // watchers already run on a timer, and a second /wait-shaped endpoint
            // buys nothing but another parked connection per pane.
            "/agent-events" => {
                let since = qget(pairs, "since").and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
                return (200, json_ct, pretty(&agent_events_since(&project(), since)));
            }
            // Swarm chat and reset requests, parsed. Same notes as ever (see the
            // chat section) — these just hand back rows instead of a convention.
            "/chat" => {
                let since = qget(pairs, "since").and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
                let rows = match qget(pairs, "role") {
                    Some(r) => chat_inbox(&project(), &r, since),
                    None => chat_rows(&project()).into_iter().filter(|m| m["updated"].as_u64().unwrap_or(0) > since).collect(),
                };
                return (200, json_ct, pretty(&json!(rows)));
            }
            "/resets" => return (200, json_ct, pretty(&json!(reset_requests(&project())))),
            // The host's reclaim queue (brain-findings 2.2). Readable by anyone
            // for the same reason /resets is — it is the coordinator's own record
            // of what it asked for; only the host acts on it.
            "/reclaims" => return (200, json_ct, pretty(&json!(reclaim_requests(&project())))),
            // MCP is POST-only here: this server offers no server-initiated SSE
            // stream, and the transport says say so with 405 rather than hang a
            // client waiting on events that will never come.
            "/mcp" => {
                return (405, json_ct, pretty(&json!({
                    "error": "method not allowed",
                    "hint": "the MCP endpoint takes POSTed JSON-RPC only — this server opens no SSE stream",
                })))
            }
            "/recall" => {
                let key = qget(pairs, "key");
                let q = qget(pairs, "q");
                if key.is_none() && q.is_none() {
                    return (400, json_ct, pretty(&json!({ "error": "recall needs key= or q= (won't dump a whole project)", "hint": "GET /keys?project=<name> lists a project's keys" })));
                }
                let mut rows = recall(&project(), key.as_deref(), q.as_deref());
                // Pure search (q=, no key): also point at matching notes in other projects.
                if key.is_none() {
                    if let Some(query) = q.as_deref() {
                        rows.extend(cross_project(&project(), query));
                    }
                }
                return (200, json_ct, pretty(&json!(rows)));
            }
            _ if path.starts_with("/memory/") => {
                if let Some((p, k)) = parse_memory_path(path, qget(pairs, "project").as_deref()) {
                    return match note(&p, &k) {
                        Some(v) => (200, text_ct, v),
                        None => (404, json_ct, pretty(&json!({ "error": format!("no note {p}/{k}"), "hint": format!("GET /keys?project={p} lists its keys") }))),
                    };
                }
                return (400, json_ct, pretty(&json!({ "error": "name the project: GET /memory/<project>/<key>" })));
            }
            _ => return (404, json_ct, pretty(&json!({ "error": "not found" }))),
        }
    }

    // POST
    //
    // MCP first, and on the RAW body: a JSON-RPC envelope is the one POST here
    // whose body is a protocol message rather than a bag of fields, so it must not
    // go through the query-merge below (which would happily fold `?project=` into
    // the envelope and hand the dispatcher a mangled request).
    if path == "/mcp" {
        let (code, out) = mcp::rpc_as(body, actor);
        return (code, json_ct, out);
    }
    if path == "/info" {
        let out = write_info(&body_value(body));
        let code = if out.get("error").is_some() { 500 } else { 200 };
        return (code, json_ct, pretty(&out));
    }
    if let Some(rest) = path.strip_prefix("/memory/") {
        let _ = rest;
        if let Some((p, k)) = parse_memory_path(path, qget(pairs, "project").as_deref()) {
            // Body is the note, but ?value= works too — one less quoting trap on
            // shells that mangle inline bodies.
            let mut value = body_value(body);
            if value.trim().is_empty() {
                value = qget(pairs, "value").unwrap_or_default();
            }
            if value.trim().is_empty() {
                return (400, json_ct, pretty(&json!({
                    "error": "POST body is the note value (raw text or {\"value\":\"...\"})",
                    "hint": "or pass it as a query param: POST /memory/<project>/<key>?value=<text>"
                })));
            }
            return (200, json_ct, pretty(&remember_as(&p, &k, &value, true, actor)));
        }
        return (400, json_ct, pretty(&json!({ "error": "name the project: POST /memory/<project>/<key>, body = the note value" })));
    }

    // Fields come from the JSON body OR the query string. The query-string form
    // exists because quoting JSON on a command line is a minefield: PowerShell
    // mangles the inner double quotes of `-d '{"project":"x"}'` before curl.exe
    // ever sees them, and agents burn turns fighting "bad json body". So
    //   POST /task?project=p&desc=... is always accepted, no quoting needed.
    // Body fields win when both are present.
    let parsed: Value = serde_json::from_str(if body.trim().is_empty() { "{}" } else { body })
        .unwrap_or(Value::Null);
    let mut data = match parsed {
        Value::Object(map) => Value::Object(map),
        // A body that isn't a JSON object is only fatal when there's no query
        // string to fall back on.
        _ if pairs.is_empty() => return (400, json_ct, pretty(&json!({
            "error": "bad json body",
            "hint": "pass the fields as query params instead — POST /task?project=<p>&desc=<what> (no quoting to get wrong)"
        }))),
        _ => json!({}),
    };
    for (k, v) in pairs {
        if data.get(k).is_none() {
            data[k.as_str()] = json!(v);
        }
    }
    let sfield = |k: &str| data.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    // Booleans arrive as real JSON bools from a body and as strings from the query
    // string, so both forms have to read the same. `default` is what an absent field means.
    let bfield = |k: &str, default: bool| {
        data.get(k)
            .map(|v| {
                v.as_bool()
                    .unwrap_or_else(|| matches!(v.as_str(), Some("true" | "1" | "yes" | "on" | "")))
            })
            .unwrap_or(default)
    };

    match path {
        "/forget-project" => {
            let p = sfield("project");
            if p.is_empty() { return (400, json_ct, pretty(&json!({ "error": "need project" }))); }
            (200, json_ct, pretty(&forget_project(&p)))
        }
        "/remember" => {
            let key = sfield("key");
            let value = sfield("value");
            if key.is_empty() { return (400, json_ct, pretty(&json!({ "error": "need key" }))); }
            if value.trim().is_empty() { return (400, json_ct, pretty(&json!({ "error": "need a non-empty value" }))); }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            // Query-string form gives strings, not JSON bools.
            let over = data
                .get("override")
                .map(|v| v.as_bool().unwrap_or_else(|| matches!(v.as_str(), Some("true" | "1"))))
                .unwrap_or(false);
            (200, json_ct, pretty(&remember_as(p, &key, &value, over, actor)))
        }
        "/forget" => {
            let key = sfield("key");
            if key.is_empty() { return (400, json_ct, pretty(&json!({ "error": "need key" }))); }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            (200, json_ct, pretty(&forget(p, &key)))
        }
        // Edit ONE note without resending its body. See `patch_note`.
        "/patch" => {
            let key = sfield("key");
            if key.is_empty() {
                return (400, json_ct, pretty(&json!({ "error": "need key", "hint": "POST /patch?project=<p>&key=<k>&find=<old>&replace=<new>" })));
            }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let out = patch_note(
                p,
                &key,
                &sfield("op"),
                &sfield("find"),
                &sfield("replace"),
                &sfield("text"),
                &sfield("lines"),
                bfield("all", true),
                bfield("regex", false),
                &sfield("expect"),
                bfield("dry", false),
            );
            let code = if out["ok"] == json!(false) { 400 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        // Search-and-replace across many notes. DRY RUN unless apply=1.
        "/replace" => {
            let find = sfield("find");
            if find.is_empty() {
                return (400, json_ct, pretty(&json!({
                    "error": "need find",
                    "hint": "POST /replace?project=<p>&find=<old>&replace=<new> previews; add apply=1 to write. all_projects=1 spans every project."
                })));
            }
            // Scope: one project (the default, project= or _system) unless the caller
            // explicitly asks for the whole store. Making "everything" opt-in means a
            // forgotten project= narrows the blast radius instead of widening it.
            let every = bfield("all_projects", false);
            let scope = if every {
                None
            } else {
                Some(data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT).to_string())
            };
            let limit = data
                .get("limit")
                .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(REPLACE_APPLY_LIMIT as u64) as usize;
            let out = bulk_replace(
                scope.as_deref(),
                &find,
                &sfield("replace"),
                bfield("regex", false),
                &csv(&sfield("keys")),
                bfield("include_tasks", false),
                bfield("apply", false),
                limit,
            );
            let code = if out["ok"] == json!(false) { 400 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        // One agent lifecycle event, posted by a hook in the agent's own CLI.
        // Fields ride the query string in practice — a hook command is a one-liner
        // in a JSON settings file, and nesting a quoted JSON body inside that is
        // the quoting trap the query-string form exists to avoid.
        "/agent-event" => {
            let (role, event) = (sfield("role"), sfield("event"));
            if role.trim().is_empty() || event.trim().is_empty() {
                return (400, json_ct, pretty(&json!({
                    "error": "need role + event",
                    "hint": format!("POST /agent-event?project=<p>&role=<r>&event=<{}>", AGENT_EVENT_KINDS.join("|")),
                })));
            }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let out = record_agent_event(p, role.trim(), event.trim(), &sfield("session"), &sfield("detail"));
            let code = if out["ok"] == json!(false) { 400 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        // Post a swarm message. The curl-side twin of the `chat_send` MCP tool —
        // same note, same numbering, so the two callers can't drift apart.
        "/chat" => {
            let text = sfield("text");
            if text.trim().is_empty() {
                return (400, json_ct, pretty(&json!({ "error": "need text", "hint": "POST /chat?project=<p>&from=<role>&to=<role|all>&text=<message>" })));
            }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let out = chat_send_as(p, &sfield("from"), &sfield("to"), &text, actor);
            let code = if out["ok"] == json!(false) { 500 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        "/reset-request" => {
            let role = sfield("role");
            if role.trim().is_empty() {
                return (400, json_ct, pretty(&json!({ "error": "need role", "hint": "POST /reset-request?project=<p>&role=<role>" })));
            }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let out = reset_request_as(p, &role, actor);
            let code = if out["ok"] == json!(false) { 500 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        // Take a live task's scope off its owner — the coordinator's alternative
        // to typing "please stop" into a pane and hoping it is read in time.
        // The flip happens when PixelMarch performs it, not here; see the
        // reclaim section.
        "/reclaim-request" => {
            let task = sfield("task");
            if task.trim().is_empty() {
                return (400, json_ct, pretty(&json!({ "error": "need task", "hint": "POST /reclaim-request?project=<p>&task=task-<n>&to=<role|empty to release>&why=<reason>" })));
            }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let out = request_reclaim_as(p, &task, &sfield("to"), &sfield("why"), actor);
            let code = if out["ok"] == json!(false) { 400 } else { 200 };
            (code, json_ct, pretty(&out))
        }
        "/task" => {
            let desc = sfield("desc");
            if desc.trim().is_empty() { return (400, json_ct, pretty(&json!({ "error": "need desc" }))); }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            (200, json_ct, pretty(&create_task_as(p, &desc, &sfield("files"), &sfield("status"), &sfield("role"), actor)))
        }
        "/claim" => {
            let (task, owner) = (sfield("task"), sfield("owner"));
            if task.is_empty() || owner.is_empty() { return (400, json_ct, pretty(&json!({ "error": "need task + owner" }))); }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            (200, json_ct, pretty(&claim_task_as(p, &task, &owner, actor)))
        }
        "/task-status" => {
            let (task, status) = (sfield("task"), sfield("status"));
            if task.is_empty() || status.is_empty() { return (400, json_ct, pretty(&json!({ "error": "need task + status" }))); }
            let p = data.get("project").and_then(Value::as_str).unwrap_or(DEFAULT_PROJECT);
            let owner = data.get("owner").and_then(Value::as_str);
            (200, json_ct, pretty(&set_task_status_as(p, &task, &status, owner, &sfield("log"), actor, None)))
        }
        _ => (404, json_ct, pretty(&json!({ "error": "not found" }))),
    }
}

/// `/memory/<project>/<key>` (key may contain '/'), or `/memory/<key>?project=`.
fn parse_memory_path(path: &str, qproject: Option<&str>) -> Option<(String, String)> {
    let parts: Vec<String> = path.trim_start_matches("/memory/").split('/').filter(|p| !p.is_empty()).map(pct_decode).collect();
    if parts.len() >= 2 {
        Some((parts[0].clone(), parts[1..].join("/")))
    } else if let (Some(k), Some(p)) = (parts.first(), qproject) {
        Some((p.to_string(), k.clone()))
    } else {
        None
    }
}

/// A POST /memory body → the note value: raw text, a JSON string, or {"value": ...}.
fn body_value(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(Value::String(s)) => s,
        Ok(Value::Object(m)) => m.get("value").and_then(Value::as_str).map(String::from).unwrap_or_else(|| body.to_string()),
        _ => body.to_string(),
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "null".into())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DNS REBINDING. The `Origin` check cannot see this attack: a page served from
    /// `http://evil.example` whose DNS is re-pointed at 127.0.0.1 is talking to its
    /// own origin, so the browser sends no `Origin` header at all. The `Host` header
    /// is what it cannot lie about — it still names `evil.example`.
    #[test]
    fn a_request_addressed_to_a_non_loopback_name_is_refused() {
        // The names an agent's curl actually sends.
        assert!(host_header_is_loopback(Some("127.0.0.1")));
        assert!(host_header_is_loopback(Some("localhost")));
        assert!(host_header_is_loopback(Some("::1")));
        assert!(host_header_is_loopback(Some("127.5.5.5"))); // whole 127/8
        // No Host at all is HTTP/1.0 or a raw socket, not a browser — and a rebinding
        // attack cannot produce it. Refusing it would break those clients for nothing.
        assert!(host_header_is_loopback(None));

        // The attack, and the near-misses a prefix check would wave through.
        assert!(!host_header_is_loopback(Some("evil.example")));
        assert!(!host_header_is_loopback(Some("localhost.evil.example")));
        assert!(!host_header_is_loopback(Some("127.0.0.1.evil.example")));
        assert!(!host_header_is_loopback(Some("192.168.1.10")));
        assert!(!host_header_is_loopback(Some("10.0.0.1")));
    }

    /// The port has to come off first, and `[::1]:8734` does not split like
    /// `127.0.0.1:8734` — getting that wrong would refuse every real request.
    #[test]
    fn the_host_header_is_parsed_the_way_browsers_and_curl_write_it() {
        let parse = |raw: &str| {
            let raw = raw.trim().to_ascii_lowercase();
            let host = match raw.strip_prefix('[') {
                Some(rest) => rest.split(']').next().unwrap_or(rest).to_string(),
                None => raw.split(':').next().unwrap_or(&raw).to_string(),
            };
            (!host.is_empty()).then_some(host)
        };
        assert_eq!(parse("127.0.0.1:8734").as_deref(), Some("127.0.0.1"));
        assert_eq!(parse("[::1]:8734").as_deref(), Some("::1"));
        assert_eq!(parse("LOCALHOST:8734").as_deref(), Some("localhost"));
        assert_eq!(parse(" evil.example ").as_deref(), Some("evil.example"));
        assert_eq!(parse(""), None);
        // ...and the values that parse feed the guard correctly.
        assert!(host_header_is_loopback(parse("[::1]:8734").as_deref()));
        assert!(!host_header_is_loopback(parse("evil.example:8734").as_deref()));
    }

    /// A body read has to be bounded or any local process can hand the host an
    /// out-of-memory kill — and the host owns every terminal session.
    #[test]
    fn a_post_body_is_read_under_a_cap() {
        use std::io::Read;
        /// A client that promises a note and then never stops sending.
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'a');
                Ok(buf.len())
            }
        }
        let mut body = String::new();
        let n = Endless.take(MAX_BODY_BYTES).read_to_string(&mut body).unwrap();
        assert_eq!(n as u64, MAX_BODY_BYTES);
        assert_eq!(body.len() as u64, MAX_BODY_BYTES, "the read stops at the cap");
        // A real note is nowhere near it — this must never be a limit anyone meets.
        let mut small = String::new();
        std::io::Cursor::new(b"branch swarm/task-5: hardened the update path".to_vec())
            .take(MAX_BODY_BYTES)
            .read_to_string(&mut small)
            .unwrap();
        assert!(small.starts_with("branch swarm/task-5"));
    }

    /// PATH TRAVERSAL. Every note path is `root()/<project>/<key>.md` with both
    /// segments through `safe_seg`, so a caller-supplied `..`, absolute path or
    /// separator cannot name a file outside the brain directory — and the `.md`
    /// suffix means it cannot name a non-note even inside it.
    #[test]
    fn no_request_can_name_a_file_outside_the_brain_directory() {
        let brain = root();
        for (project, key) in [
            ("..", ".."),
            ("../../..", "../../../etc/passwd"),
            ("/etc", "/etc/cron.d/pwn"),
            ("..\\..\\Windows", "System32\\x"),
            ("proj", "../../../../../../root/.ssh/authorized_keys"),
            ("proj", "....//....//etc/shadow"),
            ("", ""),
            (".", "."),
            ("....", "...."),
        ] {
            let p = note_path(project, key);
            assert!(p.starts_with(&brain), "{project:?}/{key:?} escaped to {}", p.display());
            assert_eq!(
                p.components().count(),
                brain.components().count() + 2,
                "{project:?}/{key:?} produced a path of the wrong depth: {}",
                p.display()
            );
            assert!(
                p.extension().is_some_and(|e| e == "md"),
                "{project:?}/{key:?} named a non-note: {}",
                p.display()
            );
            assert!(
                !p.to_string_lossy().contains(".."),
                "{project:?}/{key:?} left a traversal segment: {}",
                p.display()
            );
        }
    }

    /// ...and the sanitizer is round-trippable, so a write and the read that follows
    /// it agree. A traversal fix that silently renamed notes would lose them.
    #[test]
    fn sanitizing_is_stable_under_repetition() {
        for s in ["../escape", "BigBrain/Info", "auth-flow", "..", "a b c", "task-5"] {
            let once = safe_seg(s);
            assert_eq!(safe_seg(&once), once, "safe_seg({s:?}) is not idempotent");
            assert!(!once.is_empty());
        }
    }

    #[test]
    fn note_hit_is_prefix_and_semantics() {
        let toks = tokens("auth jwt");
        assert!(note_hit(&toks, "auth-flow login uses JWT tokens"));
        assert!(!note_hit(&toks, "auth only, no tokens here")); // 'jwt' missing
        assert!(note_hit(&tokens("data"), "database schema")); // prefix match
    }

    #[test]
    fn safe_seg_flattens_and_guards() {
        assert_eq!(safe_seg("BigBrain/Info"), "BigBrain-Info");
        assert_eq!(safe_seg("../escape"), "escape");
        assert_eq!(safe_seg("auth-flow"), "auth-flow");
        assert_eq!(safe_seg("   "), "_");
    }

    #[test]
    fn parse_memory_path_forms() {
        assert_eq!(parse_memory_path("/memory/proj/auth-flow", None), Some(("proj".into(), "auth-flow".into())));
        assert_eq!(parse_memory_path("/memory/_system/BigBrain/Info", None), Some(("_system".into(), "BigBrain/Info".into())));
        assert_eq!(parse_memory_path("/memory/auth-flow", Some("proj")), Some(("proj".into(), "auth-flow".into())));
        assert_eq!(parse_memory_path("/memory/auth-flow", None), None);
    }

    #[test]
    fn info_override_roundtrip() {
        // info.md is a single global file — stash any real override and restore it.
        let prev = std::fs::read_to_string(info_override_path()).ok();
        assert_eq!(write_info("custom guide for {base}")["ok"], true);
        assert_eq!(info_body("http://x"), "custom guide for http://x");
        // The override replaces the CORE page only — every section still serves
        // this build's text, so house rules cannot shadow the deep dives.
        let (code, _, body) = route("/info/search", false, &[], "", "http://x");
        assert_eq!(code, 200);
        assert_eq!(body, info_section("search", "http://x").unwrap());
        assert_eq!(write_info("")["reset"], true);
        assert_eq!(info_body("http://x"), info_text("http://x"));
        // the stamp leads either way — an override cannot hide which binary answers
        assert!(current_info("http://x").starts_with("BUILD pixelmarch "));
        match prev {
            Some(p) => { let _ = std::fs::write(info_override_path(), p); }
            None => { let _ = std::fs::remove_file(info_override_path()); }
        }
    }

    /// The whole point of the split: the common path (CLAUDE.md sends every repo
    /// agent to /info) stays a few KB, and it tells the reader where the rest went.
    #[test]
    fn the_core_info_page_is_short_and_points_at_every_section() {
        let core = info_text("http://x");
        assert!(core.len() < 4096, "core /info must stay small, is {} bytes", core.len());
        // What the core page must still carry on its own: the loop, the token
        // rule, rule 0, and the map.
        for keep in ["$BIGBRAIN_URL", "X-Brain-Token", "/recall?project=", "RECALL", "REMEMBER",
                     "project_settings", "/version", "/patch", "/replace", "/claim", "/wait", "/mcp"] {
            assert!(core.contains(keep), "core page lost {keep:?}");
        }
        for name in INFO_SECTION_NAMES {
            assert!(core.contains(name), "core page must point at section {name}");
            assert!(info_section(name, "http://x").is_some(), "listed section {name} must exist");
        }
    }

    /// Every fact that moved off the big page is still reachable — spot-check the
    /// load-bearing lines of each section, over the route an agent actually hits.
    #[test]
    fn every_info_section_serves_its_moved_material() {
        let needles: &[(&str, &[&str])] = &[
            ("search", &["prefix", "elsewhere", "/keys?project="]),
            ("editing", &["op=delete-lines", "expect=", "dry=1", "REGEX TRAP", "CRLF"]),
            ("bulk", &["apply=1", "DRY RUN", "all_projects=1", "include_tasks=1", "limit="]),
            ("freshness", &["rescan", "500 ms", "/wait"]),
            ("windows", &["curl.exe", "Invoke-RestMethod", "query param", "--data-binary"]),
            ("tasks", &["mine=", "timeout=55", "plan", "compact=1", "/reset-request"]),
            ("mcp", &["tasks_list", "note_patch", "JSON-RPC"]),
            ("conventions", &["lower-kebab-case", "similar", "override", "[[key]]"]),
            ("override", &["info.md", "BUILD line", "CORS", "built-in"]),
        ];
        assert_eq!(needles.len(), INFO_SECTION_NAMES.len(), "every section gets a spot-check");
        for (name, wants) in needles {
            let (code, ctype, body) = route(&format!("/info/{name}"), false, &[], "", "http://x");
            assert_eq!(code, 200, "/info/{name}");
            assert!(ctype.starts_with("text/plain"), "sections are plain text like /info");
            for w in *wants {
                assert!(body.contains(w), "/info/{name} lost {w:?}");
            }
        }
        // An unknown section is a 404 that lists the real ones — a typo self-corrects.
        let (code, _, body) = route("/info/serach", false, &[], "", "http://x");
        assert_eq!(code, 404);
        let err: Value = serde_json::from_str(&body).unwrap();
        for name in INFO_SECTION_NAMES {
            assert!(err["hint"].as_str().unwrap().contains(name), "404 hint must list {name}");
        }
    }

    #[test]
    fn build_stamp_is_populated_and_served() {
        let s = build_stamp();
        // build.rs must have injected all three; a missing env! wouldn't compile,
        // an EMPTY one would ship a stamp that identifies nothing.
        assert!(!s["version"].as_str().unwrap().is_empty());
        assert!(!s["commit"].as_str().unwrap().is_empty());
        assert!(s["built"].as_str().unwrap().ends_with('Z'));
        assert_eq!(s["api"], BRAIN_API_VERSION);
        // every guard callers depend on is claimed by name
        for want in ["tasks-mine-filter", "claim-plan-gate", "query-string-post", "cors-deny",
                     "host-header-guard", "body-size-cap",
                     "note-patch", "note-patch-lines", "note-patch-expect", "note-patch-regex",
                     "bulk-replace", "bulk-replace-dry-run",
                     "mcp", "chat-routed", "reset-requests", "info-sections"] {
            assert!(CAPABILITIES.contains(&want), "capability {want} missing");
        }

        let (code, ct, body) = route("/version", false, &[], "", "http://x");
        assert_eq!(code, 200);
        assert_eq!(ct, "application/json");
        let served: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(served, s);

        // …and the human form leads /info so an agent reading the guide sees it
        let (_, _, info) = route("/info", false, &[], "", "http://x");
        assert!(info.starts_with("BUILD pixelmarch "));
        assert!(info.contains("/version"));
    }

    #[test]
    fn projects_lists_a_note_less_project() {
        // a project created out-of-band must be visible BEFORE its first note,
        // else the panel looks like the create silently failed.
        let p = format!("_bt_empty_{}", std::process::id());
        let _ = forget_project(&p);
        create_project(&p).unwrap();
        assert!(keys(&p).is_empty());
        assert!(projects().contains(&p), "empty project {p} is invisible");
        let _ = forget_project(&p);
        assert!(!projects().contains(&p));
    }

    #[test]
    fn body_value_forgiving() {
        assert_eq!(body_value("raw text"), "raw text");
        assert_eq!(body_value("\"a json string\""), "a json string");
        assert_eq!(body_value("{\"value\":\"from json\"}"), "from json");
    }

    #[test]
    fn pct_decode_basics() {
        assert_eq!(pct_decode("two%20words"), "two words");
        assert_eq!(pct_decode("a+b"), "a b");
        assert_eq!(pct_decode("plain"), "plain");
    }

    #[test]
    fn remember_recall_roundtrip_and_dup() {
        // isolate the store under a temp exe-dir override is overkill; use the real
        // root but a throwaway project name, and clean up after.
        let proj = format!("_bt_{}", std::process::id());
        let _ = forget_project(&proj);
        assert_eq!(remember(&proj, "auth-flow", "login uses JWT in auth.rs", true)["ok"], true);
        let rows = recall(&proj, None, Some("jwt"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["key"], "auth-flow");
        // a near-duplicate under a new key is refused without override
        let dup = remember(&proj, "authentication", "login uses JWT in auth.rs", false);
        assert_eq!(dup["ok"], false);
        let _ = forget_project(&proj);
    }

    #[test]
    fn task_bus_create_claim_status() {
        let p = format!("_bt_t_{}", std::process::id());
        let _ = forget_project(&p);

        let c = create_task(&p, "wire the CSV endpoint", "src/api.rs", "", "");
        assert_eq!(c["ok"], true);
        assert_eq!(c["key"], "task-1");
        assert_eq!(create_task(&p, "second", "", "blocked", "")["key"], "task-2");

        let list = tasks(&p);
        assert_eq!(list.len(), 2);
        // builder tasks default to blocked — the coordinator opens them post-batch
        assert_eq!(list[0]["status"], "blocked");
        assert_eq!(list[0]["files"], "src/api.rs");
        assert_eq!(list[1]["status"], "blocked");
        assert_eq!(set_task_status(&p, "task-1", "open", None, "")["ok"], true);

        // open builder task is still unclaimable until the plan note exists
        let early = claim_task(&p, "task-1", "builder-1");
        assert_eq!(early["ok"], false);
        assert_eq!(early["reason"], "no plan yet");
        write_note(&p, "plan", "task-1 wire csv · task-2 second").unwrap();

        // first claim wins, second bounces
        assert_eq!(claim_task(&p, "task-1", "builder-1")["ok"], true);
        let dup = claim_task(&p, "task-1", "builder-2");
        assert_eq!(dup["ok"], false);
        assert_eq!(dup["owner"], "builder-1");
        // blocked tasks are not claimable
        assert_eq!(claim_task(&p, "task-2", "builder-2")["ok"], false);

        // status transition + log line survive a re-parse
        assert_eq!(set_task_status(&p, "task-1", "done", None, "added endpoint + test")["ok"], true);
        let t1 = &tasks(&p)[0];
        assert_eq!(t1["status"], "done");
        assert_eq!(t1["owner"], "builder-1");
        assert!(t1["desc"].as_str().unwrap().contains("added endpoint + test"));

        // a task re-opened with its owner intact stays with that builder: the
        // owner may re-claim it, everyone else still bounces
        assert_eq!(set_task_status(&p, "task-1", "open", None, "")["ok"], true);
        assert_eq!(claim_task(&p, "task-1", "builder-2")["ok"], false);
        assert_eq!(claim_task(&p, "task-1", "builder-1")["ok"], true);

        let _ = forget_project(&p);
    }

    /// A handed-back task is its OWNER'S to redo, and /claim is not the door —
    /// but the refusal used to hint "pick another open task", which is how a live
    /// builder (pixelmarch_game swarm, task-4) bounced off an empty bus on every
    /// `changes` wake until its context was gone. The refusal stands; the hint
    /// names the retake call.
    #[test]
    fn a_changes_task_refuses_its_owners_claim_but_points_at_the_retake() {
        let p = format!("_bt_retake_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "plan", "task-1 combat").unwrap();
        assert_eq!(create_task(&p, "combat", "src/combat.rs", "open", "")["key"], "task-1");
        assert_eq!(claim_task(&p, "task-1", "builder-1")["ok"], true);
        assert_eq!(set_task_status(&p, "task-1", "done", None, "")["ok"], true);
        assert_eq!(set_task_status(&p, "task-1", "changes", None, "three findings")["ok"], true);

        let refused = claim_task(&p, "task-1", "builder-1");
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "not claimable");
        let hint = refused["hint"].as_str().unwrap();
        assert!(hint.contains("YOURS to redo"), "{hint}");
        assert!(hint.contains("task_status"), "{hint}");
        assert!(hint.contains("\"claimed\""), "{hint}");
        // someone else asking gets the ordinary hint, not an invitation to retake
        let other = claim_task(&p, "task-1", "builder-2");
        assert_eq!(other["hint"], "pick another open task");
        // and the retake itself works, so the hint is not pointing at a wall
        assert_eq!(set_task_status(&p, "task-1", "claimed", Some("builder-1"), "")["ok"], true);
        assert_eq!(tasks(&p)[0]["status"], "claimed");

        let _ = forget_project(&p);
    }

    /// THE CLOBBER (live incident, swarm local_rummy_500): a builder that could not
    /// get its `task_status` call through wrote the call's ARGUMENTS into the task
    /// note with a plain note write, erasing the header. The bus then read a finished
    /// task as `open / owner - / files -`: work looked unstarted, its file scope was
    /// released, the reviewer's `approved` was refused for "not done", and the owner
    /// reported the task missing. Three separate things have to hold so that cannot
    /// repeat — the write is refused, a headerless note reads as `malformed` rather
    /// than as fresh work, and only the coordinator can move a malformed task.
    #[test]
    fn a_task_note_is_state_and_a_plain_note_write_cannot_rewrite_it() {
        let p = format!("_bt_clobber_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "plan", "task-1 the visual layer").unwrap();
        let coord = Actor { project: p.clone(), role: "coordinator".into() };
        let b1 = Actor { project: p.clone(), role: "builder-1".into() };
        let rev = Actor { project: p.clone(), role: "reviewer-1".into() };
        assert_eq!(create_task_as(&p, "card visuals", "scenes/card.tscn", "open", "builder", Some(&coord))["ok"], true);
        assert_eq!(claim_task_as(&p, "task-1", "builder-1", Some(&b1))["ok"], true);

        // 1. The exact write that did it — the task_status payload as the note body.
        let payload = r#"{"status":"done","log":"branch swarm/task-1: card visuals"}"#;
        let refused = remember_as(&p, "task-1", payload, true, Some(&b1));
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["reason"], "task note is task state");
        assert!(refused["hint"].as_str().unwrap().contains("task_status"));
        // Refused for a trusted caller too: the note manager (write_note) is the
        // hand-edit door, not the note-write API.
        assert_eq!(remember(&p, "task-1", payload, true)["ok"], false);
        // The state behind the refusal is untouched.
        assert_eq!(tasks(&p)[0]["status"], "claimed");
        assert_eq!(tasks(&p)[0]["owner"], "builder-1");
        assert_eq!(tasks(&p)[0]["files"], "scenes/card.tscn");
        // Editing a task's TEXT is still allowed — that is what note_patch is for.
        assert_eq!(patch_note(&p, "task-1", "", "card visuals", "card visuals + backs", "", "", true, false, "", false)["ok"], true);
        assert_eq!(tasks(&p)[0]["status"], "claimed", "a patch must not disturb the header");

        // The protocol is host-owned: an agent cannot rewrite the contract the rest
        // of the swarm is reading, but the host's own seeding still lands.
        assert_eq!(remember_as(&p, "protocol-core", "1", true, Some(&b1))["reason"], "protocol note is host-owned");
        assert_eq!(remember(&p, "protocol-core", "the contract", true)["ok"], true);

        // 2. A note that lost its header anyway (an out-of-band edit, a pre-guard
        // swarm) reads as malformed — NOT as a fresh open task.
        write_note(&p, "task-1", payload).unwrap();
        let t = &tasks(&p)[0];
        assert_eq!(t["status"], MALFORMED);
        assert_eq!(t["owner"], "");
        // It is not claimable, so no builder picks up work whose real state is unknown.
        let claim = claim_task_as(&p, "task-1", "builder-2", Some(&Actor { project: p.clone(), role: "builder-2".into() }));
        assert_eq!(claim["ok"], false);
        assert_eq!(claim["status"], MALFORMED);

        // 3. Only the coordinator moves it off malformed — a builder re-posting
        // "done" and a reviewer approving it are both guesses about lost state.
        assert_eq!(set_task_status_as(&p, "task-1", "done", None, "", Some(&b1), None)["reason"], "task note malformed");
        assert_eq!(set_task_status_as(&p, "task-1", "approved", None, "", Some(&rev), None)["reason"], "task note malformed");
        let fixed = set_task_status_as(&p, "task-1", "open", None, "header rebuilt", Some(&coord), None);
        assert_eq!(fixed["ok"], true, "{fixed}");
        assert_eq!(tasks(&p)[0]["status"], "open");

        let _ = forget_project(&p);
    }

    /// Normalisation is the whole guard: the `files` field is hand-written by an
    /// LLM, so ` src/lib/swarm.ts ` and `src/lib/swarm.ts` are one path, and a
    /// comparison that misses that lets the overlap through.
    #[test]
    fn scope_paths_normalise_the_way_agents_actually_write_them() {
        assert_eq!(scope_paths(" src/lib/swarm.ts , src/lib/swarm.ts"), vec!["src/lib/swarm.ts"]);
        assert_eq!(scope_paths("./src/A.rs, SRC/a.rs"), vec!["src/a.rs"]);
        assert_eq!(scope_paths("src\\brain\\mod.rs"), vec!["src/brain/mod.rs"]);
        assert_eq!(scope_paths("\"src/a.rs\", 'src/b.rs'"), vec!["src/a.rs", "src/b.rs"]);
        assert_eq!(scope_paths("src//a.rs, /src/b.rs/"), vec!["src/a.rs", "src/b.rs"]);
        // no scope at all — including the "-" placeholder render_task writes
        assert!(scope_paths("").is_empty());
        assert!(scope_paths("-").is_empty());
        assert!(scope_paths(" , , ").is_empty());

        // a directory owns the files under it, and nothing else
        assert!(scopes_overlap("src/brain", "src/brain/mod.rs"));
        assert!(scopes_overlap("src/brain/mod.rs", "src/brain"));
        assert!(scopes_overlap("src/a.rs", "src/a.rs"));
        assert!(!scopes_overlap("src/brain", "src/brainstorm/x.rs"));
        assert!(!scopes_overlap("src/a.rs", "src/b.rs"));
    }

    /// THE THIRD LEG. The claim guard blocks "two owners, one task"; this blocks
    /// "two tasks, one scope" — the failure that cost a full competing
    /// implementation (notes two-builders-one-scope, salvage-task-11-branch).
    #[test]
    fn a_second_task_over_a_live_tasks_files_is_refused() {
        let p = format!("_bt_scope_{}", std::process::id());
        let _ = forget_project(&p);

        assert_eq!(create_task(&p, "own the swarm lib", "src/lib/swarm.ts, src/lib/swarm.test.ts", "open", "")["ok"], true);

        // exact path, only written differently — refused, and the refusal SAYS who owns it
        let dup = create_task(&p, "re-home the swarm lib work", " SRC/lib/Swarm.ts ", "open", "");
        assert_eq!(dup["ok"], false, "{dup}");
        assert_eq!(dup["reason"], "scope overlap");
        assert_eq!(dup["task"], "task-1");
        let hint = dup["hint"].as_str().unwrap();
        assert!(hint.contains("task-1"), "{hint}");
        assert!(hint.contains("correction-task-1-scope"), "the sanctioned move must be in the message: {hint}");
        assert_eq!(tasks(&p).len(), 1, "the refused task must not have been written");

        // a directory that contains a live task's file is the same collision
        assert_eq!(create_task(&p, "sweep the lib", "src/lib", "open", "")["reason"], "scope overlap");

        // untouched paths are fine, and so is a task with no files at all
        assert_eq!(create_task(&p, "different scope", "src/components/Gallery.tsx", "open", "")["ok"], true);
        assert_eq!(create_task(&p, "no files declared", "", "open", "")["ok"], true);
        assert_eq!(create_task(&p, "placeholder files", "-", "open", "")["ok"], true);

        // claimed and changes are live scope too — a builder is mid-edit there
        assert_eq!(set_task_status(&p, "task-2", "claimed", Some("builder-1"), "")["ok"], true);
        assert_eq!(create_task(&p, "steal the gallery", "src/components/Gallery.tsx", "open", "")["reason"], "scope overlap");
        assert_eq!(set_task_status(&p, "task-2", "changes", None, "")["ok"], true);
        assert_eq!(create_task(&p, "steal it again", "src/components/gallery.tsx", "open", "")["reason"], "scope overlap");

        // ...but a task that has RELEASED its files no longer blocks anything:
        // merged/approved/done/blocked are all finished-with-the-scope states.
        for (task, done_status, files) in [
            ("task-2", "merged", "src/components/Gallery.tsx"),
            ("task-1", "done", "src/lib/swarm.ts"),
        ] {
            assert_eq!(set_task_status(&p, task, done_status, None, "")["ok"], true);
            let follow = create_task(&p, "follow-up on the same files", files, "open", "");
            assert_eq!(follow["ok"], true, "{done_status} must not hold scope: {follow}");
            // the follow-up is itself live now, so it holds the scope from here
            assert_eq!(set_task_status(&p, follow["key"].as_str().unwrap(), "merged", None, "")["ok"], true);
        }
        // approved (waiting on the host's merge) and blocked (parked) are likewise
        // not live scope — see LIVE_SCOPE_STATUSES for why blocked is the soft spot.
        let parked = create_task(&p, "parked work", "src/parked.rs", "blocked", "");
        assert_eq!(create_task(&p, "same parked files", "src/parked.rs", "open", "")["ok"], true, "{parked}");
        let gated = create_task(&p, "awaiting merge", "src/gated.rs", "done", "");
        assert_eq!(set_task_status(&p, gated["key"].as_str().unwrap(), "approved", None, "")["ok"], true);
        assert_eq!(create_task(&p, "same gated files", "src/gated.rs", "blocked", "")["ok"], true);

        let _ = forget_project(&p);
    }

    /// The task-lifecycle guard is the backbone of the swarm rewrite: with an
    /// AGENT actor, WHO is asking decides what a task write may do, so the
    /// failure seen live (a builder posting done for work it didn't own,
    /// self-approving, and self-merging) is refused by the server, not by a
    /// brief nobody enforced (finding-builder-continues-after-done).
    #[test]
    fn an_agent_can_only_move_its_own_task_and_never_merges_or_self_approves() {
        let p = format!("_bt_actor_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "plan", "task-1").unwrap();
        let coord = Actor { project: p.clone(), role: "coordinator".into() };
        let b1 = Actor { project: p.clone(), role: "builder-1".into() };
        let b2 = Actor { project: p.clone(), role: "builder-2".into() };
        let rev = Actor { project: p.clone(), role: "reviewer-1".into() };

        // A builder cannot create tasks — only the coordinator (or the host).
        assert_eq!(create_task_as(&p, "sneaky", "", "open", "builder", Some(&b1))["reason"], "coordinator only");
        let made = create_task_as(&p, "real work", "src/a.rs", "open", "builder", Some(&coord));
        assert_eq!(made["ok"], true, "{made}");

        // A claim's owner IS the actor: builder-1 claims as itself whatever it sends.
        let claim = claim_task_as(&p, "task-1", "builder-2", Some(&b1));
        assert_eq!(claim["ok"], true, "{claim}");
        assert_eq!(tasks(&p)[0]["owner"], "builder-1", "the actor, not the sent owner, owns it");

        // builder-2 cannot post done on builder-1's task.
        assert_eq!(set_task_status_as(&p, "task-1", "done", None, "", Some(&b2), None)["reason"], "not the owner");
        // builder-1 can.
        assert_eq!(set_task_status_as(&p, "task-1", "done", None, "did it", Some(&b1), None)["ok"], true);
        // The log line is attributed to the ACTOR, not to any claimed name.
        assert!(note(&p, "task-1").unwrap().contains("[done by builder-1]"));

        // builder-1 cannot approve its own work (it is not a reviewer); a reviewer can.
        assert_eq!(set_task_status_as(&p, "task-1", "approved", None, "", Some(&b1), None)["reason"], "not a reviewer");
        assert_eq!(set_task_status_as(&p, "task-1", "approved", None, "", Some(&rev), None)["ok"], true);

        // NO agent may post "merged" — that is the host's alone.
        assert_eq!(set_task_status_as(&p, "task-1", "merged", None, "", Some(&rev), None)["reason"], "host merges");
        assert_eq!(set_task_status_as(&p, "task-1", "merged", None, "", Some(&coord), None)["reason"], "host merges");
        // The host (no actor) merges, attributed to "host".
        assert_eq!(set_task_status_as(&p, "task-1", "merged", None, "landed", None, Some("host"))["ok"], true);
        assert!(note(&p, "task-1").unwrap().contains("[merged by host]"));

        // A token for another project cannot touch this one.
        let other = Actor { project: "someone-else".into(), role: "builder-1".into() };
        assert_eq!(claim_task_as(&p, "task-1", "builder-1", Some(&other))["reason"], "wrong project");

        // chat + reset are stamped with the actor, so no pane speaks as another.
        let msg = chat_send_as(&p, "coordinator", "all", "hi", Some(&b1));
        assert_eq!(msg["from"], "builder-1", "the sender is the actor, not the claimed from");
        let rr = reset_request_as(&p, "coordinator", Some(&b2));
        assert_eq!(rr["role"], "builder-2");
        assert!(note(&p, "reset-builder-2").is_some());

        let _ = forget_project(&p);
    }

    /// CANCEL is the human's, from PixelMarch's mission board: the host writes it
    /// (no actor), no agent can post it, and — the half that matters — no agent can
    /// move a task OFF it. A cancel that a coordinator could undo by re-opening the
    /// task, or an owner by posting the `done` it was halfway through, would restart
    /// exactly the work the human stopped.
    #[test]
    fn only_the_host_cancels_a_task_and_no_agent_moves_it_off_cancelled() {
        let p = format!("_bt_cancel_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "plan", "task-1").unwrap();
        let coord = Actor { project: p.clone(), role: "coordinator".into() };
        let b1 = Actor { project: p.clone(), role: "builder-1".into() };
        let rev = Actor { project: p.clone(), role: "reviewer-1".into() };
        assert_eq!(create_task_as(&p, "work the human changed their mind about", "src/a.rs", "open", "builder", Some(&coord))["ok"], true);
        assert_eq!(claim_task_as(&p, "task-1", "builder-1", Some(&b1))["ok"], true);

        // No agent posts it — not the owner, not the coordinator.
        assert_eq!(set_task_status_as(&p, "task-1", CANCELLED, None, "", Some(&b1), None)["reason"], "human cancels");
        assert_eq!(set_task_status_as(&p, "task-1", CANCELLED, None, "", Some(&coord), None)["reason"], "human cancels");

        // The host does, attributed to "host".
        assert_eq!(set_task_status_as(&p, "task-1", CANCELLED, None, "cancelled from the mission board", None, Some("host"))["ok"], true);
        assert_eq!(tasks(&p)[0]["status"], CANCELLED);
        assert!(note(&p, "task-1").unwrap().contains("[cancelled by host]"));

        // And it is a WALL from the agent side, whoever asks and whatever they ask for.
        for (actor, next) in [(&b1, "done"), (&b1, "claimed"), (&coord, "open"), (&coord, "blocked"), (&rev, "approved")] {
            let out = set_task_status_as(&p, "task-1", next, None, "", Some(actor), None);
            assert_eq!(out["reason"], "task cancelled", "{next} by {} should be refused: {out}", actor.role);
        }
        assert_eq!(tasks(&p)[0]["status"], CANCELLED, "nothing moved it");
        // Nor can it be re-claimed through the atomic path.
        assert_eq!(claim_task_as(&p, "task-1", "builder-1", Some(&b1))["ok"], false);

        // The host can still undo its own cancel — the human owns both directions.
        assert_eq!(set_task_status_as(&p, "task-1", "open", None, "human reopened it", None, Some("host"))["ok"], true);
        assert_eq!(tasks(&p)[0]["status"], "open");

        let _ = forget_project(&p);
    }

    /// SCOPE RECLAIM (brain-findings 2.2). The request is coordinator-only and
    /// changes NOTHING on its own — the flip is the host's half, so the two can
    /// never be separated into "the task is someone else's now" plus "…and its
    /// old owner is still running". Statuses past the builder's hands are refused.
    #[test]
    fn a_reclaim_is_requested_by_the_coordinator_and_only_the_host_flips_the_owner() {
        let p = format!("_bt_reclaim_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "plan", "task-1 task-2").unwrap();
        let coord = Actor { project: p.clone(), role: "coordinator".into() };
        let b1 = Actor { project: p.clone(), role: "builder-1".into() };
        let rev = Actor { project: p.clone(), role: "reviewer-1".into() };
        assert_eq!(create_task_as(&p, "the contested work", "src/a.rs", "open", "builder", Some(&coord))["ok"], true);
        assert_eq!(claim_task_as(&p, "task-1", "builder-1", Some(&b1))["ok"], true);

        // Only the coordinator may ask: this resets someone else's pane.
        assert_eq!(request_reclaim_as(&p, "task-1", "builder-2", "", Some(&b1))["reason"], "coordinator only");
        assert_eq!(request_reclaim_as(&p, "task-1", "builder-2", "", Some(&rev))["reason"], "coordinator only");
        let req = request_reclaim_as(&p, "task-1", "builder-2", "duplicate work", Some(&coord));
        assert_eq!(req["ok"], true, "{req}");
        assert_eq!(req["from"], "builder-1");
        assert_eq!(req["pending"], true);

        // THE REQUEST ALONE CHANGES NOTHING — builder-1 still owns it. The flip
        // only happens with the pane wipe, which only the host can perform.
        assert_eq!(tasks(&p)[0]["owner"], "builder-1");
        assert_eq!(tasks(&p)[0]["status"], "claimed");
        let queued = reclaim_requests(&p);
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["task"], "task-1");
        assert_eq!(queued[0]["from"], "builder-1");
        assert_eq!(queued[0]["to"], "builder-2");
        assert_eq!(queued[0]["why"], "duplicate work");

        // The host half: owner flipped, handed straight to the new builder as
        // claimed (never left open for a third builder to grab), history kept.
        let done = reclaim_task(&p, "task-1", "builder-2");
        assert_eq!(done["ok"], true, "{done}");
        assert_eq!(done["from"], "builder-1");
        assert_eq!(tasks(&p)[0]["owner"], "builder-2");
        assert_eq!(tasks(&p)[0]["status"], "claimed");
        assert!(note(&p, "task-1").unwrap().contains("scope reclaimed from builder-1"));

        // Retried (the pane wipe failed and the host tries again): idempotent, so
        // the task does not collect one identical log line per retry.
        let again = reclaim_task(&p, "task-1", "builder-2");
        assert_eq!(again["already"], true, "{again}");
        assert_eq!(note(&p, "task-1").unwrap().matches("scope reclaimed").count(), 1);

        // No target = released back to the pool, unowned and open.
        assert_eq!(reclaim_task(&p, "task-1", "")["status"], "open");
        assert_eq!(tasks(&p)[0]["owner"], "");

        // Past the builder's hands = refused on BOTH halves. A done/approved task
        // belongs to the reviewer or the merge gate; taking it back there would
        // race them, not a live builder.
        assert_eq!(create_task_as(&p, "already finished", "src/b.rs", "open", "builder", Some(&coord))["ok"], true);
        assert_eq!(claim_task_as(&p, "task-2", "builder-1", Some(&b1))["ok"], true);
        assert_eq!(set_task_status_as(&p, "task-2", "done", None, "built", Some(&b1), None)["ok"], true);
        assert_eq!(request_reclaim_as(&p, "task-2", "builder-2", "", Some(&coord))["reason"], "not reclaimable");
        assert_eq!(reclaim_task(&p, "task-2", "builder-2")["reason"], "not reclaimable");
        assert_eq!(tasks(&p)[1]["owner"], "builder-1", "a refused reclaim changes nothing");

        // Asking for the owner it already has is a no-op, not a pane reset.
        assert_eq!(request_reclaim_as(&p, "task-1", "", "", Some(&coord))["ok"], true);
        assert_eq!(claim_task_as(&p, "task-1", "builder-2", None)["ok"], true);
        assert_eq!(request_reclaim_as(&p, "task-1", "builder-2", "", Some(&coord))["reason"], "already the owner");

        // A coordinator token for another project cannot reclaim here.
        let elsewhere = Actor { project: "someone-else".into(), role: "coordinator".into() };
        assert_eq!(request_reclaim_as(&p, "task-1", "builder-1", "", Some(&elsewhere))["reason"], "wrong project");

        let _ = forget_project(&p);
    }

    /// The registry round-trips and a token resolves to exactly one identity;
    /// unregistering a project revokes all of its tokens.
    #[test]
    fn agent_tokens_resolve_to_one_identity_and_revoke_cleanly() {
        let p = format!("_bt_reg_{}", std::process::id());
        // Isolate the shared registry file from other tests by clearing our rows.
        unregister_agents(&p);
        let minted = register_agents(&p, &["coordinator".into(), "builder-1".into()]);
        assert_eq!(minted.len(), 2);
        let (_, coord_tok) = minted.iter().find(|(r, _)| r == "coordinator").unwrap();
        let who = agent_actor(coord_tok).expect("a minted token must resolve");
        assert_eq!(who.project, p);
        assert_eq!(who.role, "coordinator");
        // A token nobody minted resolves to nothing.
        assert!(agent_actor("not-a-real-token").is_none());
        unregister_agents(&p);
        assert!(agent_actor(coord_tok).is_none(), "revoked token must stop resolving");
    }

    #[test]
    fn mine_filter_hides_other_builders_rework() {
        let p = format!("_bt_mine_{}", std::process::id());
        let _ = forget_project(&p);
        create_task(&p, "unowned open work", "", "open", "");
        create_task(&p, "builder-1 rework", "", "open", "");
        assert_eq!(set_task_status(&p, "task-2", "open", Some("builder-1"), "")["ok"], true);

        // builder-2's wait must not fire on builder-1's re-opened task…
        let rows = filtered_tasks(&query_pairs(&format!("project={p}&status=open&mine=builder-2")));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["key"], "task-1");
        // …while builder-1 sees both the unowned task and its own
        let rows = filtered_tasks(&query_pairs(&format!("project={p}&status=open&mine=builder-1")));
        assert_eq!(rows.len(), 2);
        let _ = forget_project(&p);
    }

    #[test]
    fn post_fields_can_come_from_the_query_string() {
        // PowerShell mangles the quotes inside -d '{"a":"b"}', so every JSON
        // field is also accepted as a query param — no quoting to get wrong.
        let p = format!("_bt_qs_{}", std::process::id());
        let _ = forget_project(&p);
        let pairs = |q: &str| query_pairs(q);

        let (code, _, body) = route("/task", true, &pairs(&format!("project={p}&desc=do%20the%20thing&files=src/a.rs&status=open&role=builder")), "", "http://x");
        assert_eq!(code, 200);
        let created: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(created["key"], "task-1");
        assert_eq!(created["status"], "open");

        // claim + status likewise, and a note body via ?value=
        // (builder claims are gated on a "plan" note existing — write it the
        // quote-free way too, which exercises ?value= at the same time)
        let (code, _, _) = route(&format!("/memory/{p}/plan"), true, &pairs("value=task-1%20do%20the%20thing"), "", "http://x");
        assert_eq!(code, 200);
        let (_, _, body) = route("/claim", true, &pairs(&format!("project={p}&task=task-1&owner=builder-1")), "", "http://x");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["ok"], true);
        let (_, _, body) = route("/task-status", true, &pairs(&format!("project={p}&task=task-1&status=done&log=built%20it")), "", "http://x");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["ok"], true);
        let (code, _, _) = route(&format!("/memory/{p}/status-builder-1"), true, &pairs("value=idle"), "", "http://x");
        assert_eq!(code, 200);
        assert_eq!(note(&p, "status-builder-1").as_deref(), Some("idle"));

        // a JSON body still wins over a query param of the same name
        let (_, _, body) = route("/task", true, &pairs(&format!("project={p}&desc=from%20query")), &format!("{{\"project\":\"{p}\",\"desc\":\"from body\"}}"), "http://x");
        let created: Value = serde_json::from_str(&body).unwrap();
        assert!(note(&p, created["key"].as_str().unwrap()).unwrap().contains("from body"));

        // garbage body with nothing to fall back on is still an error
        let (code, _, _) = route("/task", true, &[], "not json", "http://x");
        assert_eq!(code, 400);
        let _ = forget_project(&p);
    }

    #[test]
    fn tasks_status_filter_and_compact() {
        let p = format!("_bt_tf_{}", std::process::id());
        let _ = forget_project(&p);
        create_task(&p, "first line only\nsecond line hidden", "src/a.rs", "", "");
        create_task(&p, "blocked one", "", "blocked", "");
        assert_eq!(set_task_status(&p, "task-1", "done", Some("builder-1"), "")["ok"], true);

        let pairs = |q: &str| query_pairs(q);
        // status filter narrows the JSON list
        let (code, _, body) = route("/tasks", false, &pairs(&format!("project={p}&status=done")), "", "http://x");
        assert_eq!(code, 200);
        let rows: Vec<Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["key"], "task-1");
        // compact is one plain-text line per task, first desc line only
        let (_, ct, body) = route("/tasks", false, &pairs(&format!("project={p}&status=done&compact=1")), "", "http://x");
        assert!(ct.starts_with("text/plain"));
        assert_eq!(body, "task-1 | done | builder | builder-1 | src/a.rs | first line only\n");
        // no match = empty body (cheapest possible "nothing to do")
        let (_, _, body) = route("/tasks", false, &pairs(&format!("project={p}&status=approved&compact=1")), "", "http://x");
        assert_eq!(body, "");
        let _ = forget_project(&p);
    }

    #[test]
    fn task_roles_gate_claims_and_filter_polls() {
        let p = format!("_bt_tr_{}", std::process::id());
        let _ = forget_project(&p);
        // scout tasks default open (pre-plan) and are claimable without a plan note
        let sc = create_task(&p, "scout: map the settings tabs", "", "", "scout");
        assert_eq!(sc["role"], "scout");
        assert_eq!(sc["status"], "open");
        create_task(&p, "build the thing", "src/x.rs", "open", "");

        // builder cannot claim scout work; scout can
        let bounce = claim_task(&p, "task-1", "builder-1");
        assert_eq!(bounce["ok"], false);
        assert_eq!(bounce["reason"], "role mismatch");
        // scout claim works with NO plan note — scouting happens pre-plan
        assert_eq!(claim_task(&p, "task-1", "scout")["ok"], true);
        // scout cannot claim builder (untagged) work; builder can once the plan is up
        assert_eq!(claim_task(&p, "task-2", "scout")["ok"], false);
        assert_eq!(claim_task(&p, "task-2", "builder-2")["reason"], "no plan yet");
        write_note(&p, "plan", "task-2 build the thing").unwrap();
        assert_eq!(claim_task(&p, "task-2", "builder-2")["ok"], true);
        // role survives status transitions
        set_task_status(&p, "task-1", "done", None, "mapped");
        assert_eq!(tasks(&p)[0]["role"], "scout");

        // role= poll filter: builders' slice excludes scout tasks
        let pairs = query_pairs(&format!("project={p}&role=builder&compact=1"));
        let (_, _, body) = route("/tasks", false, &pairs, "", "http://x");
        assert!(body.contains("task-2") && !body.contains("task-1"));
        // owner= filter: a builder checking for review feedback addressed to it
        let pairs = query_pairs(&format!("project={p}&owner=builder-2&compact=1"));
        let (_, _, body) = route("/tasks", false, &pairs, "", "http://x");
        assert!(body.contains("task-2") && !body.contains("task-1"));
        let _ = forget_project(&p);
    }

    #[test]
    fn cross_project_points_elsewhere() {
        let a = format!("_bt_a_{}", std::process::id());
        let b = format!("_bt_b_{}", std::process::id());
        let _ = forget_project(&a);
        let _ = forget_project(&b);
        // A term no other test in the store uses: `cross_project` returns only the
        // newest MAX hits across ALL projects, and the suite shares one real store, so
        // a common word like "pty" lets another test's 200-note bench project crowd b
        // out of the top 8 and this fails for a reason that is not the behaviour here.
        let q = format!("ptyresize{}", std::process::id());
        remember(&a, "pty-resize", &format!("handle {q} in pty.rs"), true);
        remember(&b, "pty-resize", &format!("sibling project also does {q}"), true);
        // bookkeeping notes that match the query must NOT leak across projects
        remember(&b, "project_settings", &format!("{q} manager architecture"), true);
        remember(&b, "session-handoff", &format!("{q} work checkpoint"), true);

        let hits = cross_project(&a, &q);
        // b's matching note is surfaced, as a pointer (elsewhere:true)…
        assert!(hits.iter().any(|r| r["project"] == b && r["elsewhere"] == true));
        // …and the queried project itself is never echoed back as "elsewhere".
        assert!(hits.iter().all(|r| r["project"] != a));
        // bookkeeping keys stay home
        assert!(hits.iter().all(|r| r["key"] != "project_settings" && r["key"] != "session-handoff"));
        // no match → no pointers
        assert!(cross_project(&a, "zzzznomatch").is_empty());

        let _ = forget_project(&a);
        let _ = forget_project(&b);
    }

    // ── authentication ──────────────────────────────────────────────────────

    /// The credential rides in the path so every `{base}`-interpolated example
    /// carries it unchanged. That only works if the split is exact: eat too much
    /// and `/memory/p/some/nested/key` loses a segment, eat too little and the
    /// route never matches.
    #[test]
    fn the_token_prefix_is_split_off_the_path_and_nothing_else_is() {
        assert_eq!(split_token_prefix("/t/abc/recall"), (Some("abc"), "/recall"));
        // keys may contain '/' — everything after the token segment is untouched
        assert_eq!(
            split_token_prefix("/t/abc/memory/proj/some/nested/key"),
            (Some("abc"), "/memory/proj/some/nested/key")
        );
        // a bare prefix addresses the index page
        assert_eq!(split_token_prefix("/t/abc"), (Some("abc"), "/"));
        // no prefix: the path is handed on exactly as it arrived
        assert_eq!(split_token_prefix("/recall"), (None, "/recall"));
        assert_eq!(split_token_prefix("/"), (None, "/"));
        // `/tasks` starts with "/t" but not with "/t/" — the guard must not eat it
        assert_eq!(split_token_prefix("/tasks"), (None, "/tasks"));
    }

    /// `/version` is the ONLY endpoint that answers without the token: a client
    /// has to be able to ask which build it is talking to before it can reason
    /// about whether this guard exists at all. Reads are not free — a bus that
    /// hands every note to any local process is most of the problem.
    #[test]
    fn only_the_build_stamp_is_reachable_without_the_token() {
        assert!(is_public("/version"));
        for path in ["/", "/info", "/info/search", "/info/windows", "/info/nope", "/keys", "/tasks", "/recall", "/wait", "/memory/p/k", "/task", "/claim", "/task-status", "/remember", "/forget", "/forget-project", "/mcp", "/chat", "/resets", "/reset-request", "/agent-event", "/agent-events"] {
            assert!(!is_public(path), "{path} must require the token");
        }
    }

    #[test]
    fn a_wrong_absent_or_truncated_token_is_refused() {
        let real = "0123456789abcdef";
        assert!(token_ok(Some(real), Some(real)));
        assert!(!token_ok(Some(real), Some("0123456789abcdee")), "one bit off");
        assert!(!token_ok(Some(real), Some("0123456789abcde")), "a prefix is not a match");
        assert!(!token_ok(Some(real), Some("")), "empty is not a match");
        assert!(!token_ok(Some(real), None), "no token at all");
        // An expected token that is somehow empty must refuse EVERYTHING rather
        // than accept everything — the fail-open shape is the one that kills you.
        assert!(!token_ok(Some(""), Some("")));
        assert!(!token_ok(Some(""), Some("anything")));
        // `None` = no server was ever started (unit tests call `route` directly).
        assert!(token_ok(None, None));
    }

    /// Over-cap bodies are REFUSED, not silently truncated. `take(MAX)` alone
    /// answers 200 while storing a note with its end cut off, and nothing about
    /// that note looks wrong afterwards — a half-written note is worse than a
    /// refused one. Reading one byte past the cap is how the refusal is detected.
    #[test]
    fn a_body_one_byte_over_the_cap_is_detectable_rather_than_truncated() {
        use std::io::Read;
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'a');
                Ok(buf.len())
            }
        }
        let mut body = String::new();
        let n = Endless.take(MAX_BODY_BYTES + 1).read_to_string(&mut body).unwrap();
        assert_eq!(n as u64, MAX_BODY_BYTES + 1);
        assert!(body.len() as u64 > MAX_BODY_BYTES, "the over-cap byte must reach us");

        // …and a body exactly at the cap is still accepted: the check is `>`.
        let mut ok = String::new();
        let _ = Endless.take(MAX_BODY_BYTES).read_to_string(&mut ok).unwrap();
        assert!(!(ok.len() as u64 > MAX_BODY_BYTES));
    }

    /// The MCP endpoint is on the SAME listener behind the SAME token, so it must
    /// be as unreachable without one as every other route. Over the wire, because
    /// `route()` never sees a token and `token_ok(None, _)` is true — a unit-level
    /// assertion here would pass no matter what the guard did.
    #[test]
    fn the_mcp_endpoint_is_behind_the_same_token_as_the_rest_of_the_bus() {
        use std::io::{Read, Write};

        let token = "tok-for-the-mcp-test";
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral port");
        let port = server.server_addr().to_ip().expect("ip addr").port();
        let base = format!("http://127.0.0.1:{port}/t/{token}");
        std::thread::spawn(move || serve(server, &base, Some(token)));

        let send = |line: &str, body: &str| -> String {
            let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let req = format!(
                "{line} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(req.as_bytes()).expect("write");
            let mut out = String::new();
            let _ = sock.read_to_string(&mut out);
            out
        };

        let handshake = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
        let unauth = send("POST /mcp", handshake);
        assert!(unauth.lines().next().unwrap_or_default().contains(" 401 "), "{unauth}");
        assert!(!unauth.contains("serverInfo"), "a refused handshake must not leak the tool surface");

        let authed = send(&format!("POST /t/{token}/mcp"), handshake);
        assert!(authed.lines().next().unwrap_or_default().contains(" 200 "), "{authed}");
        assert!(authed.contains("pixelmarch-brain"), "{authed}");

        // GET is 405, not a hang: this server offers no server-initiated SSE stream.
        let get = send(&format!("GET /t/{token}/mcp"), "");
        assert!(get.lines().next().unwrap_or_default().contains(" 405 "), "{get}");
    }

    /// END TO END, over a real socket: an unauthenticated POST must be REFUSED
    /// and must write nothing. Compiling the guard proves nothing; this stands a
    /// server up on an ephemeral port and speaks HTTP/1.1 at it by hand.
    #[test]
    fn an_unauthenticated_write_is_refused_over_the_wire_and_stores_nothing() {
        use std::io::{Read, Write};

        let token = "tok-for-the-wire-test";
        let project = format!("auth-wire-test-{}", std::process::id());
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral port");
        let port = server.server_addr().to_ip().expect("ip addr").port();
        let base = format!("http://127.0.0.1:{port}/t/{token}");
        std::thread::spawn(move || serve(server, &base, Some(token)));

        // `path` is what goes on the request line; returns the status line.
        let post = |path: String| -> String {
            let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let body = "written by a caller with no token";
            let req = format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(req.as_bytes()).expect("write");
            let mut out = String::new();
            let _ = sock.read_to_string(&mut out);
            out.lines().next().unwrap_or_default().to_string()
        };

        let note_key = "stolen";
        let unauth = post(format!("/memory/{project}/{note_key}"));
        assert!(unauth.contains(" 401 "), "expected 401, got: {unauth}");
        assert!(note(&project, note_key).is_none(), "a refused write must not reach disk");

        // A wrong token is refused the same way — the guard is the token, not the shape.
        let wrong = post(format!("/t/not-the-token/memory/{project}/{note_key}"));
        assert!(wrong.contains(" 401 "), "expected 401, got: {wrong}");
        assert!(note(&project, note_key).is_none());

        // And with the real token the same request succeeds, so the refusal above
        // is the token doing its job and not the endpoint being broken.
        let ok = post(format!("/t/{token}/memory/{project}/{note_key}"));
        assert!(ok.contains(" 200 "), "expected 200, got: {ok}");
        assert!(note(&project, note_key).is_some(), "an authenticated write must land");

        // /version stays reachable without it, so a client can always identify the build.
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        sock.write_all(b"GET /version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = sock.read_to_string(&mut out);
        assert!(out.lines().next().unwrap_or_default().contains(" 200 "), "/version: {out}");

        let _ = forget_project(&project);
    }

    // ── agent lifecycle events ──────────────────────────────────────────────

    /// COMPACTING is a lifecycle event, not a turn boundary: the CLI's PreCompact
    /// hook fires it before it summarises its own context, which is minutes of work
    /// that looks exactly like a wedged agent (busy pane, frozen screen, no tool
    /// call) and used to cost a healthy pane its runaway restarts.
    #[test]
    fn the_ring_accepts_compacting_and_still_refuses_an_unknown_kind() {
        let p = format!("_ev_compact_{}", std::process::id());
        assert_eq!(record_agent_event(&p, "builder-1", "compacting", "", "")["ok"], true);
        let out = record_agent_event(&p, "builder-1", "compacted", "", "");
        assert_eq!(out["ok"], false, "an unmodelled kind must never reach a watcher: {out}");
        let page = agent_events_since(&p, 0);
        let events = page["events"].as_array().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "compacting");
    }

    /// The ring is BOUNDED and drops the oldest. A swarm posts one of these per
    /// prompt and per turn end for hours; unbounded growth would be a slow leak
    /// in the one process the user never restarts.
    #[test]
    fn the_agent_event_ring_is_bounded_and_drops_the_oldest() {
        let p = format!("_ev_ring_{}", std::process::id());
        let first = record_agent_event(&p, "builder-1", "turn-end", "", "");
        assert_eq!(first["ok"], true, "{first}");
        let first_seq = first["seq"].as_u64().unwrap();
        for _ in 0..AGENT_EVENT_RING + 20 {
            assert_eq!(record_agent_event(&p, "builder-1", "turn-end", "", "")["ok"], true);
        }
        let out = agent_events_since(&p, 0);
        let rows = out["events"].as_array().unwrap();
        assert_eq!(rows.len(), AGENT_EVENT_RING, "ring must cap at {AGENT_EVENT_RING}");
        assert!(
            rows[0]["seq"].as_u64().unwrap() > first_seq,
            "the OLDEST must be the one dropped, not the newest"
        );
    }

    /// The cursor only ever counts up, and a poll never hands back an event the
    /// caller has already seen. A replay reads as a fresh turn boundary, which is
    /// exactly the false-idle bug these events exist to kill.
    #[test]
    fn the_agent_event_cursor_is_monotonic_and_never_replays() {
        let p = format!("_ev_cursor_{}", std::process::id());
        let other = format!("{p}_other");

        let start = agent_events_since(&p, 0)["seq"].as_u64().unwrap();
        record_agent_event(&p, "builder-1", "session-start", "s1", "");
        record_agent_event(&p, "builder-1", "prompt-submitted", "s1", "");

        let first = agent_events_since(&p, start);
        let rows = first["events"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "{first}");
        assert_eq!(rows[0]["event"], "session-start");
        assert_eq!(rows[1]["event"], "prompt-submitted");
        assert_eq!(rows[0]["role"], "builder-1");
        let cursor = first["seq"].as_u64().unwrap();
        assert!(cursor > start, "the cursor must advance");

        // Nothing new: same cursor back, no rows.
        let idle = agent_events_since(&p, cursor);
        assert!(idle["events"].as_array().unwrap().is_empty(), "replayed: {idle}");
        assert_eq!(idle["seq"].as_u64().unwrap(), cursor);

        // Another project's event bumps the global cursor but is never mixed in…
        record_agent_event(&other, "scout", "turn-end", "", "");
        let cross = agent_events_since(&p, cursor);
        assert!(cross["events"].as_array().unwrap().is_empty(), "cross-project leak: {cross}");
        assert!(cross["seq"].as_u64().unwrap() > cursor, "the cursor is global and monotonic");

        // …and polling with that bumped cursor still sees this project's NEXT event,
        // so a shared counter can never make a watcher skip its own events.
        let bumped = cross["seq"].as_u64().unwrap();
        record_agent_event(&p, "builder-1", "turn-end", "s1", "done");
        let after = agent_events_since(&p, bumped);
        let rows = after["events"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{after}");
        assert_eq!(rows[0]["event"], "turn-end");
        assert_eq!(rows[0]["detail"], "done");

        // An unknown project is empty, not an error: a watcher that starts before
        // its agent does is the normal case.
        let unknown = agent_events_since("_ev_no_such_project", 0);
        assert!(unknown["events"].as_array().unwrap().is_empty(), "{unknown}");
        assert!(unknown["seq"].as_u64().is_some());
    }

    /// A typo in a hook command is refused with a 400 rather than stored under a
    /// kind nothing reads — a silently-accepted "turnend" would look like a pane
    /// that never finishes a turn.
    #[test]
    fn an_unknown_agent_event_kind_is_refused() {
        let p = format!("_ev_kind_{}", std::process::id());
        let before = agent_events_since(&p, 0)["seq"].as_u64().unwrap();

        let out = record_agent_event(&p, "builder-1", "turnend", "", "");
        assert_eq!(out["ok"], false, "{out}");
        assert!(out["hint"].as_str().unwrap().contains("turn-end"));
        assert!(agent_events_since(&p, 0)["events"].as_array().unwrap().is_empty(), "a refused event was stored");

        // …and over the route, so the status code is part of the contract.
        let (code, _, body) = route("/agent-event", true, &query_pairs(&format!("project={p}&role=builder-1&event=turnend")), "", "http://x");
        assert_eq!(code, 400, "{body}");
        let (code, _, body) = route("/agent-event", true, &query_pairs(&format!("project={p}&role=builder-1")), "", "http://x");
        assert_eq!(code, 400, "an event kind is required: {body}");
        let (code, _, body) = route("/agent-event", true, &query_pairs(&format!("project={p}&event=turn-end")), "", "http://x");
        assert_eq!(code, 400, "a role is required: {body}");

        // Every valid kind is accepted, so the guard rejects typos and nothing else.
        for kind in AGENT_EVENT_KINDS {
            let (code, _, body) = route("/agent-event", true, &query_pairs(&format!("project={p}&role=builder-1&event={kind}")), "", "http://x");
            assert_eq!(code, 200, "{kind}: {body}");
        }
        let (code, _, body) = route("/agent-events", false, &query_pairs(&format!("project={p}&since={before}")), "", "http://x");
        assert_eq!(code, 200);
        let out: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(out["events"].as_array().unwrap().len(), AGENT_EVENT_KINDS.len(), "{out}");
    }

    /// Events are process state, NOT notes. If one ever reached the store it would
    /// show up in `/keys`, in `/recall` and in the feed the UI subscribes to —
    /// burying real memory under one row per turn.
    #[test]
    fn agent_events_are_invisible_to_keys_and_recall() {
        let p = format!("_ev_hidden_{}", std::process::id());
        let _ = forget_project(&p);
        for kind in AGENT_EVENT_KINDS {
            record_agent_event(&p, "builder-1", kind, "sess-abc", "a very findable detail");
        }
        assert!(keys(&p).is_empty(), "an event became a note: {:?}", keys(&p));
        assert!(recall(&p, None, Some("findable")).is_empty(), "an event is searchable");
        assert!(recall(&p, None, Some("turn-end")).is_empty());
        assert!(recall(&p, Some("turn-end"), None).is_empty());
        assert!(!projects().contains(&p), "an event created a project dir");
        // …while the ring itself still has them.
        assert_eq!(agent_events_since(&p, 0)["events"].as_array().unwrap().len(), AGENT_EVENT_KINDS.len());
    }

    /// END TO END: `/agent-event` is NOT public. Hook commands carry the token
    /// (from the token file, at run time) like every other writer — a route any
    /// local process could post to would let anything on the box forge turn
    /// boundaries and drive the swarm's dispatcher.
    #[test]
    fn agent_events_require_the_token_over_the_wire() {
        use std::io::{Read, Write};

        assert!(!is_public("/agent-event"), "/agent-event must require the token");
        assert!(!is_public("/agent-events"), "/agent-events must require the token");

        let token = "tok-for-the-agent-event-test";
        let project = format!("_ev_wire_{}", std::process::id());
        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral port");
        let port = server.server_addr().to_ip().expect("ip addr").port();
        let base = format!("http://127.0.0.1:{port}/t/{token}");
        std::thread::spawn(move || serve(server, &base, Some(token)));

        let send = |verb: &str, path: String| -> String {
            let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let req = format!("{verb} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            sock.write_all(req.as_bytes()).expect("write");
            let mut out = String::new();
            let _ = sock.read_to_string(&mut out);
            out
        };
        let status = |r: &str| r.lines().next().unwrap_or_default().to_string();

        let q = format!("project={project}&role=builder-1&event=turn-end");
        let before = agent_events_since(&project, 0)["seq"].as_u64().unwrap();

        let unauth = status(&send("POST", format!("/agent-event?{q}")));
        assert!(unauth.contains(" 401 "), "expected 401, got: {unauth}");
        let wrong = status(&send("POST", format!("/t/not-the-token/agent-event?{q}")));
        assert!(wrong.contains(" 401 "), "expected 401, got: {wrong}");
        assert!(
            agent_events_since(&project, before)["events"].as_array().unwrap().is_empty(),
            "a refused event still reached the ring"
        );

        // Reading them is not free either — the events name who is doing what.
        let read_unauth = status(&send("GET", format!("/agent-events?project={project}")));
        assert!(read_unauth.contains(" 401 "), "expected 401, got: {read_unauth}");

        // With the token the same request works, so the refusals above are the
        // guard doing its job and not a broken endpoint.
        let ok = status(&send("POST", format!("/t/{token}/agent-event?{q}")));
        assert!(ok.contains(" 200 "), "expected 200, got: {ok}");
        let read = send("GET", format!("/t/{token}/agent-events?project={project}&since={before}"));
        assert!(status(&read).contains(" 200 "), "{read}");
        let body = read.split("\r\n\r\n").nth(1).unwrap_or_default();
        let out: Value = serde_json::from_str(body).expect("json body");
        assert_eq!(out["events"].as_array().unwrap().len(), 1, "{out}");
        assert_eq!(out["events"][0]["event"], "turn-end");
    }

    // ── the in-RAM index ────────────────────────────────────────────────────

    /// What the index says and what is on disk must never diverge. An index that
    /// lies about ONE note is worse than no index: nothing about the wrong answer
    /// looks wrong. So every mutation path is exercised and the answer is compared
    /// against the file, read straight off disk, byte for byte.
    #[test]
    fn the_index_and_the_disk_agree_after_write_delete_and_task_mutation() {
        let p = format!("_bt_idx_{}", std::process::id());
        let _ = forget_project(&p);

        let on_disk = |k: &str| std::fs::read_to_string(note_path(&p, k)).ok();

        // write → both agree, and the note is findable by its precomputed words
        write_note(&p, "auth-flow", "login uses JWT in auth.rs:42").unwrap();
        assert_eq!(note(&p, "auth-flow").as_deref(), Some("login uses JWT in auth.rs:42"));
        assert_eq!(on_disk("auth-flow").as_deref(), note(&p, "auth-flow").as_deref());
        assert_eq!(keys(&p), vec!["auth-flow".to_string()]);
        assert!(projects().contains(&p));
        assert_eq!(recall(&p, None, Some("jwt")).len(), 1);

        // overwrite → the OLD words must be gone, not merely joined by the new ones
        write_note(&p, "auth-flow", "login now uses opaque session cookies").unwrap();
        assert_eq!(on_disk("auth-flow").as_deref(), note(&p, "auth-flow").as_deref());
        assert!(recall(&p, None, Some("jwt")).is_empty(), "stale token set survived an overwrite");
        assert_eq!(recall(&p, None, Some("cookies")).len(), 1);

        // delete → gone from BOTH (brain_delete used to unlink the file only)
        assert!(delete_note(&p, "auth-flow").is_ok());
        assert!(on_disk("auth-flow").is_none());
        assert!(note(&p, "auth-flow").is_none());
        assert!(keys(&p).is_empty());
        assert!(recall(&p, None, Some("cookies")).is_empty());

        // task mutations: the cached parse_task must match a fresh parse of the file
        write_note(&p, "plan", "task-1 do the thing").unwrap();
        assert_eq!(create_task(&p, "do the thing", "src/a.rs", "open", "")["key"], "task-1");
        let fresh = |k: &str| {
            let v = on_disk(k).expect("task file");
            parse_task(k, &v, tasks(&p).iter().find(|t| t["key"] == k).unwrap()["updated"].as_u64().unwrap())
        };
        assert_eq!(tasks(&p)[0], fresh("task-1"));
        assert_eq!(claim_task(&p, "task-1", "builder-1")["ok"], true);
        assert_eq!(tasks(&p)[0], fresh("task-1"));
        assert_eq!(tasks(&p)[0]["owner"], "builder-1");
        assert_eq!(set_task_status(&p, "task-1", "done", None, "shipped")["ok"], true);
        assert_eq!(tasks(&p)[0], fresh("task-1"));
        assert_eq!(tasks(&p)[0]["status"], "done");

        // deleting the whole project empties both
        forget_project(&p);
        assert!(!projects().contains(&p));
        assert!(tasks(&p).is_empty());
        assert!(!root().join(safe_seg(&p)).exists());
    }

    /// Notes are plain `.md` files someone may edit in a text editor. Reads no longer
    /// hit disk, so that edit is picked up by the rescan rather than instantly — this
    /// pins the mechanism (`start_index_watch` runs it on its own thread in every process).
    #[test]
    fn an_out_of_band_edit_is_picked_up_by_the_rescan() {
        let p = format!("_bt_oob_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "pty-resize", "handled in pty.rs").unwrap();

        // edit behind the index's back — different length, so mtime granularity
        // can't hide it either
        std::fs::write(note_path(&p, "pty-resize"), "moved to hostclient.rs:71 entirely").unwrap();
        // (what the read returns RIGHT HERE is deliberately not asserted: a watch thread
        // — the real deployment, and `the_watch_thread_makes_another_processs_write_visible`
        // starts one in this suite — may already have folded the edit in. Nor is the
        // changed-count: another test's rescan may be the pass that does it. What is
        // contractual is that the edit IS folded in, with its token set rebuilt.)
        rescan_once();
        assert_eq!(note(&p, "pty-resize").as_deref(), Some("moved to hostclient.rs:71 entirely"));
        // …and the token set was rebuilt with it, not just the body
        assert_eq!(recall(&p, None, Some("hostclient")).len(), 1);
        assert!(recall(&p, None, Some("handled")).is_empty(), "stale token set survived the rescan");

        // a note deleted behind our back disappears too
        std::fs::remove_file(note_path(&p, "pty-resize")).unwrap();
        rescan_once();
        assert!(note(&p, "pty-resize").is_none());
        assert!(keys(&p).is_empty());

        // a project dropped in by hand shows up (note-less dirs must stay visible)
        let hand = format!("{p}_by_hand");
        std::fs::create_dir_all(root().join(safe_seg(&hand))).unwrap();
        rescan_once();
        assert!(projects().contains(&hand));

        let _ = forget_project(&p);
        let _ = forget_project(&hand);
    }

    /// A rescan running BESIDE a write must never publish an empty (or half-written)
    /// body, because every read is served from the index and callers treat an empty
    /// note as "does not exist". This is the bug that made
    /// `concurrent_patch_and_task_status_do_not_lose_each_other` panic ~1 run in 6:
    /// `write_note` truncated in place, the rescan read the file inside that window
    /// and got 0 bytes, and its stat-read-stat guard passed anyway — the body it read
    /// was empty but the FINAL length matched the snapshot length (task bodies cycle
    /// through a handful of lengths) and mtime has 1-second granularity. The empty
    /// entry went into the index and `tasks()`, which drops empty notes, returned
    /// nothing at all: the task was ABSENT, not stale. The bus polls `/tasks`, so any
    /// claim guard or orphan sweep reading "not in the list" as "does not exist" acts
    /// on a false negative. Fixed at the source — `write_note` now renames a complete
    /// file into place, so no reader can ever observe a partial one.
    #[test]
    fn a_rescan_beside_a_write_never_publishes_an_empty_body() {
        let p = format!("_bt_tear_{}", std::process::id());
        let _ = forget_project(&p);
        // Two bodies of the SAME length, and big enough that filling the file takes
        // long enough for a scan to land inside it. Equal lengths matter: the length
        // half of the rescan's guard then never fires, which is the case the old code
        // got wrong. (The real store's task notes are small, so the real bug needed the
        // whole suite's rescans to hit the window ~1 run in 6; this just makes the same
        // window wide enough to hit reliably.)
        let filler = "lorem ipsum dolor sit amet ".repeat(3000);
        let head = "status: claimed\nrole: -\nowner: builder-9\nfiles: src/a.rs\n\n";
        let (a, b) = (format!("{head}MARKER {filler}"), format!("{head}MARKED {filler}"));
        assert_eq!(a.len(), b.len());
        write_note(&p, "task-1", &a).unwrap();

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (wp, ws) = (p.clone(), stop.clone());
        let (wa, wb) = (a.clone(), b.clone());
        let writer = std::thread::spawn(move || {
            for i in 0..150 {
                write_note(&wp, "task-1", if i % 2 == 0 { &wb } else { &wa }).unwrap();
            }
            ws.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        // What the rescan does, minus the guards: read the file off disk with no lock
        // held. THIS is the read that must never see a partial state — the guards only
        // narrow the window, and the whole point of the rescan reading unlocked is that
        // it cannot be made to wait for a writer. Every read must be one WHOLE body.
        let path = note_path(&p, "task-1");
        let mut reads = 0u32;
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            if let Ok(got) = std::fs::read_to_string(&path) {
                reads += 1;
                assert!(got == a || got == b, "read a partial file: {} bytes of an expected {}", got.len(), a.len());
            }
            // The same read through the index, which is what the bus actually polls.
            assert!(note(&p, "task-1").is_some(), "note vanished mid-write");
            assert!(!tasks(&p).is_empty(), "task absent from tasks() mid-write");
            rescan_once();
        }
        writer.join().unwrap();
        assert!(reads > 0, "never got a read in edgewise");
        assert!(note(&p, "task-1").is_some());
        let _ = forget_project(&p);
    }

    /// `write_atomic`'s temps are invisible to every walk, which is what keeps a crash
    /// between the write and the rename from producing a phantom note — and also means
    /// nothing but this sweep would ever delete one, so each interrupted write would
    /// leak a full copy of a note into the store forever. A temp still being filled by
    /// ANOTHER process must survive: this walk holds no lock on it.
    #[test]
    fn load_from_disk_sweeps_orphaned_write_temps_but_not_live_ones() {
        let p = format!("_bt_tmp_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "seed", "seed").unwrap(); // makes the project dir
        let dir = note_path(&p, "seed").parent().unwrap().to_path_buf();
        let (orphan, live) = (dir.join(".task-1.md.tmp999-0"), dir.join(".task-2.md.tmp999-1"));
        std::fs::write(&orphan, "half a not").unwrap();
        std::fs::write(&live, "half a not").unwrap();
        let f = std::fs::File::options().write(true).open(&orphan).unwrap();
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        f.set_times(std::fs::FileTimes::new().set_modified(hour_ago)).unwrap();

        let notes = load_from_disk();
        assert!(!orphan.exists(), "a crashed write's temp is never cleaned up by anything else");
        assert!(live.exists(), "swept a temp another process could still be writing");
        // And neither was ever mistaken for a note.
        let keys: Vec<String> = notes.get(&p).map(|n| n.keys().cloned().collect()).unwrap_or_default();
        assert_eq!(keys, vec!["seed".to_string()]);

        let _ = std::fs::remove_file(&live);
        let _ = forget_project(&p);
    }

    /// The rescan runs every RESCAN_MIN forever, at idle, over the whole store. So the
    /// nothing-changed pass must STAT ONLY — no opens, no bodies, no tokenizing — or it
    /// puts the exact per-request cost the index removed back on a timer.
    #[test]
    fn an_idle_rescan_stats_but_does_not_re_read() {
        use std::time::Instant;
        let p = format!("_bt_idle_{}", std::process::id());
        let _ = forget_project(&p);
        for i in 0..200 {
            write_note(&p, &format!("note-{i}"), &format!("chat pane {i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor")).unwrap();
        }
        // Warm-up. Writers keep the index current, so OUR notes cost this pass nothing;
        // it is not asserted to be exactly 0 because the rest of the suite runs in
        // parallel and writes its own notes into the same store.
        rescan_once();

        const N: u32 = 10;
        let t0 = Instant::now();
        for _ in 0..N {
            rescan_once();
        }
        let idle = t0.elapsed() / N;

        let t1 = Instant::now();
        for _ in 0..N {
            let _ = load_from_disk();
        }
        let full = t1.elapsed() / N;

        println!("rescan over {} notes: full re-read {full:?} -> stat-only {idle:?} ({:.1}x)",
                 keys(&p).len(), full.as_secs_f64() / idle.as_secs_f64().max(1e-9));
        assert!(idle * 2 < full, "idle rescan {idle:?} is still re-reading bodies (full walk {full:?})");

        let _ = forget_project(&p);
    }

    /// The index is PER PROCESS: the GUI reads notes through the `brain_*` IPC commands
    /// against its own copy, while every agent writes through the host process over HTTP.
    /// So the GUI's freshness depends entirely on the watch thread running THERE too —
    /// without it SwarmChat and friends freeze at whatever disk held when the GUI started.
    /// This stands in for that process: write a note the way the other process would (on
    /// disk, behind the index's back) and let the watch — not an explicit `rescan_once` —
    /// be what makes it visible.
    #[test]
    fn the_watch_thread_makes_another_processs_write_visible() {
        // Whoever starts it first wins; all that is contractual is that a SECOND call is a
        // no-op. (Asserting the first call returns true would break the day any other test
        // calls start() or the watch.)
        start_index_watch();
        assert!(!start_index_watch(), "a second call must not spawn a second watch thread");

        let p = format!("_bt_watch_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "seed", "seed").unwrap(); // makes the project dir
        std::fs::write(note_path(&p, "from-host"), "written by the host process").unwrap();

        // Bounded by the rescan gap; generous here because the suite runs in parallel.
        let deadline = Instant::now() + Duration::from_secs(5);
        while note(&p, "from-host").is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            note(&p, "from-host").as_deref(),
            Some("written by the host process"),
            "the watch thread never folded in a write made outside this process's index"
        );

        let _ = forget_project(&p);
    }

    /// A project created in-process AFTER the rescan snapshotted the root must survive
    /// the pass — dropping it would make projects()/keys()/note() lie for a whole rescan gap
    /// and the GUI would watch a freshly created project vanish.
    #[test]
    fn a_project_created_during_a_rescan_is_not_wiped_from_the_index() {
        // a project the index knows about but disk really does not: that one MUST go
        let ghost = format!("_bt_ghost_{}", std::process::id());
        write_index().entry(safe_seg(&ghost)).or_default();
        rescan_once();
        assert!(!projects().contains(&ghost), "a project absent from disk stays absent");

        // …and one created while the rescan is in flight must NOT
        for i in 0..20 {
            let p = format!("_bt_race_{}_{i}", std::process::id());
            let h = std::thread::spawn(rescan_once);
            create_project(&p).unwrap();
            write_note(&p, "seed", "created mid-rescan").unwrap();
            let _ = h.join();
            assert!(projects().contains(&p), "{p} was wiped by a concurrent rescan");
            assert_eq!(note(&p, "seed").as_deref(), Some("created mid-rescan"));
            let _ = forget_project(&p);
        }
    }

    /// Prefix matching over the sorted word list must answer exactly what the old
    /// linear scan answered — the binary search is only worth anything if it is
    /// indistinguishable from the scan it replaced.
    #[test]
    fn prefix_search_over_sorted_words_matches_a_linear_scan() {
        for text in [
            "auth-flow login uses JWT tokens",
            "",
            "zebra apple Apple APPLE mango",
            "task-1 status: open role: builder",
        ] {
            let words = sorted_words(text);
            let flat = words_lower(text);
            for tok in ["a", "app", "apple", "apples", "z", "zzz", "jwt", "task", "", "1"] {
                let want = flat.iter().any(|w| w.starts_with(tok));
                assert_eq!(words_have_prefix(&words, tok), want, "{text:?} / {tok:?}");
            }
        }
    }

    /// THE MEASUREMENT. Same store, same query, same match semantics: the index path
    /// versus the disk walk it replaced (reproduced here verbatim, so the comparison
    /// is against real code and not a straw man). Run with `--nocapture` to see the
    /// numbers. Asserted at a deliberately loose 4x so the test pins the WIN, not the
    /// machine — the observed factor is far higher.
    #[test]
    fn index_backed_search_beats_the_disk_walk_it_replaced() {
        use std::time::Instant;
        let p = format!("_bt_bench_{}", std::process::id());
        let _ = forget_project(&p);
        // A store worth measuring: 200 notes of realistic size.
        let filler = "pty resize hostclient framed socket write lock main thread ".repeat(60);
        for i in 0..200 {
            write_note(&p, &format!("note-{i}"), &format!("note {i} chat log — {filler}")).unwrap();
        }

        // the OLD read path, byte for byte
        let disk_walk = |project: &str, q: &str| -> usize {
            let toks = tokens(q);
            let mut hits = 0usize;
            let dirs: Vec<PathBuf> = std::fs::read_dir(root())
                .into_iter().flatten().flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.path()).collect();
            let _ = project;
            for d in dirs {
                let mut ks: Vec<String> = std::fs::read_dir(&d)
                    .into_iter().flatten().flatten()
                    .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md").map(String::from))
                    .collect();
                ks.sort();
                for k in ks {
                    let path = d.join(format!("{k}.md"));
                    if let Ok(v) = std::fs::read_to_string(&path) {
                        if !v.trim().is_empty() && note_hit(&toks, &format!("{k} {v}")) {
                            let _ = updated_secs(&path);
                            hits += 1;
                        }
                    }
                }
            }
            hits
        };

        const N: u32 = 20;
        let q = "chat";
        // warm both paths so neither pays a one-off cost inside the timed loop
        let _ = disk_walk(&p, q);
        let _ = tauri::async_runtime::block_on(brain_search(p.clone(), q.into()));

        let t0 = Instant::now();
        let mut disk_hits = 0;
        for _ in 0..N { disk_hits = disk_walk(&p, q); }
        let disk = t0.elapsed() / N;

        let t1 = Instant::now();
        let mut idx_hits = 0;
        for _ in 0..N {
            idx_hits = tauri::async_runtime::block_on(brain_search(p.clone(), q.into())).len();
        }
        let idx = t1.elapsed() / N;

        println!("brain_search over {} notes: disk walk {:?} -> index {:?} ({:.1}x)",
                 keys(&p).len(), disk, idx, disk.as_secs_f64() / idx.as_secs_f64().max(1e-9));
        assert!(idx_hits >= 200, "the index path must still FIND them: {idx_hits}");
        assert!(disk_hits >= idx_hits, "same semantics, so the disk walk sees at least as many");
        // Deliberately loose: 22x is what a quiet box measures, but this is a timing
        // assert in a unit suite and a loaded CI box is allowed to be slow.
        assert!(idx * 2 < disk, "index {idx:?} is not clearly faster than the disk walk {disk:?}");

        let _ = forget_project(&p);
    }

    // ── partial edits ───────────────────────────────────────────────────────

    /// Route a POST the way an agent's curl would, and give back the parsed JSON.
    fn post(path: &str, query: &str) -> Value {
        let (_, _, body) = route(path, true, &query_pairs(query), "", "http://x");
        serde_json::from_str(&body).unwrap()
    }

    /// Chat and reset requests over plain HTTP — the fallback every non-MCP CLI
    /// still takes. It must land on the SAME notes the MCP tools write, or a swarm
    /// with one hook-less pane in it quietly splits into two conversations.
    #[test]
    fn chat_and_reset_requests_are_the_same_notes_from_http_as_from_mcp() {
        let p = format!("_bt_chat_{}", std::process::id());
        let _ = forget_project(&p);

        let sent = post("/chat", &format!("project={p}&from=builder-1&to=coordinator&text=hello there"));
        assert_eq!(sent["ok"], true, "{sent}");
        assert_eq!(sent["key"], "chat-builder-1-1");
        // Stored in the historical shape, so a pane reading raw notes still works.
        assert_eq!(note(&p, "chat-builder-1-1").unwrap(), "to: coordinator\nhello there\n");
        // Numbering is per sender and increments.
        assert_eq!(post("/chat", &format!("project={p}&from=builder-1&to=all&text=second"))["key"], "chat-builder-1-2");
        assert_eq!(post("/chat", &format!("project={p}&from=coordinator&to=all&text=standup"))["key"], "chat-coordinator-1");

        // A note written the old way — by hand, as `curl` briefs have always said —
        // is read back by the same parser. Nothing needs migrating.
        write_note(&p, "chat-human-1", "to: coordinator\nship it").unwrap();

        let (code, _, body) = route("/chat", false, &query_pairs(&format!("project={p}&role=coordinator")), "", "http://x");
        assert_eq!(code, 200);
        let inbox: Value = serde_json::from_str(&body).unwrap();
        let rows = inbox.as_array().unwrap();
        assert_eq!(rows.len(), 3, "two addressed + one broadcast, minus its own: {inbox}");
        assert!(rows.iter().any(|m| m["from"] == "human" && m["text"] == "ship it"));
        assert!(rows.iter().all(|m| m["from"] != "coordinator"), "own messages never come back: {inbox}");

        // A body with no `to:` header reaches everyone rather than nobody.
        write_note(&p, "chat-scout-1", "no header at all").unwrap();
        let (_, _, body) = route("/chat", false, &query_pairs(&format!("project={p}&role=builder-1")), "", "http://x");
        let rows: Value = serde_json::from_str(&body).unwrap();
        // ...but the row says the header was missing, so a caller that would rather
        // not broadcast one can still tell it from an explicit `to: all`.
        let headerless = rows.as_array().unwrap().iter().find(|m| m["from"] == "scout").unwrap_or_else(|| panic!("{rows}"));
        assert_eq!(headerless["to"], "all");
        assert_eq!(headerless["addressed"], false, "no `to:` header on disk");
        let explicit = rows.as_array().unwrap().iter().find(|m| m["key"] == "chat-coordinator-1").unwrap();
        assert_eq!(explicit["addressed"], true, "`to: all` was written by hand");

        // A hand-written multi-recipient header — the shape the swarm actually
        // sends — reaches EVERY role it names, and only those.
        write_note(&p, "chat-coordinator-11", "to: builder-2|reviewer-1\nboth of you").unwrap();
        for role in ["builder-2", "reviewer-1"] {
            let (_, _, body) = route("/chat", false, &query_pairs(&format!("project={p}&role={role}")), "", "http://x");
            let rows: Value = serde_json::from_str(&body).unwrap();
            let hit = rows.as_array().unwrap().iter().find(|m| m["key"] == "chat-coordinator-11").unwrap_or_else(|| panic!("{role} must receive it: {rows}")).clone();
            assert_eq!(hit["to"], "builder-2|reviewer-1", "raw header preserved");
            assert_eq!(hit["targets"], json!(["builder-2", "reviewer-1"]), "parsed list rides along");
        }
        let (_, _, body) = route("/chat", false, &query_pairs(&format!("project={p}&role=builder-1")), "", "http://x");
        let rows: Value = serde_json::from_str(&body).unwrap();
        assert!(
            !rows.as_array().unwrap().iter().any(|m| m["key"] == "chat-coordinator-11"),
            "a role the header does not name stays out of it: {rows}"
        );

        // reset-<role>: the same note swarmReset has always scanned for.
        assert_eq!(post("/reset-request", &format!("project={p}&role=builder-2"))["ok"], true);
        assert_eq!(note(&p, "reset-builder-2").unwrap(), "ready");
        let (_, _, body) = route("/resets", false, &query_pairs(&format!("project={p}")), "", "http://x");
        let resets: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(resets.as_array().unwrap().len(), 1, "{resets}");
        assert_eq!(resets[0]["role"], "builder-2");
        assert_eq!(resets[0]["state"], "ready");

        // Missing fields are refused, not stored half-formed.
        let (code, _, _) = route("/chat", true, &query_pairs(&format!("project={p}&from=x&to=y")), "", "http://x");
        assert_eq!(code, 400, "a message with no text is a caller bug");
        let (code, _, _) = route("/reset-request", true, &query_pairs(&format!("project={p}")), "", "http://x");
        assert_eq!(code, 400);

        let _ = forget_project(&p);
    }

    /// Ten messages from one sender inside one mtime second must still read back
    /// 1..10. The tie-break is the sequence number; on the key, `chat-x-10` sorts
    /// before `chat-x-2`.
    #[test]
    fn chat_rows_order_by_sequence_not_by_key_string() {
        let p = format!("_bt_chatorder_{}", std::process::id());
        let _ = forget_project(&p);
        for i in 1..=10 {
            write_note(&p, &format!("chat-x-{i}"), &format!("to: all\nmsg {i}")).unwrap();
        }
        let ns: Vec<u64> = chat_rows(&p).iter().map(|m| m["n"].as_u64().unwrap()).collect();
        assert_eq!(ns, (1..=10).collect::<Vec<u64>>(), "sequence order, not lexical key order");
        let _ = forget_project(&p);
    }

    #[test]
    fn patch_replaces_appends_and_edits_lines_without_resending_the_body() {
        let p = format!("_bt_patch_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "release", "PixelMarch 1.4.2 ships\nsee build.rs:12\ndrop me").unwrap();

        // literal replace, and the reply names the changed line
        let out = patch_note(&p, "release", "", "1.4.2", "0.1.x", "", "", true, false, "", false);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["op"], "replace"); // inferred from find=
        assert_eq!(out["hits"], 1);
        assert_eq!(out["lines"][0]["line"], 1);
        assert_eq!(out["lines"][0]["after"], "PixelMarch 0.1.x ships");
        assert!(note(&p, "release").unwrap().starts_with("PixelMarch 0.1.x ships"));

        // append / prepend
        assert_eq!(patch_note(&p, "release", "append", "", "", "tail line", "", true, false, "", false)["ok"], true);
        assert_eq!(patch_note(&p, "release", "prepend", "", "", "head line", "", true, false, "", false)["ok"], true);
        let v = note(&p, "release").unwrap();
        assert!(v.starts_with("head line\n"), "{v}");
        assert!(v.ends_with("tail line"), "{v}");

        // line-addressed delete (1-based) — "drop me" is line 4 now
        let lines: Vec<String> = v.lines().map(String::from).collect();
        let n = lines.iter().position(|l| l == "drop me").unwrap() + 1;
        let out = patch_note(&p, "release", "delete-lines", "", "", "", &n.to_string(), true, false, "", false);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["lines"][0]["before"], "drop me");
        assert!(!note(&p, "release").unwrap().contains("drop me"));

        // set-line rewrites exactly one line
        assert_eq!(patch_note(&p, "release", "set-line", "", "", "REWRITTEN", "1", true, false, "", false)["ok"], true);
        assert_eq!(note(&p, "release").unwrap().lines().next().unwrap(), "REWRITTEN");

        // an out-of-range line is an error, not a silent no-op
        let bad = patch_note(&p, "release", "delete-lines", "", "", "", "999", true, false, "", false);
        assert_eq!(bad["ok"], false);
        assert!(bad["error"].as_str().unwrap().contains("past the end"));

        let _ = forget_project(&p);
    }

    #[test]
    fn patch_dry_run_changes_nothing_and_expect_guards_a_stale_read() {
        let p = format!("_bt_dry_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "n", "alpha beta\nalpha gamma").unwrap();
        let before = note(&p, "n").unwrap();

        let out = patch_note(&p, "n", "replace", "alpha", "ALPHA", "", "", true, false, "", true);
        assert_eq!(out["ok"], true);
        assert_eq!(out["dry"], true);
        assert_eq!(out["hits"], 2);
        assert_eq!(out["changed"], 2);
        assert_eq!(note(&p, "n").unwrap(), before, "a dry run must not write");

        // expect= refuses when the note no longer says what the caller read
        let stale = patch_note(&p, "n", "replace", "alpha", "X", "", "", true, false, "delta", false);
        assert_eq!(stale["ok"], false);
        assert_eq!(stale["reason"], "expect not found");
        assert_eq!(note(&p, "n").unwrap(), before);

        // all=0 touches only the first occurrence
        let out = patch_note(&p, "n", "replace", "alpha", "ALPHA", "", "", false, false, "", false);
        assert_eq!(out["ok"], true);
        assert_eq!(note(&p, "n").unwrap(), "ALPHA beta\nalpha gamma");

        // a patch whose result equals the body is a no-op, reported honestly
        let same = patch_note(&p, "n", "replace", "nothing-here", "x", "", "", true, false, "", false);
        assert_eq!(same["changed"], 0);

        let _ = forget_project(&p);
    }

    #[test]
    fn patch_reports_the_sanitized_key_and_refuses_a_missing_note() {
        let p = format!("_bt_skey_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "BigBrain/Info", "version 1.2.3").unwrap();
        // the caller may keep using the unsanitized key; the reply hands back the real one
        let out = patch_note(&p, "BigBrain/Info", "replace", "1.2.3", "0.1.x", "", "", true, false, "", false);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["key"], "BigBrain-Info");
        assert_eq!(note(&p, "BigBrain-Info").unwrap(), "version 0.1.x");

        let missing = patch_note(&p, "nope", "append", "", "", "x", "", true, false, "", false);
        assert_eq!(missing["ok"], false);
        assert!(missing["error"].as_str().unwrap().contains("no note"));
        let _ = forget_project(&p);
    }

    #[test]
    fn bulk_replace_dry_runs_by_default_and_hits_only_the_intended_notes() {
        let p = format!("_bt_bulk_{}", std::process::id());
        let other = format!("_bt_bulk_other_{}", std::process::id());
        let _ = forget_project(&p);
        let _ = forget_project(&other);
        write_note(&p, "a", "pinned to 1.4.2 in Cargo.toml:3").unwrap();
        write_note(&p, "b", "also 1.4.2, twice: 1.4.2").unwrap();
        write_note(&p, "c", "nothing to see").unwrap();
        write_note(&other, "d", "1.4.2 lives here too").unwrap();

        // DRY RUN by default: reports, writes nothing
        let dry = bulk_replace(Some(&p), "1.4.2", "0.1.x", false, &[], false, false, 200);
        assert_eq!(dry["ok"], true, "{dry}");
        assert_eq!(dry["dry"], true);
        assert_eq!(dry["written"], 0);
        assert_eq!(dry["notes_matched"], 2);
        assert_eq!(dry["hits"], 3);
        assert!(note(&p, "a").unwrap().contains("1.4.2"), "dry run must not write");
        // …and it names the exact lines
        assert_eq!(dry["notes"][0]["lines"][0]["after"], "pinned to 0.1.x in Cargo.toml:3");

        // scope is one project: the other project is untouched by the apply
        let hot = bulk_replace(Some(&p), "1.4.2", "0.1.x", false, &[], false, true, 200);
        assert_eq!(hot["written"], 2, "{hot}");
        assert_eq!(note(&p, "a").unwrap(), "pinned to 0.1.x in Cargo.toml:3");
        assert_eq!(note(&p, "b").unwrap(), "also 0.1.x, twice: 0.1.x");
        assert_eq!(note(&p, "c").unwrap(), "nothing to see");
        assert_eq!(note(&other, "d").unwrap(), "1.4.2 lives here too");

        // keys= narrows further
        write_note(&p, "e", "x marks").unwrap();
        write_note(&p, "f", "x marks").unwrap();
        let only = bulk_replace(Some(&p), "x marks", "y marks", false, &["e".into()], false, true, 200);
        assert_eq!(only["written"], 1);
        assert_eq!(note(&p, "f").unwrap(), "x marks");

        // the apply limit refuses rather than half-writing a too-broad sweep
        let capped = bulk_replace(Some(&p), "marks", "MARKS", false, &[], false, true, 1);
        assert_eq!(capped["ok"], false, "{capped}");
        assert_eq!(capped["reason"], "too many notes for one apply");
        assert!(note(&p, "e").unwrap().contains("marks"));

        let _ = forget_project(&p);
        let _ = forget_project(&other);
    }

    #[test]
    fn bulk_replace_matches_bodies_only_and_never_renames_a_key() {
        let p = format!("_bt_keyname_{}", std::process::id());
        let _ = forget_project(&p);
        // key contains the search string, body does NOT: must not be touched at all
        write_note(&p, "widget-notes", "nothing relevant").unwrap();
        // key AND body contain it: body changes, key stays
        write_note(&p, "widget-spec", "the widget is blue").unwrap();

        let out = bulk_replace(Some(&p), "widget", "gadget", false, &[], false, true, 200);
        assert_eq!(out["written"], 1, "{out}");
        assert_eq!(out["notes"][0]["key"], "widget-spec");
        assert_eq!(note(&p, "widget-spec").unwrap(), "the gadget is blue");
        assert_eq!(note(&p, "widget-notes").unwrap(), "nothing relevant");
        // both keys still exist under their original names
        assert_eq!(keys(&p), vec!["widget-notes".to_string(), "widget-spec".to_string()]);
        let _ = forget_project(&p);
    }

    #[test]
    fn bulk_replace_skips_task_notes_unless_asked_and_regex_sweeps_versions() {
        let p = format!("_bt_btask_{}", std::process::id());
        let _ = forget_project(&p);
        create_task(&p, "ship 1.4.2", "src/a.rs", "open", "");
        write_note(&p, "plain", "docs say 1.4.2 and 2.0.1").unwrap();

        // task-<n> notes are invisible to a bulk replace by default
        let out = bulk_replace(Some(&p), "1.4.2", "0.1.x", false, &[], false, true, 200);
        assert_eq!(out["notes_matched"], 1, "{out}");
        assert_eq!(out["notes"][0]["key"], "plain");
        assert!(note(&p, "task-1").unwrap().contains("1.4.2"));
        // the task's machine-parsed header survived intact
        assert_eq!(tasks(&p)[0]["status"], "open");

        // include_tasks=1 opts in
        let out = bulk_replace(Some(&p), "1.4.2", "0.1.x", false, &[], true, true, 200);
        assert_eq!(out["written"], 1);
        assert!(note(&p, "task-1").unwrap().contains("0.1.x"));
        assert_eq!(tasks(&p)[0]["status"], "open");

        // regex mode: the sweep the mission actually asked for
        let out = bulk_replace(Some(&p), r"\d+\.\d+\.\d+", "0.1.x", true, &["plain".into()], false, true, 200);
        assert_eq!(out["written"], 1, "{out}");
        assert_eq!(note(&p, "plain").unwrap(), "docs say 0.1.x and 0.1.x");

        // a regex that can match nothing is refused, not applied
        let bad = bulk_replace(Some(&p), "x*", "!", true, &[], false, true, 200);
        assert_eq!(bad["ok"], false);
        assert!(bad["error"].as_str().unwrap().contains("empty string"));
        let _ = forget_project(&p);
    }

    #[test]
    fn patch_and_replace_are_reachable_over_http_with_query_string_fields() {
        let p = format!("_bt_http_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "n", "value 1.4.2 here").unwrap();

        // every field as a query param — the PowerShell-safe form
        let dry = post("/patch", &format!("project={p}&key=n&find=1.4.2&replace=0.1.x&dry=1"));
        assert_eq!(dry["ok"], true, "{dry}");
        assert_eq!(dry["dry"], true);
        assert_eq!(note(&p, "n").unwrap(), "value 1.4.2 here");

        let hot = post("/patch", &format!("project={p}&key=n&find=1.4.2&replace=0.1.x"));
        assert_eq!(hot["ok"], true, "{hot}");
        assert_eq!(note(&p, "n").unwrap(), "value 0.1.x here");

        // /replace with no apply= is a dry run over HTTP too
        let dry = post("/replace", &format!("project={p}&find=0.1.x&replace=9.9.9"));
        assert_eq!(dry["dry"], true);
        assert_eq!(dry["written"], 0);
        assert_eq!(note(&p, "n").unwrap(), "value 0.1.x here");
        let hot = post("/replace", &format!("project={p}&find=0.1.x&replace=9.9.9&apply=1"));
        assert_eq!(hot["written"], 1, "{hot}");
        assert_eq!(note(&p, "n").unwrap(), "value 9.9.9 here");

        // missing required fields answer 400 with a hint, not a panic
        let (code, _, body) = route("/patch", true, &query_pairs(&format!("project={p}")), "", "http://x");
        assert_eq!(code, 400);
        assert!(body.contains("need key"));
        let (code, _, body) = route("/replace", true, &query_pairs(&format!("project={p}")), "", "http://x");
        assert_eq!(code, 400);
        assert!(body.contains("need find"));
        let _ = forget_project(&p);
    }

    /// A patch and a task-status transition are a read-modify-write on the SAME note.
    /// Both take TASK_LOCK, so neither can read a body the other is about to replace —
    /// without that, one of them writes back a stale body and a claim or a description
    /// silently vanishes.
    #[test]
    fn concurrent_patch_and_task_status_do_not_lose_each_other() {
        let p = format!("_bt_race_{}", std::process::id());
        let _ = forget_project(&p);
        create_task(&p, "MARKER work to do", "src/a.rs", "open", "");
        write_note(&p, "plan", "task-1").unwrap();

        let pa = p.clone();
        let h1 = std::thread::spawn(move || {
            for i in 0..40 {
                let st = if i % 2 == 0 { "claimed" } else { "open" };
                set_task_status(&pa, "task-1", st, Some("builder-9"), "");
            }
        });
        let pb = p.clone();
        let h2 = std::thread::spawn(move || {
            for i in 0..40 {
                let (from, to) = if i % 2 == 0 { ("MARKER", "MARKED") } else { ("MARKED", "MARKER") };
                patch_note(&pb, "task-1", "replace", from, to, "", "", true, false, "", false);
            }
        });
        h1.join().unwrap();
        h2.join().unwrap();

        // Whatever the interleaving, the note is still a well-formed task: it parses,
        // it kept its owner and files, and the description was never truncated away.
        // Not `[0]` blind: this used to panic "index out of bounds: len is 0" ~1 run in
        // 6 with the whole suite running, because a rescan on another test's thread read
        // this note inside `write_note`'s truncate window and published an empty body.
        // See `a_rescan_beside_a_write_never_publishes_an_empty_body`.
        let rows = tasks(&p);
        assert!(!rows.is_empty(), "task-1 absent from tasks() — an empty body reached the index");
        let t = &rows[0];
        assert_eq!(t["owner"], "builder-9", "{t}");
        assert_eq!(t["files"], "src/a.rs");
        let body = note(&p, "task-1").unwrap();
        assert!(body.contains("MARKER") || body.contains("MARKED"), "description lost: {body}");
        assert!(body.starts_with("status:"), "header lost: {body}");
        let _ = forget_project(&p);
    }


    /// MANUAL WIRE DEMO — the dry-run-then-apply flow over real HTTP, driven by the
    /// same `curl` an agent would type. Ignored by default because it shells out and
    /// prints rather than asserts much; run it with
    ///     cargo test --lib brain::tests::wire_demo -- --ignored --nocapture
    /// It binds an ephemeral port and serves it on its own thread, so it never touches
    /// the live brain (a second client to the running host would kill real panes).
    #[test]
    #[ignore = "manual: prints the /patch + /replace HTTP responses"]
    fn wire_demo_patch_then_dry_run_then_real_replace() {
        let token = "wire-demo-token";
        let p = format!("_bt_wire_{}", std::process::id());
        let _ = forget_project(&p);
        write_note(&p, "release-notes", "PixelMarch 1.4.2\nbuilt from 1.4.2 tags").unwrap();
        write_note(&p, "install", "grab 1.4.2 from the releases page").unwrap();
        write_note(&p, "unrelated", "no version here").unwrap();

        let server = Server::http(("127.0.0.1", 0)).expect("ephemeral port");
        let port = server.server_addr().to_ip().expect("ip addr").port();
        let base = format!("http://127.0.0.1:{port}/t/{token}");
        let b2 = base.clone();
        std::thread::spawn(move || serve(server, &b2, Some(token)));

        let curl = |url: String| -> String {
            let out = std::process::Command::new("curl")
                .args(["-s", "-X", "POST", &url])
                .output()
                .expect("curl");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };

        for (label, url) in [
            ("① single-note patch, dry run",
             format!("{base}/patch?project={p}&key=release-notes&find=1.4.2&replace=0.1.x&dry=1")),
            ("② the same patch, applied",
             format!("{base}/patch?project={p}&key=release-notes&find=1.4.2&replace=0.1.x")),
            ("③ cross-note replace — DRY RUN (no apply=)",
             format!("{base}/replace?project={p}&find=1.4.2&replace=0.1.x")),
            ("④ the same replace, committed with apply=1",
             format!("{base}/replace?project={p}&find=1.4.2&replace=0.1.x&apply=1")),
        ] {
            println!("\n──────── {label}\nPOST {url}\n{}", curl(url.clone()));
        }

        println!("\n──────── notes afterwards");
        for k in keys(&p) {
            println!("{k}: {:?}", note(&p, &k));
        }
        assert!(!note(&p, "install").unwrap().contains("1.4.2"));
        let _ = forget_project(&p);
    }

}
