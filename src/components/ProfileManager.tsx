import { useEffect, useState, type CSSProperties } from "react";
import { useLayout } from "../stores/layout";
import { cliProfileCommand } from "../lib/cliProfiles";
import type { PaneProfile } from "../lib/profiles";

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 110 };
const label: CSSProperties = { fontSize: 11, color: "var(--muted)", marginBottom: 3, display: "block" };
const field: CSSProperties = { width: "100%", boxSizing: "border-box", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "5px 7px", fontSize: 12.5, marginBottom: 10 };

// Known agent-config files the BigBrain block can be written into. Any other
// path can be added by hand (Cursor .mdc rules, .clinerules, etc.).
const BB_PRESETS: { path: string; hint: string }[] = [
  { path: "AGENTS.md", hint: "Codex, Cursor, Amp, Jules, …" },
  { path: "CLAUDE.md", hint: "Claude Code" },
  { path: ".github/copilot-instructions.md", hint: "GitHub Copilot" },
  { path: "GEMINI.md", hint: "Gemini CLI" },
];

const envToText = (env?: Record<string, string>) => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
const textToEnv = (t: string): Record<string, string> =>
  Object.fromEntries(
    t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1)];
    }),
  );

export default function ProfileManager() {
  const open = useLayout((s) => s.profileManagerOpen);
  const profiles = useLayout((s) => s.profiles);
  const defaultProfileId = useLayout((s) => s.defaultProfileId);
  const shells = useLayout((s) => s.detectedShells);
  const addProfile = useLayout((s) => s.addProfile);
  const updateProfile = useLayout((s) => s.updateProfile);
  const deleteProfile = useLayout((s) => s.deleteProfile);
  const setDefaultProfile = useLayout((s) => s.setDefaultProfile);
  const reorderProfile = useLayout((s) => s.reorderProfile);
  const cliProfiles = useLayout((s) => s.cliProfiles);
  const closeMgr = useLayout((s) => s.openProfileManager);

  const [selId, setSelId] = useState<string | null>(null);
  const [customTarget, setCustomTarget] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  useEffect(() => {
    if (open) setSelId((cur) => (cur && profiles.some((p) => p.id === cur) ? cur : defaultProfileId || profiles[0]?.id || null));
  }, [open, profiles, defaultProfileId]);

  if (!open) return null;
  const sel = profiles.find((p) => p.id === selId) ?? null;
  const up = (patch: Partial<PaneProfile>) => sel && updateProfile(sel.id, patch);

  const bbTargets = sel?.bigBrainTargets ?? [];
  const setTargets = (t: string[]) => up({ bigBrainTargets: t.length ? t : undefined });
  const toggleTarget = (p: string, on: boolean) =>
    setTargets(on ? [...bbTargets, p].filter((x, i, a) => a.indexOf(x) === i) : bbTargets.filter((x) => x !== p));
  const addCustom = () => { const v = customTarget.trim(); if (v) { toggleTarget(v, true); setCustomTarget(""); } };

  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) closeMgr(false); }}>
      <div style={{ width: 640, maxWidth: "92vw", height: 460, maxHeight: "88vh", display: "flex", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        {/* list */}
        <div style={{ width: 190, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--panel)" }}>
          <div style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>PROFILES</div>
          <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
            {profiles.map((p) => (
              <div key={p.id} onClick={() => setSelId(p.id)}
                draggable
                onDragStart={(e) => {
                  setDragId(p.id);
                  // WebKitGTK aborts a drag whose dataTransfer is empty, so the
                  // dragover/drop handlers below never fire without this.
                  e.dataTransfer.setData("text/plain", p.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => { if (dragId && dragId !== p.id) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropId !== p.id) setDropId(p.id); } }}
                onDragLeave={() => setDropId((cur) => (cur === p.id ? null : cur))}
                onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== p.id) reorderProfile(dragId, p.id); setDragId(null); setDropId(null); }}
                onDragEnd={() => { setDragId(null); setDropId(null); }}
                title="Drag to reorder"
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", borderRadius: 5, cursor: dragId ? "grabbing" : "pointer", background: p.id === selId ? "#2b3a55" : "transparent", fontSize: 12.5, color: p.id === selId ? "#fff" : "var(--text)", opacity: p.id === dragId ? 0.4 : 1, borderTop: p.id === dropId ? "2px solid var(--accent)" : "2px solid transparent" }}>
                <span style={{ color: "var(--muted)", fontSize: 11, flex: "0 0 auto", cursor: "grab" }}>⠿</span>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color ?? "#666", flex: "0 0 auto" }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                {p.id === defaultProfileId && <span title="Default" style={{ fontSize: 10, color: "#7a9" }}>★</span>}
              </div>
            ))}
          </div>
          <button onClick={() => setSelId(addProfile())} style={{ margin: 8, padding: "6px", background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>＋ Add profile</button>
        </div>

        {/* editor */}
        <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
          {!sel ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No profile selected. Add one to get started.</div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Edit profile</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setDefaultProfile(sel.id)} disabled={sel.id === defaultProfileId}
                    style={{ fontSize: 11, padding: "4px 8px", background: sel.id === defaultProfileId ? "var(--border)" : "#3a6ea5", color: "#fff", border: "none", borderRadius: 4, cursor: sel.id === defaultProfileId ? "default" : "pointer" }}>
                    {sel.id === defaultProfileId ? "★ Default" : "Set default"}
                  </button>
                  <button onClick={() => { deleteProfile(sel.id); setSelId(null); }}
                    style={{ fontSize: 11, padding: "4px 8px", background: "#5a2a2a", color: "#eaa", border: "none", borderRadius: 4, cursor: "pointer" }}>Delete</button>
                </div>
              </div>

              <label style={label}>Name</label>
              <input style={field} value={sel.name} onChange={(e) => up({ name: e.target.value })} />

              <label style={label}>Shell</label>
              <select style={field}
                value={sel.shellPath ?? ""}
                onChange={(e) => {
                  const found = shells.find((sh) => sh.path === e.target.value);
                  up({ shellPath: e.target.value || undefined, args: found?.args });
                }}>
                <option value="">Default shell</option>
                {shells.map((sh) => <option key={sh.id} value={sh.path}>{sh.label}</option>)}
                {sel.shellPath && !shells.some((sh) => sh.path === sel.shellPath) && <option value={sel.shellPath}>{sel.shellPath} (custom)</option>}
              </select>

              <label style={label}>Working directory (cwd)</label>
              <input style={field} placeholder="(inherit)" value={sel.cwd ?? ""} onChange={(e) => up({ cwd: e.target.value || undefined })} />

              <label style={label}>Startup command</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input style={field} placeholder="e.g. claude" value={sel.startupCommand ?? ""} onChange={(e) => up({ startupCommand: e.target.value || undefined })} />
                {cliProfiles.length > 0 && (
                  <select
                    title="Insert a CLI profile's command line (Settings → CLI profiles)"
                    style={{ ...field, width: 130, flex: "0 0 auto" }}
                    value=""
                    onChange={(e) => {
                      const p = cliProfiles.find((x) => x.id === e.target.value);
                      if (p) up({ startupCommand: cliProfileCommand(p) });
                    }}>
                    <option value="">Insert CLI profile…</option>
                    {cliProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </div>

              <label style={label}>Environment (KEY=VALUE per line)</label>
              <textarea style={{ ...field, height: 60, fontFamily: "monospace", resize: "vertical" }} value={envToText(sel.env)} onChange={(e) => up({ env: textToEnv(e.target.value) })} />

              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "0 0 8px", cursor: "pointer", fontSize: 12.5, color: "var(--text)" }}>
                <input type="checkbox" style={{ marginTop: 2 }} checked={bbTargets.length > 0}
                  onChange={(e) => setTargets(e.target.checked ? ["AGENTS.md", "CLAUDE.md"] : [])} />
                <span>🧠 Force BigBrain
                  <span style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>
                    On launch, writes the BigBrain contract into the files below (<code>BIGBRAIN_URL</code> is set for every pane either way). Tick the ones your agents actually read.
                  </span>
                </span>
              </label>
              {bbTargets.length > 0 && (
                <div style={{ margin: "0 0 12px 26px", display: "flex", flexDirection: "column", gap: 5 }}>
                  {BB_PRESETS.map((t) => (
                    <label key={t.path} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text)", cursor: "pointer" }}>
                      <input type="checkbox" checked={bbTargets.includes(t.path)} onChange={(e) => toggleTarget(t.path, e.target.checked)} />
                      <code style={{ fontSize: 11 }}>{t.path}</code>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>{t.hint}</span>
                    </label>
                  ))}
                  {bbTargets.filter((p) => !BB_PRESETS.some((t) => t.path === p)).map((p) => (
                    <label key={p} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text)", cursor: "pointer" }}>
                      <input type="checkbox" checked onChange={() => toggleTarget(p, false)} />
                      <code style={{ fontSize: 11 }}>{p}</code>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>custom</span>
                    </label>
                  ))}
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <input style={{ ...field, marginBottom: 0, flex: 1 }} placeholder="another path, e.g. .cursor/rules/bigbrain.mdc"
                      value={customTarget} onChange={(e) => setCustomTarget(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }} />
                    <button onClick={addCustom} style={{ fontSize: 12, padding: "0 10px", background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}>Add</button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>On restore</label>
                  <select style={field} value={sel.restartPolicy} onChange={(e) => up({ restartPolicy: e.target.value as PaneProfile["restartPolicy"] })}>
                    <option value="rerun">Rerun startup command</option>
                    <option value="never">Never (empty shell)</option>
                    <option value="prompt">Prompt</option>
                  </select>
                </div>
                <div style={{ width: 90 }}>
                  <label style={label}>Font size</label>
                  <input style={field} type="number" min={8} max={40} value={sel.fontSize ?? 14} onChange={(e) => up({ fontSize: Number(e.target.value) || undefined })} />
                </div>
                <div style={{ width: 60 }}>
                  <label style={label}>Color</label>
                  <input style={{ ...field, height: 28, padding: 2 }} type="color" value={sel.color ?? "#4c8bf5"} onChange={(e) => up({ color: e.target.value })} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
