import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { useLayout } from "../stores/layout";
import { collectPanes, newPane } from "../lib/layout-tree";
import { cliProfileCommand } from "../lib/cliProfiles";
import { DEFAULT_AGENT_CMD, KNOWN_AGENT_CMDS, parentProject } from "../lib/swarm";
import { driftCommand } from "../lib/drift";
import { brainUrl, brainProjects, brainKeys, brainNote, brainSave, brainDelete, brainDeleteProject, brainSearch, brainInfo, brainSetInfo, brainPatch, brainReplace, brainFeedPoke, brainFeedStale, pickFolder, type BrainHit, type BrainEditLine, type BrainPatchResult, type BrainReplaceResult } from "../lib/ipc";

// BigBrain is PixelMarch's built-in memory store (the "Brain"): notes are files at
// brain/<project>/<key>.md in the app's data/ folder. The Manage tab is a plain text editor
// over those files (via Tauri commands — no HTTP). The Setup tab shows the URL of
// the HTTP service so external coding agents can be pointed at the same store.
// The Drift tab launches one CLI agent against one project to check those notes
// against the code they describe.

const btn = (bg: string): CSSProperties => ({ padding: "5px 12px", background: bg, color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" });
const ghost: CSSProperties = { padding: "5px 12px", background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" };
const h: CSSProperties = { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, margin: "0 0 6px" };
const field: CSSProperties = { width: "100%", background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", padding: "6px 8px", fontSize: 12, boxSizing: "border-box" };

// Case-insensitive, locale-aware name sort — used for every project/notes listing
// so the comboboxes and lists read alphabetically regardless of key casing.
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

// Swarm projects ("<parent>-swarm-<slug>-<uid4>", or bare "swarm-<slug>" when there is
// no parent) are transient coordination scratch — hidden from the project pickers
// unless "Show swarm notes" is checked.
const isSwarmProject = (name: string) => /(^|-)swarm-/.test(name);

// ── minimal edit: send the change, not the note ──────────────────────────────
// The editor is a textarea over the whole body, but the WRITE does not have to be.
// `minimalEdit` finds the one block of lines that actually changed and turns it
// into a `POST /patch` op=replace, so saving a two-word fix in a 400-line note
// ships two words. Returns null when there is no win and the caller should just
// re-save the whole body.
//
// `find` must be UNIQUE in the stored body, or op=replace would hit the wrong
// copy — so the block grows outward, one common line at a time, until it is.
// That same unique string doubles as `expect`: if the note changed underneath us
// the substring is gone and the brain refuses the patch instead of clobbering.

// Occurrences counted at EVERY position, overlaps included — `"aa"` occurs twice
// in `"aaa"`. String.split would say once, and a `find` that really appears twice
// would let op=replace edit the wrong copy.
const occurrences = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/** Character offset of the start of line `n`. Whole LINES are cut, newline
 *  included, so a deletion drops its line break with it instead of leaving a
 *  blank line behind. */
const lineStart = (s: string, lines: string[], n: number) => {
  if (n >= lines.length) return s.length;
  let c = 0;
  for (let i = 0; i < n; i++) c += lines[i].length + 1;
  return c;
};

export function minimalEdit(before: string, after: string): { find: string; replace: string } | null {
  if (before === after) return null;
  const b = before.split("\n");
  const a = after.split("\n");

  let pre = 0;
  while (pre < b.length && pre < a.length && b[pre] === a[pre]) pre++;
  let suf = 0;
  while (suf < b.length - pre && suf < a.length - pre && b[b.length - 1 - suf] === a[a.length - 1 - suf]) suf++;

  for (;;) {
    const find = before.slice(lineStart(before, b, pre), lineStart(before, b, b.length - suf));
    const replace = after.slice(lineStart(after, a, pre), lineStart(after, a, a.length - suf));
    // A pure insertion changes no line of its own, so `find` comes out empty and
    // op=replace has nothing to anchor to — one more case the grow loop fixes.
    if (find && occurrences(before, find) === 1) {
      // Only worth it if the patch is genuinely smaller than the body it replaces.
      return find.length + replace.length < after.length ? { find, replace } : null;
    }
    if (suf > 0) suf--;
    else if (pre > 0) pre--;
    else return null; // grown to the whole note — nothing saved, save it whole
  }
}

// ── shared bits for rendering a patch/replace preview ────────────────────────
const mono: CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" };

function DiffLines({ lines, elided }: { lines: BrainEditLine[]; elided?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <span style={{ ...mono, color: "var(--muted)", minWidth: 28, textAlign: "right", flexShrink: 0 }}>{l.line}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            {l.before !== null && <div style={{ ...mono, color: "#e06c75", textDecoration: l.after === null ? "line-through" : undefined }}>- {l.before}</div>}
            {l.after !== null && <div style={{ ...mono, color: "#7fc98a" }}>+ {l.after}</div>}
          </div>
        </div>
      ))}
      {!!elided && <p style={{ margin: "2px 0 0 34px", fontSize: 10.5, color: "var(--muted)" }}>…and {elided} more changed {elided === 1 ? "line" : "lines"} in this note</p>}
    </div>
  );
}

function SwarmToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", cursor: "pointer", userSelect: "none" }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} style={{ margin: 0 }} />
      Show swarm notes
    </label>
  );
}

export default function BigBrain() {
  const open = useLayout((s) => s.bigBrainOpen);
  const close = useLayout((s) => s.openBigBrain);
  const [tab, setTab] = useState<"manage" | "visualize" | "setup" | "drift">("manage");

  return (
    <div
      style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 480, maxWidth: "94vw", zIndex: 90,
        display: open ? "flex" : "none", flexDirection: "column",
        background: "var(--panel)", borderLeft: "1px solid var(--border)", boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>🧠 BigBrain</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setTab("manage")} style={{ ...ghost, background: tab === "manage" ? "var(--accent)" : "var(--border)", color: tab === "manage" ? "#fff" : "var(--text)" }}>Manage</button>
        <button onClick={() => setTab("visualize")} style={{ ...ghost, background: tab === "visualize" ? "var(--accent)" : "var(--border)", color: tab === "visualize" ? "#fff" : "var(--text)" }}>Visualize</button>
        <button onClick={() => setTab("setup")} style={{ ...ghost, background: tab === "setup" ? "var(--accent)" : "var(--border)", color: tab === "setup" ? "#fff" : "var(--text)" }}>Setup</button>
        <button onClick={() => setTab("drift")} style={{ ...ghost, background: tab === "drift" ? "var(--accent)" : "var(--border)", color: tab === "drift" ? "#fff" : "var(--text)" }}>Drift</button>
        <button onClick={() => close(false)} title="Close (Esc)" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15 }}>×</button>
      </div>

      {tab === "manage" ? <Manage /> : tab === "visualize" ? <Visualize /> : tab === "setup" ? <Setup /> : <Drift />}
    </div>
  );
}

// ── Manage: a text editor over brain/<project>/<key>.md ──────────────────────
function Manage() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [key, setKey] = useState("");   // key being edited ("" = new note)
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showSwarm, setShowSwarm] = useState(false);
  const [bulk, setBulk] = useState(false);
  // The body as it was LOADED, and the key it was loaded under — the baseline the
  // minimal patch is computed against. Cleared for a new/renamed note, which has
  // no stored body to patch.
  const [orig, setOrig] = useState<{ key: string; value: string } | null>(null);

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(""), 1600); };

  const loadProjects = useCallback(async () => {
    const p = await brainProjects().catch(() => []);
    setProjects(p);
    setProject((cur) => cur || p.find((x) => !isSwarmProject(x)) || "");
  }, []);

  // A hidden-category project stays listed while it's the current selection.
  const visibleProjects = useMemo(
    () => projects.filter((p) => showSwarm || !isSwarmProject(p) || p === project).sort(byName),
    [projects, showSwarm, project],
  );

  const loadKeys = useCallback(async (p: string) => {
    setKeys(p ? (await brainKeys(p).catch(() => [])).sort(byName) : []);
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { loadKeys(project); }, [project, loadKeys]);

  const newNote = () => { setKey(""); setValue(""); setDirty(false); setOrig(null); };

  const openNote = async (k: string) => {
    const v = await brainNote(project, k).catch(() => "") || "";
    setKey(k); setValue(v); setDirty(false); setOrig({ key: k, value: v });
  };

  const save = async () => {
    const k = key.trim();
    if (!project) { flash("Pick or create a project"); return; }
    if (!k) { flash("Key required"); return; }
    if (!value.trim()) { flash("Value required"); return; }

    // Editing a note we loaded, under the same key? Ship only the changed block.
    // A rename or a brand-new note has no stored baseline, so it saves whole.
    const patch = orig && orig.key === k ? minimalEdit(orig.value, value) : null;
    if (patch) {
      const r: BrainPatchResult = await brainPatch(project, k, { op: "replace", all: false, expect: patch.find, ...patch })
        .catch((e) => ({ ok: false, project, key: k, error: String(e) }));
      // A MISSING `expect` — and only that — means someone rewrote the note since
      // we loaded it. Saving the whole body now would silently drop their edit, so
      // stop and make the human re-read it.
      //
      // The guard sees writes the BRAIN made — its own IPC and every agent on the
      // HTTP service, which is everything that legitimately writes notes. A note
      // edited straight on disk behind the brain's back is only caught once the
      // index watcher has ingested it (`patch_note` reads the index, not the
      // file), the same blind spot a whole-body save has.
      if (!r.ok && r.reason === "expect not found") { flash("Note changed on disk — reopen it"); return; }
      // Any OTHER patch failure (the note is gone, the write errored, the invoke
      // itself rejected) leaves the baseline intact and says nothing about a
      // concurrent edit — so fall through to the whole-body save the human asked
      // for rather than leaving them unable to save at all.
      if (r.ok) {
        brainFeedPoke(project, k, value); // our own write — the feed must not lag it
        setOrig({ key: k, value });
        setDirty(false); flash(`Saved ✓ (patched ${patch.find.length + patch.replace.length} B)`);
        await loadKeys(project);
        return;
      }
    }

    try { await brainSave(project, k, value); } catch { flash("Save failed"); return; }
    setOrig({ key: k, value });
    setDirty(false); flash("Saved ✓");
    await loadProjects(); await loadKeys(project);
  };

  const del = async (k: string) => {
    if (!confirm(`Delete note "${k}"?`)) return;
    await brainDelete(project, k).catch(() => {});
    if (k === key) newNote();
    flash("Deleted");
    await loadProjects(); await loadKeys(project);
  };

  // Projects are just folders — a new one materializes when its first note is saved.
  const newProject = () => {
    const name = prompt("New project name:")?.trim();
    if (!name) return;
    setProjects((ps) => (ps.includes(name) ? ps : [...ps, name].sort(byName)));
    setProject(name); setKeys([]); newNote();
  };

  const delProject = async () => {
    if (!project) return;
    if (!confirm(`Delete project "${project}" and ALL its notes?`)) return;
    await brainDeleteProject(project).catch(() => {});
    setProject(""); newNote();
    await loadProjects();
    flash("Project deleted");
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", fontSize: 12.5, color: "var(--text)" }}>
      {/* project bar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select value={project} onChange={(e) => { setProject(e.target.value); newNote(); }} style={{ ...field, width: "auto", flex: 1 }}>
            {visibleProjects.length === 0 && <option value="">(no projects)</option>}
            {visibleProjects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={() => { loadProjects(); loadKeys(project); }} title="Refresh" style={ghost}>⟳</button>
          <button onClick={newProject} title="New project" style={ghost}>+</button>
          <button onClick={delProject} title="Delete project" disabled={!project} style={{ ...ghost, opacity: project ? 1 : 0.4 }}>🗑</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SwarmToggle on={showSwarm} set={setShowSwarm} />
          <span style={{ flex: 1 }} />
          <button onClick={() => setBulk((b) => !b)} title="Search and replace across many notes"
            style={{ ...ghost, ...(bulk ? { background: "var(--accent)", color: "#fff" } : null) }}>
            ⇄ Find &amp; replace
          </button>
        </div>
      </div>

      {bulk ? (
        <BulkEdit project={project} onWrote={async () => {
          await loadKeys(project);
          // The open note may be one of the ones just rewritten — re-read it so
          // the editor is not sitting on a body the store no longer has.
          if (key.trim() && orig) await openNote(key.trim());
        }} />
      ) : (
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* notes list */}
        <div style={{ width: 150, borderRight: "1px solid var(--border)", overflowY: "auto", padding: 6 }}>
          <button onClick={newNote} style={{ ...btn("var(--accent)"), width: "100%", marginBottom: 6 }}>+ New note</button>
          {keys.length === 0 && <p style={{ color: "var(--muted)", fontSize: 11, padding: "4px 6px" }}>No notes yet.</p>}
          {keys.map((k) => (
            <div key={k} onClick={() => openNote(k)} title={k}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px", borderRadius: 4, cursor: "pointer", background: k === key ? "var(--border)" : "transparent" }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>{k}</span>
              <span onClick={(e) => { e.stopPropagation(); del(k); }} title="Delete" style={{ color: "var(--muted)", cursor: "pointer" }}>×</span>
            </div>
          ))}
        </div>

        {/* editor */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 10, gap: 8 }}>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="note-key (lower-kebab-case)" style={field} />
          <textarea value={value} onChange={(e) => { setValue(e.target.value); setDirty(true); }} placeholder="Note text — what & where."
            style={{ ...field, flex: 1, resize: "none", fontFamily: "ui-monospace, monospace", lineHeight: 1.5 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={save} style={btn("var(--accent)")}>{dirty ? "Save*" : "Save"}</button>
            {key && <button onClick={() => del(key)} style={ghost}>Delete</button>}
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--muted)", fontSize: 11 }}>{status}</span>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ── Find & replace across many notes ─────────────────────────────────────────
// The whole point of this view is the DRY RUN. `POST /replace` previews by
// default and only writes when it is re-sent with apply=1, and the UI mirrors
// that exactly: Apply is dead until a preview for THESE inputs exists, and
// editing any input throws the preview away. A bulk replace with a pattern
// broader than intended corrupts the store, and the store is the only copy.
function BulkEdit({ project, onWrote }: { project: string; onWrote: () => void }) {
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState("");
  const [regex, setRegex] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [includeTasks, setIncludeTasks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BrainReplaceResult | null>(null);
  const [done, setDone] = useState<BrainReplaceResult | null>(null);
  const [err, setErr] = useState("");

  // Any change to the request invalidates the preview — Apply must never be able
  // to commit something other than what the human read.
  const invalidate = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreview(null); setDone(null); setErr(""); };

  // …and `project` is an input too, even though it is not one of ours: the project
  // picker lives ABOVE this view and stays live while it is open. Apply always
  // sends the CURRENT project, so a preview kept across a switch would write a
  // project nobody previewed — the exact corruption this view exists to prevent.
  useEffect(() => { setPreview(null); setDone(null); setErr(""); }, [project]);

  const req = { project, allProjects: everywhere, find, replace: repl, regex, includeTasks };

  // A bulk apply rewrites notes any swarm surface may be reading (plan, mission,
  // status-<role>). It answers with rows, not bodies, so the feed cannot be handed
  // the new text — drop what it cached for those keys so it re-reads them on the
  // next tick instead of holding the old body for up to RECONCILE_MS.
  const stale = (r: BrainReplaceResult) => {
    const byProject = new Map<string, string[]>();
    for (const nt of r.notes ?? []) (byProject.get(nt.project) ?? byProject.set(nt.project, []).get(nt.project)!).push(nt.key);
    for (const [p, ks] of byProject) brainFeedStale(p, ks);
  };

  const run = async (apply: boolean, limit?: number) => {
    if (!find || busy) return;
    setBusy(true); setErr("");
    try {
      // PIN THE APPLY TO THE PREVIEWED NOTES. The brain re-scans on apply, so a
      // note that started matching since the preview would be rewritten without
      // ever having been shown. `keys=` is a plain key list with no project of
      // its own, so it can only pin a single-project run; across the whole store
      // the re-scan stands (and the preview is seconds old).
      const previewedKeys = apply && !everywhere && preview ? preview.notes.map((nt) => nt.key) : [];
      // `keys=` is comma-split on the other side, so a key holding a comma cannot
      // be expressed — pin nothing rather than pin a SHORTER list and skip a note
      // the human just approved.
      const previewed = previewedKeys.some((k) => k.includes(",")) ? [] : previewedKeys;
      const r = await brainReplace({
        ...req, apply,
        ...(previewed.length ? { keys: previewed.join(",") } : null),
        ...(limit ? { limit } : null),
      });
      if (apply) {
        if (r.ok || r.written) { setDone(r); setPreview(null); stale(r); onWrote(); }
        // ok:false with a `limit` is the safety stop, not a failure — keep the
        // preview up so the human can widen it deliberately.
        if (!r.ok) { setErr(r.hint || r.reason || "replace failed"); if (r.limit) setPreview({ ...r, dry: true }); }
      } else {
        setPreview(r); setDone(null);
        if (!r.ok) setErr(r.hint || r.reason || "search failed");
      }
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const scope = everywhere ? "every project" : project || "(no project)";
  const n = preview?.notes_matched ?? 0;
  const check = (on: boolean, set: (v: boolean) => void, label: string, title?: string) => (
    <label title={title} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)", cursor: "pointer", userSelect: "none" }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} style={{ margin: 0 }} />
      {label}
    </label>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
        <input value={find} onChange={(e) => invalidate(setFind)(e.target.value)} placeholder="Find…" spellCheck={false} style={{ ...field, fontFamily: "ui-monospace, monospace" }} />
        <input value={repl} onChange={(e) => invalidate(setRepl)(e.target.value)} placeholder="Replace with… (empty = delete the text)" spellCheck={false} style={{ ...field, fontFamily: "ui-monospace, monospace" }} />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {check(regex, invalidate(setRegex), "Regex")}
          {check(everywhere, invalidate(setEverywhere), "All projects", "Search every project in the store, not just the selected one")}
          {check(includeTasks, invalidate(setIncludeTasks), "Include task-N notes", "task-<n> notes are a machine-parsed header a stray replace can silently re-open or re-assign — off by default")}
        </div>
        {regex && (
          // Documented footgun (brain/mod.rs:791): in regex mode the REPLACEMENT
          // goes through capture expansion, so a literal `$` is read as a group
          // reference — `$BIGBRAIN_URL` expands to nothing at all.
          <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.45, color: "#d9a441" }}>
            Regex mode expands <code>$1</code>, <code>$name</code> in the replacement — a literal <code>$</code> there
            is read as a capture reference (<code>$BIGBRAIN_URL</code> becomes empty). Escape it as <code>$$</code>,
            or leave Regex off. The preview below shows the real result either way — read it before applying.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => run(false)} disabled={busy || !find || (!everywhere && !project)}
            style={{ ...btn("var(--accent)"), opacity: busy || !find || (!everywhere && !project) ? 0.5 : 1 }}>
            {busy && !preview ? "…" : "Preview changes"}
          </button>
          <button
            onClick={() => {
              if (!preview || !preview.notes_matched) return;
              if (!confirm(`Rewrite ${preview.notes_matched} note${preview.notes_matched === 1 ? "" : "s"} in ${scope}?\n\n${preview.hits} occurrence${preview.hits === 1 ? "" : "s"} of "${find}" become "${repl}".\n\nThere is no undo.`)) return;
              run(true, preview.limit ? preview.notes_matched : undefined);
            }}
            disabled={busy || !preview || !n}
            style={{ ...btn("#c0563f"), opacity: busy || !preview || !n ? 0.4 : 1 }}>
            {preview?.limit ? `Apply anyway (${n})` : `Apply to ${n} note${n === 1 ? "" : "s"}`}
          </button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>in {scope}</span>
        </div>
        {!!err && <p style={{ margin: 0, fontSize: 11, color: "#e06c75" }}>{err}</p>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px" }}>
        {done ? (
          <p style={{ color: "#7fc98a", fontSize: 12 }}>
            Wrote {done.written ?? 0} note{done.written === 1 ? "" : "s"}.
            {!!done.failed?.length && <span style={{ color: "#e06c75" }}> {done.failed.length} failed — they still hold the old text, run it again.</span>}
          </p>
        ) : !preview ? (
          <p style={{ color: "var(--muted)", fontSize: 11.5, lineHeight: 1.6 }}>
            Type what to find, hit <b>Preview changes</b>, and every note and line that would change is
            listed here. Nothing is written until you read that and press Apply.
          </p>
        ) : !preview.notes_matched ? (
          <p style={{ color: "var(--muted)", fontSize: 11.5 }}>No note in {scope} would change.</p>
        ) : (
          <>
            <p style={{ ...h, margin: "0 0 8px" }}>
              dry run · {preview.notes_matched} note{preview.notes_matched === 1 ? "" : "s"} · {preview.hits} occurrence{preview.hits === 1 ? "" : "s"} · nothing written yet
            </p>
            {preview.notes.map((nt) => (
              <div key={`${nt.project}/${nt.key}`} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                <p style={{ margin: "0 0 4px", fontSize: 11.5 }}>
                  {(everywhere || nt.project !== project) && <span style={{ color: "#b06cc9" }}>{nt.project} / </span>}
                  <b>{nt.key}</b>
                  <span style={{ color: "var(--muted)" }}> · {nt.hits} hit{nt.hits === 1 ? "" : "s"}</span>
                </p>
                {nt.multiline
                  ? <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>The replacement spans lines — no per-line preview; open the note to check it.</p>
                  : <DiffLines lines={nt.lines} elided={nt.lines_elided} />}
              </div>
            ))}
            {!includeTasks && (
              <p style={{ margin: 0, fontSize: 10.5, color: "var(--muted)" }}>
                Swarm coordination notes are in scope — only <code>task-&lt;n&gt;</code> notes are skipped.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Visualize: search → radial network graph of matching notes ───────────────
// Center = the searched project; its matching notes ring it. Hits living in OTHER
// projects hang off a node for that project, which links back to the center.
// Pure SVG, deterministic radial layout — no graph library.

type GKind = "center" | "proj" | "note";
type GNode = { id: string; x: number; y: number; r: number; a: number; label: string; kind: GKind; hit?: BrainHit };
type GEdge = { from: GNode; to: GNode; kind: "proj" | "note" };
type Graph = { nodes: GNode[]; edges: GEdge[]; VW: number; VH: number; homeCount: number; projCount: number; elseCount: number };

const VW = 460;
const noteId = (h: BrainHit) => `n:${h.project}/${h.key}`;

function buildGraph(project: string, hits: BrainHit[]): Graph {
  const home = hits.filter((h) => !h.elsewhere);

  const byProj = new Map<string, BrainHit[]>();
  for (const h of hits) if (h.elsewhere) (byProj.get(h.project) ?? byProj.set(h.project, []).get(h.project)!).push(h);
  const others = [...byProj.entries()].sort((a, b) => byName(a[0], b[0]));

  // Ring radii grow with node count so dense searches spread out instead of piling up.
  const rHome = Math.min(132, 74 + home.length * 6);
  const rProj = others.length ? rHome + 92 : rHome;
  const pad = 78; // room for outward labels
  const maxR = rProj + (others.length ? 46 : 0);
  const VH = Math.round(Math.max(300, (maxR + pad) * 2));
  const cx = VW / 2, cy = VH / 2;

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const center: GNode = { id: `p:${project}`, x: cx, y: cy, r: 24, a: 0, label: project, kind: "center" };
  nodes.push(center);

  // Home-project notes on an inner ring around the center.
  home.forEach((h, i) => {
    const a = (i / Math.max(home.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const n: GNode = { id: noteId(h), x: cx + Math.cos(a) * rHome, y: cy + Math.sin(a) * rHome, r: 7, a, label: h.key, kind: "note", hit: h };
    nodes.push(n);
    edges.push({ from: center, to: n, kind: "note" });
  });

  // Other projects on an outer ring; each project's notes fan outward off it.
  others.forEach(([p, notes], j) => {
    const a = (j / others.length) * Math.PI * 2 + Math.PI / 4;
    const pn: GNode = { id: `p:${p}`, x: cx + Math.cos(a) * rProj, y: cy + Math.sin(a) * rProj, r: 14, a, label: p, kind: "proj" };
    nodes.push(pn);
    edges.push({ from: center, to: pn, kind: "proj" });
    notes.forEach((h, i) => {
      const na = a + (i - (notes.length - 1) / 2) * 0.5; // arc centered on the outward direction
      const n: GNode = { id: noteId(h), x: pn.x + Math.cos(na) * 46, y: pn.y + Math.sin(na) * 46, r: 6, a: na, label: h.key, kind: "note", hit: h };
      nodes.push(n);
      edges.push({ from: pn, to: n, kind: "note" });
    });
  });
  return { nodes, edges, VW, VH, homeCount: home.length, projCount: others.length, elseCount: hits.length - home.length };
}

function Visualize() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<BrainHit[] | null>(null); // null = no search yet
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<BrainHit | null>(null);
  const [hovered, setHovered] = useState<string | null>(null); // node id under the cursor
  const [showSwarm, setShowSwarm] = useState(false);

  useEffect(() => {
    brainProjects().catch(() => [] as string[]).then((p) => { setProjects(p); setProject((cur) => cur || p.find((x) => !isSwarmProject(x)) || ""); });
  }, []);

  const visibleProjects = useMemo(
    () => projects.filter((p) => showSwarm || !isSwarmProject(p) || p === project).sort(byName),
    [projects, showSwarm, project],
  );

  const search = async () => {
    if (!project || !q.trim() || busy) return;
    setBusy(true); setSelected(null);
    try { setHits(await brainSearch(project, q.trim())); } catch { setHits([]); }
    setBusy(false);
  };

  const graph = useMemo(() => (hits && hits.length ? buildGraph(project, hits) : null), [project, hits]);
  const noteFill = (h: BrainHit) => (h.elsewhere ? "#b06cc9" : "var(--accent)");
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  // Focus = the hovered node, or the selected note when nothing is hovered. When a
  // node is focused, its neighbours stay lit and everything else dims — so a dense
  // graph is still readable one branch at a time.
  const focusId = hovered ?? (selected ? noteId(selected) : null);
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (!graph || !focusId) return s;
    s.add(focusId);
    for (const e of graph.edges) {
      if (e.from.id === focusId) s.add(e.to.id);
      if (e.to.id === focusId) s.add(e.from.id);
    }
    return s;
  }, [graph, focusId]);
  const lit = (id: string) => !focusId || neighbours.has(id);

  // Node labels radiate outward from the centre so they clear the ring; a panel-
  // coloured halo (paint-order) keeps them legible where they cross edges.
  const labelHalo: CSSProperties = { paintOrder: "stroke", stroke: "var(--panel)", strokeWidth: 3, strokeLinejoin: "round" };
  const swatch: CSSProperties = { width: 9, height: 9, borderRadius: "50%", display: "inline-block" };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", fontSize: 12.5, color: "var(--text)" }}>
      {/* controls: project combo, then search box + button */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
        <select value={project} onChange={(e) => { setProject(e.target.value); setHits(null); setSelected(null); }} style={field}>
          {visibleProjects.length === 0 && <option value="">(no projects)</option>}
          {visibleProjects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <SwarmToggle on={showSwarm} set={setShowSwarm} />
        <div style={{ display: "flex", gap: 6 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search notes…" style={{ ...field, flex: 1 }} />
          <button onClick={search} disabled={busy || !project || !q.trim()}
            style={{ ...btn("var(--accent)"), opacity: busy || !project || !q.trim() ? 0.5 : 1 }}>{busy ? "…" : "Search"}</button>
        </div>
      </div>

      {/* counts + legend */}
      {graph && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--muted)", flexWrap: "wrap" }}>
          <span><b style={{ color: "var(--text)" }}>{graph.homeCount + graph.elseCount}</b> notes</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ ...swatch, background: "var(--accent)" }} />{graph.homeCount} here</span>
          {graph.projCount > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><i style={{ ...swatch, background: "#b06cc9" }} />{graph.elseCount} in {graph.projCount} other {graph.projCount === 1 ? "project" : "projects"}</span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ opacity: 0.8 }}>hover to focus · click to open</span>
        </div>
      )}

      {/* graph */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {!graph ? (
          <p style={{ color: "var(--muted)", padding: 14 }}>
            {hits === null ? "Pick a project and search — matching notes appear as a network graph. Hits from other projects link off their own project node." : "No notes matched."}
          </p>
        ) : (
          <svg viewBox={`0 0 ${graph.VW} ${graph.VH}`} style={{ width: "100%", display: "block" }} onMouseLeave={() => setHovered(null)}>
            {graph.edges.map((e, i) => {
              const on = lit(e.from.id) && lit(e.to.id);
              return (
                <line key={i} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}
                  stroke={e.kind === "proj" ? "#b06cc9" : "var(--border)"} strokeWidth={e.kind === "proj" ? 1.6 : 1}
                  strokeDasharray={e.kind === "proj" ? "4 3" : undefined}
                  strokeOpacity={on ? (e.kind === "proj" ? 0.9 : 0.7) : 0.12} />
              );
            })}
            {graph.nodes.map((n) => {
              const on = lit(n.id);
              const isSel = !!selected && n.hit === selected;
              const dirX = Math.cos(n.a);
              const anchor = n.kind === "note" ? (dirX > 0.25 ? "start" : dirX < -0.25 ? "end" : "middle") : "middle";
              const lx = n.kind === "note" ? n.x + dirX * (n.r + 4) : n.x;
              const ly = n.kind === "note" ? n.y + Math.sin(n.a) * (n.r + 4) + 3 : n.y + 3;
              return (
                <g key={n.id} opacity={on ? 1 : 0.28}
                  onClick={() => n.hit && setSelected(n.hit)}
                  onMouseEnter={() => setHovered(n.id)}
                  style={{ cursor: n.hit ? "pointer" : "default" }}>
                  <title>{n.hit ? `${n.hit.project} / ${n.hit.key}\n\n${clip(n.hit.value, 400)}` : n.label}</title>
                  <circle cx={n.x} cy={n.y} r={isSel ? n.r + 1.5 : n.r}
                    fill={n.kind === "center" ? "var(--accent)" : n.kind === "proj" ? "#b06cc9" : noteFill(n.hit!)}
                    fillOpacity={n.kind === "note" ? 0.7 : 1}
                    stroke={isSel ? "var(--text)" : "var(--panel)"} strokeWidth={isSel ? 2 : 1.5} />
                  {n.kind === "note" ? (
                    <text x={lx} y={ly} textAnchor={anchor} fill="var(--text)" fontSize={9} style={labelHalo}>
                      {clip(n.label, 22)}
                    </text>
                  ) : (
                    <>
                      <text x={n.x} y={n.y + 3} textAnchor="middle" fill="#fff" fontSize={n.kind === "center" ? 10 : 9} fontWeight={600}>
                        {clip(n.label, n.kind === "center" ? 10 : 7)}
                      </text>
                      {n.kind === "proj" && (
                        <text x={n.x} y={n.y + n.r + 11} textAnchor="middle" fill="var(--muted)" fontSize={9} style={labelHalo}>
                          {clip(n.label, 24)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* selected note preview */}
      {selected && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "8px 12px", maxHeight: 140, overflowY: "auto" }}>
          <p style={{ ...h, margin: "0 0 4px" }}>{selected.project} / {selected.key}</p>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--text)" }}>{selected.value}</pre>
        </div>
      )}
    </div>
  );
}

// ── Setup: URL + agent snippet (points external agents at the HTTP service) ───
function Setup() {
  const [brain, setBrain] = useState("");
  const [copied, setCopied] = useState("");
  const [info, setInfo] = useState("");
  const [infoStatus, setInfoStatus] = useState("");
  useEffect(() => { brainUrl().then(setBrain).catch(() => {}); }, []);

  const loadInfo = useCallback(async () => {
    setInfo(await brainInfo().catch(() => ""));
  }, []);
  useEffect(() => { loadInfo(); }, [loadInfo]);

  const flashInfo = (m: string) => { setInfoStatus(m); setTimeout(() => setInfoStatus(""), 1600); };

  const saveInfo = async () => {
    if (!info.trim()) { flashInfo("Text required — use Reset for the default"); return; }
    try { await brainSetInfo(info); flashInfo("Saved ✓"); } catch { flashInfo("Save failed"); }
  };

  const resetInfo = async () => {
    if (!confirm("Reset the info page to the built-in default?")) return;
    try {
      await brainSetInfo("");
      await loadInfo();
      flashInfo("Reset ✓");
    } catch { flashInfo("Reset failed"); }
  };

  const snippet = brain
    ? `This machine runs a local memory service (BigBrain) at ${brain}.\n` +
      `Run \`curl -s ${brain}/info\` and follow it: recall relevant notes before you start, ` +
      `and remember durable notes (what & where) after. Project = this folder's name.`
    : "";

  const copy = (label: string, text: string) => {
    // Tauri plugin first — WebView2 silently drops navigator.clipboard writes
    // without focus/permission; navigator stays as the browser-dev fallback.
    clipboardWriteText(text)
      .catch(() => navigator.clipboard?.writeText(text))
      .then(() => { setCopied(label); setTimeout(() => setCopied(""), 1500); })
      .catch(() => {});
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px 18px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text)" }}>
      {!brain ? (
        <p style={{ color: "var(--muted)" }}>
          The HTTP memory service couldn't claim a local port (8734–8744 all busy). Notes still work
          in the Manage tab (they're just files) — this only affects pointing external agents at them.
        </p>
      ) : (
        <>
          <section style={{ marginBottom: 18 }}>
            <p style={h}>Shared memory service</p>
            <code style={{ display: "block", background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 5, padding: "7px 9px", fontSize: 12, wordBreak: "break-all" }}>{brain}</code>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => copy("url", brain)} style={ghost}>{copied === "url" ? "Copied ✓" : "Copy URL"}</button>
              <button onClick={() => openUrl(brain).catch(() => {})} style={ghost}>Open dashboard ↗</button>
            </div>
          </section>

          <section style={{ marginBottom: 18 }}>
            <p style={h}>Point a coding agent at it</p>
            <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>
              Run any coding agent (Claude Code, etc.) in a PixelMarch terminal and paste this — it fetches <code>/info</code> and learns the rest, then recalls before working and remembers after.
            </p>
            <pre style={{ margin: 0, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 5, padding: "9px 10px", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{snippet}</pre>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => copy("snippet", snippet)} style={btn("var(--accent)")}>{copied === "snippet" ? "Copied ✓" : "Copy agent setup"}</button>
            </div>
          </section>

          <section style={{ marginBottom: 18 }}>
            <p style={h}>Edit info page</p>
            <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>
              The guide agents fetch from <code>/info</code> (also shown on the dashboard page). Saved as <code>brain/info.md</code>;
              write <code>{"{base}"}</code> where the service URL should appear. Reset restores the built-in text.
            </p>
            <textarea value={info} onChange={(e) => setInfo(e.target.value)} spellCheck={false}
              style={{ ...field, height: 180, resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: 1.5 }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <button onClick={saveInfo} style={btn("var(--accent)")}>Save</button>
              <button onClick={resetInfo} style={ghost}>Reset to default</button>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--muted)", fontSize: 11 }}>{infoStatus}</span>
            </div>
          </section>

          <section>
            <p style={h}>How it works</p>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)" }}>
              <li>Notes are per-project (project = the working folder's name), stored in the app's <code>data/</code> folder — portable, offline.</li>
              <li>Agents share it: what one remembers, the next recalls — across sessions.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

// ── Drift: launch one CLI agent to audit a project's notes against its code ───
// A note is written once and read for months, so the code moves out from under
// it silently — this is the "go look" button. It composes ONE pane (folder +
// client + prompt) and hands it to the layout; the audit itself is just an agent
// reading /keys and the repo side by side.
//
// The FOLDER is what is picked, not a brain project: a note records its project
// by NAME only, never by path, so the brain cannot say where a project lives and
// a project-list-only picker would be unable to audit anything the app has not
// already opened. The project name is derived from the folder (same rule the
// rest of PixelMarch uses — parentProject) and stays editable for the case where
// the notes were filed under a different name.
function Drift() {
  const close = useLayout((s) => s.openBigBrain);
  const openPaneTab = useLayout((s) => s.openPaneTab);
  const addToast = useLayout((s) => s.addToast);
  const cliProfiles = useLayout((s) => s.cliProfiles);
  const profiles = useLayout((s) => s.profiles);
  const workspaces = useLayout((s) => s.workspaces);

  const [brain, setBrain] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [showSwarm, setShowSwarm] = useState(false);
  const [cwd, setCwd] = useState("");
  const [project, setProject] = useState("");
  // Once the name has been typed by hand it stops following the folder — the
  // whole reason the field is editable is that the two can legitimately differ.
  const [named, setNamed] = useState(false);
  const [cmd, setCmd] = useState(DEFAULT_AGENT_CMD);
  const [skip, setSkip] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => { brainUrl().then(setBrain).catch(() => {}); }, []);
  useEffect(() => { brainProjects().then(setProjects).catch(() => setProjects([])); }, []);

  // Every folder PixelMarch already knows: profile templates plus the cwd of
  // every pane in every workspace. Suggestions for the folder field — the native
  // picker is there for everything else.
  const knownCwds = useMemo(() => {
    const all = [...profiles.map((p) => p.cwd), ...workspaces.flatMap((w) => collectPanes(w.root).map((p) => p.cwd))];
    return [...new Set(all.map((c) => c?.trim()).filter((c): c is string => !!c))].sort(byName);
  }, [profiles, workspaces]);

  const visible = useMemo(
    () => projects.filter((p) => showSwarm || !isSwarmProject(p)).sort(byName),
    [projects, showSwarm],
  );

  const pickCwd = (dir: string) => {
    setCwd(dir);
    setErr("");
    if (!named) setProject(parentProject(dir.trim()));
  };

  const browse = async () => {
    const dir = await pickFolder("Choose the project folder to audit").catch(() => null);
    if (dir) pickCwd(dir);
  };

  // Notes are per-name, so a name with nothing under it is a real (and common)
  // mistake — an audit of an empty project reads clean and proves nothing. Said,
  // not blocked: the project list is only as fresh as the panel's last load.
  const unknown = !!project.trim() && projects.length > 0 && !projects.includes(project.trim());

  const preview = useMemo(
    () => (project.trim() && cmd.trim() && brain ? driftCommand(cmd.trim(), project.trim(), brain, skip) : ""),
    [project, cmd, brain, skip],
  );

  const launch = () => {
    const p = project.trim(), dir = cwd.trim(), agent = cmd.trim();
    if (!dir) { setErr("Pick the folder to audit — the agent reads the code the notes describe"); return; }
    if (!p) { setErr("Project name required — it is what the notes are filed under"); return; }
    if (!agent) { setErr("Pick a CLI client"); return; }
    if (!brain) { setErr("The memory service has no URL — the agent would have nothing to read"); return; }
    const line = driftCommand(agent, p, brain, skip);
    if (!line) { setErr("Could not build a safe command line for that project name"); return; }
    openPaneTab(newPane({ title: `drift: ${p}`, cwd: dir, startupCommand: line, color: "#b06cc9", restartPolicy: "never" }));
    close(false);
    addToast(`Drift audit of ${p} launched`);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px 18px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text)" }}>
      <p style={{ margin: "0 0 14px", color: "var(--muted)" }}>
        Opens a terminal tab running your CLI client with one job: read every note of a project and check it against the
        code that is actually there now. It reports what drifted and changes nothing until you say so.
      </p>

      <section style={{ marginBottom: 14 }}>
        <p style={h}>Folder to audit</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input list="drift-cwd-options" style={{ ...field, flex: 1, minWidth: 0 }} placeholder="path to the project folder"
            value={cwd} onChange={(e) => pickCwd(e.target.value)} />
          <button onClick={browse} style={ghost}>Browse…</button>
        </div>
        <datalist id="drift-cwd-options">
          {knownCwds.map((c) => <option key={c} value={c} />)}
        </datalist>
      </section>

      <section style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <p style={{ ...h, flex: 1 }}>Project (notes to check)</p>
          <SwarmToggle on={showSwarm} set={setShowSwarm} />
        </div>
        <input list="drift-project-options" style={field} placeholder="named after the folder" value={project}
          onChange={(e) => { setProject(e.target.value); setNamed(true); setErr(""); }} />
        <datalist id="drift-project-options">
          {visible.map((p) => <option key={p} value={p} />)}
        </datalist>
        <p style={{ margin: "6px 0 0", fontSize: 11, color: unknown ? "#e0a44c" : "var(--muted)" }}>
          {unknown
            ? `No notes are stored under "${project.trim()}" — pick an existing project from the list, or the audit will have nothing to read.`
            : "Follows the folder name (how every note gets filed). Edit it if these notes live under a different name."}
        </p>
      </section>

      <section style={{ marginBottom: 14 }}>
        <p style={h}>CLI client</p>
        <input list="drift-agent-cmds" style={field} value={cmd} placeholder={DEFAULT_AGENT_CMD}
          onChange={(e) => { setCmd(e.target.value); setErr(""); }} />
        <datalist id="drift-agent-cmds">
          {cliProfiles.map((p) => <option key={p.id} value={cliProfileCommand(p)} label={p.name} />)}
          {KNOWN_AGENT_CMDS.map((c) => <option key={c} value={c} />)}
        </datalist>
      </section>

      <section style={{ marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} style={{ margin: 0 }} />
          <span>Bypass permission prompts
            <span style={{ display: "block", fontSize: 10.5, color: "var(--muted)" }}>adds this CLI's skip flag so the audit reads files and runs curl without stopping</span>
          </span>
        </label>
      </section>

      {preview && (
        <section style={{ marginBottom: 14 }}>
          <p style={h}>Command</p>
          <pre style={{ margin: 0, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 5, padding: "9px 10px", fontSize: 10.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--muted)" }}>{preview}</pre>
        </section>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={launch} style={btn("var(--accent)")}>Run drift audit</button>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#e06c75", fontSize: 11 }}>{err}</span>
      </div>
    </div>
  );
}
