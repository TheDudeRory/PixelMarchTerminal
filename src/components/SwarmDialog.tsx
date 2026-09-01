// Launch Swarm dialog (swarm M1 — see swarm.md). Collects the mission + team
// shape; the actual launch — mission/role-brief notes into a fresh BigBrain
// project, the grid workspace of agent panes — lives in lib/swarmLaunch.ts,
// shared with the headless CLI. The reconcile effect then spawns the panes.
// Shaped like SettingsModal: left category list + right editor pane, driven by
// the SWARM_CATEGORIES registry below — plus a footer, which Settings has no
// need for (launching is an action, changing a setting is not).
import { type ComponentType, useState } from "react";
import { useBackdropClose } from "../lib/useBackdropClose";
import { pickMarkdownFile, readText } from "../lib/ipc";
import { cliProfileCommand } from "../lib/cliProfiles";
import { launchSwarm, UntrackedFilesError, untrackedSignature } from "../lib/swarmLaunch";
import { DEFAULT_AGENT_CMD, DEFAULT_SWARM, KNOWN_AGENT_CMDS, MAX_REVIEWERS, ROLE_KINDS, canRunHeadless, cmdForRole, migrateAgentCmds, reviewerCount, type RoleBrief, type RoleKind, type SwarmConfig } from "../lib/swarm";
import { ACCENT_SELECTED, field, label, overlay, row } from "../lib/uiStyles";
import { useLayout } from "../stores/layout";

// Re-exported from the shared launch module for its existing importers (the
// tests read them off this module) and kept exported so the headless path can
// reach the two PixelMarch-owned config paths through one door.
export { hookSettingsPath, mcpConfigPath, untrackedWarning } from "../lib/swarmLaunch";

// Every category edits the same draft config, so unlike SettingsModal (whose
// categories each pull their own slice of the store) they take it as props.
interface CategoryProps {
  cfg: SwarmConfig;
  patch: (p: Partial<SwarmConfig>) => void;
  // Categories surface their own failures (a brief that will not read) through
  // the same footer line launch() uses, so there is one error slot in the dialog.
  setErr: (m: string) => void;
}

export interface SwarmCategory {
  id: string;
  label: string;
  Component: ComponentType<CategoryProps>;
}

export const SWARM_CATEGORIES: SwarmCategory[] = [
  { id: "mission", label: "Mission", Component: MissionCategory },
  { id: "team", label: "Team", Component: TeamCategory },
  { id: "commands", label: "Agent commands", Component: CommandsCategory },
  { id: "onComplete", label: "On mission complete", Component: OnCompleteCategory },
];

export function swarmTeamSize(cfg: SwarmConfig) {
  // reviewerCount() and not cfg.reviewers, so a config still carrying the legacy
  // `reviewer` boolean (a saved draft, an older build) sizes the team the same
  // way swarmPanes() does — the dialog must never promise a pane count the
  // launch does not produce.
  return 1 + Math.max(1, cfg.builders) + (cfg.scout ? 1 : 0) + reviewerCount(cfg);
}

/** Role keys offered a custom .md brief, in the order the Agent commands rows
 *  render them. Tracks the config exactly (scout on/off, builder count,
 *  reviewerCount) so a role can never be given a brief no pane will read —
 *  these are the same names swarmRoles() mints. */
export function briefRoles(cfg: SwarmConfig): string[] {
  const roles = ["coordinator"];
  if (cfg.scout) roles.push("scout");
  for (let i = 1; i <= Math.max(1, cfg.builders); i++) roles.push(`builder-${i}`);
  for (let i = 1; i <= reviewerCount(cfg); i++) roles.push(`reviewer-${i}`);
  return roles;
}

/** How many of this config's agents would ACTUALLY run headless if the switch
 *  were on. Same resolution swarmPanes() uses (migrated commands, per-role
 *  lookup, capability check), so the number the dialog shows is the number of
 *  piped panes the launch produces — and 0 means the switch is not offered at
 *  all rather than offered and ignored. */
export function headlessRoleCount(cfg: SwarmConfig): number {
  const cmds = migrateAgentCmds(cfg.agentCmds, cfg.builders, reviewerCount(cfg));
  return briefRoles(cfg).filter((r) => canRunHeadless(cmdForRole(cmds, r))).length;
}

/** Immutable edit of the role-brief map. `brief: null` deletes the entry rather
 *  than storing a blank one, so "cleared" and "never picked" are the same state
 *  and both fall back to the generated brief. */
export function withRoleBrief(
  briefs: Record<string, RoleBrief> | undefined,
  role: string,
  brief: RoleBrief | null,
): Record<string, RoleBrief> {
  const next = { ...(briefs ?? {}) };
  if (brief) next[role] = brief;
  else delete next[role];
  return next;
}

/** Filename of a picked brief, for the read-only path display (the full path
 *  goes in the tooltip — the row is far too narrow for it). Handles both
 *  separators: the picker returns Windows paths on Windows. */
export function briefFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Mount gate. The draft config, the selected category, the error line and the
 *  untracked acknowledgement all live in SwarmDialogBody, so closing the dialog
 *  UNMOUNTS them and the next "Launch swarm" opens on DEFAULT_SWARM — a cancel
 *  clears the form the same way a launch does. Gating with an early `return null`
 *  inside the body instead would keep the hooks (and the half-typed mission of
 *  whatever was cancelled) alive for the life of the app. */
export default function SwarmDialog() {
  const open = useLayout((s) => s.swarmOpen);
  if (!open) return null;
  return <SwarmDialogBody />;
}

function SwarmDialogBody() {
  const close = useLayout((s) => s.openSwarm);
  const [cfg, setCfg] = useState<SwarmConfig>(DEFAULT_SWARM);
  const [catId, setCatId] = useState<string>(SWARM_CATEGORIES[0].id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The untracked-file set the human has already been shown and chosen to launch
  // over. Keyed by the files themselves, not a boolean: commit half of them and
  // press Launch again and the warning comes back for what is still untracked,
  // which is the case a one-shot "already warned" flag gets wrong.
  const [untrackedAck, setUntrackedAck] = useState("");
  const backdrop = useBackdropClose(() => close(false));

  const patch = (p: Partial<SwarmConfig>) => {
    // A new working directory is a new repo with its own untracked files, so the
    // acknowledgement (and the "Launch anyway" button it turns on) does not
    // travel with it.
    if (p.cwd !== undefined && p.cwd.trim() !== cfg.cwd.trim()) setUntrackedAck("");
    setCfg((c) => ({ ...c, ...p }));
  };
  const teamSize = swarmTeamSize(cfg);
  const cat = SWARM_CATEGORIES.find((c) => c.id === catId) ?? SWARM_CATEGORIES[0];
  const Body = cat.Component;

  // The shared launch (lib/swarmLaunch.ts — same path the headless CLI will
  // call) does the work: repo prep, the brain notes, the workspace. What stays
  // here is UI: the validation jump, the untracked acknowledge (launchSwarm
  // throws UntrackedFilesError, which this records — "Launch anyway" re-presses
  // with the ack), and closing the dialog on success. No state reset here:
  // closing unmounts the body (see SwarmDialog).
  async function launch() {
    if (!cfg.mission.trim() || !cfg.cwd.trim()) {
      setErr("Mission and working directory are required.");
      setCatId("mission");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await launchSwarm(cfg, { ackUntracked: untrackedAck });
      close(false);
    } catch (e) {
      if (e instanceof UntrackedFilesError) {
        setUntrackedAck(untrackedSignature(e.files));
        setErr(e.message);
      } else {
        setErr(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} {...backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: "92vw", height: 460, maxHeight: "88vh", display: "flex", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        {/* category list */}
        <div style={{ width: 190, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--panel)" }}>
          <div style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>LAUNCH SWARM</div>
          <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
            {SWARM_CATEGORIES.map((c) => (
              <div key={c.id} onClick={() => setCatId(c.id)}
                style={{ padding: "6px 8px", borderRadius: 5, cursor: "pointer", background: c.id === catId ? ACCENT_SELECTED : "transparent", fontSize: 12.5, color: c.id === catId ? "#fff" : "var(--text)" }}>
                {c.label}
              </div>
            ))}
          </div>
          <div style={{ padding: "8px 10px", fontSize: 10.5, color: "var(--muted)", borderTop: "1px solid var(--border)" }}>
            Coordinator plans, builders implement, scout maps, reviewer gates — they coordinate through BigBrain.
          </div>
        </div>

        {/* editor + footer */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
            <Body cfg={cfg} patch={patch} setErr={setErr} />
          </div>
          <div style={{ borderTop: "1px solid var(--border)", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            {err && <span style={{ color: "#e06c6c", fontSize: 11.5, marginRight: "auto" }}>{err}</span>}
            <button onClick={() => close(false)} style={{ ...field, cursor: "pointer" }}>Cancel</button>
            <button onClick={launch} disabled={busy} style={{ ...field, cursor: busy ? "wait" : "pointer", background: ACCENT_SELECTED, color: "#fff" }}>
              {busy ? "Launching…" : untrackedAck ? "Launch anyway" : `Launch ${teamSize} agents`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Mission ───────────────────────────────────────────────────────────────────

function MissionCategory({ cfg, patch }: CategoryProps) {
  const profiles = useLayout((s) => s.profiles);
  const [dropHot, setDropHot] = useState(false);
  const knownCwds = [...new Set(profiles.map((p) => p.cwd?.trim()).filter((c): c is string => !!c))];
  const headlessRoles = headlessRoleCount(cfg);
  const teamSize = swarmTeamSize(cfg);

  return (
    <>
      <div style={{ padding: "0 0 7px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ ...label, marginBottom: 4 }}>
          Mission <span style={{ fontSize: 10 }}>(drop a screenshot thumbnail here to reference it)</span>
        </div>
        <textarea
          autoFocus
          rows={8}
          placeholder="What should the swarm build / fix / investigate?"
          value={cfg.mission}
          onChange={(e) => patch({ mission: e.target.value })}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("text/plain")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropHot(true);
          }}
          onDragLeave={() => setDropHot(false)}
          onDrop={(e) => {
            // Explicit handling: WebView2's native text-drop into a controlled
            // textarea is unreliable, and an appended labelled line reads
            // better in the mission note than text spliced at the drop caret.
            e.preventDefault();
            setDropHot(false);
            const text = e.dataTransfer.getData("text/plain").trim();
            if (!text) return;
            const line = /\.(png|jpe?g|gif|webp|bmp)$/i.test(text) ? `[screenshot] ${text}` : text;
            patch({ mission: cfg.mission.trim() ? `${cfg.mission.replace(/\s+$/, "")}\n${line}` : line });
          }}
          style={{ ...field, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", ...(dropHot ? { borderColor: "#5aa2ff", background: "rgba(90,162,255,0.10)" } : {}) }}
        />
      </div>
      <div style={row}>
        <span style={label}>Working directory (repo root)</span>
        <input list="swarm-cwd-options" style={{ ...field, width: 240 }} placeholder="C:\path\to\repo" value={cfg.cwd} onChange={(e) => patch({ cwd: e.target.value })} />
        <datalist id="swarm-cwd-options">
          {knownCwds.map((c) => <option key={c} value={c} />)}
        </datalist>
      </div>
      {/* Behaviour toggles live here rather than behind their own category: they
          decide how the swarm runs and are worth seeing the moment you write the
          mission, not after hunting through a side menu. */}
      <div style={row}>
        <span style={label}>
          Bypass permission prompts
          <span style={{ display: "block", fontSize: 10.5 }}>adds each CLI's skip flag (claude --dangerously-skip-permissions, gemini --yolo, …) to every pane</span>
        </span>
        <input type="checkbox" checked={cfg.skipPermissions} onChange={(e) => patch({ skipPermissions: e.target.checked })} />
      </div>
      <div style={row}>
        <span style={label}>
          Host dispatch (poll-free workers)
          <span style={{ display: "block", fontSize: 10.5 }}>agents sleep between tasks instead of polling; PixelMarch watches the task bus and wakes the right pane — saves tokens</span>
        </span>
        <input type="checkbox" checked={cfg.hostDispatch} onChange={(e) => patch({ hostDispatch: e.target.checked })} />
      </div>
      <div style={row}>
        <span style={label}>
          Start workers on demand
          <span style={{ display: "block", fontSize: 10.5 }}>
            only the coordinator launches its CLI at start; each other role's pane waits as a plain
            shell until it has work{cfg.hostDispatch ? "" : " — needs host dispatch"}
          </span>
        </span>
        <input
          type="checkbox"
          checked={cfg.lazyWorkers && cfg.hostDispatch}
          disabled={!cfg.hostDispatch}
          onChange={(e) => patch({ lazyWorkers: e.target.checked })}
        />
      </div>
      <div style={row}>
        <span style={label}>
          Context resets between cycles
          <span style={{ display: "block", fontSize: 10.5 }}>
            pick which agents wipe their context (/clear, /new) at each cycle end and re-brief from
            BigBrain — leave all off to disable. Clear just the workers to keep the coordinator's plan.
          </span>
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", justifyContent: "flex-end", maxWidth: 200 }}>
          {ROLE_KINDS.filter((k) => k !== "scout" || cfg.scout).filter((k) => k !== "reviewer" || reviewerCount(cfg) > 0).map((kind) => {
            const on = (cfg.clearRoles ?? []).includes(kind);
            return (
              <label key={kind} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const set = new Set<RoleKind>(cfg.clearRoles ?? []);
                    if (e.target.checked) set.add(kind); else set.delete(kind);
                    // Keep the canonical ROLE_KINDS order, so the persisted list is stable.
                    patch({ clearRoles: ROLE_KINDS.filter((k) => set.has(k)) });
                  }}
                />
                {kind === "builder" ? "builders" : kind === "reviewer" ? "reviewers" : kind}
              </label>
            );
          })}
        </div>
      </div>
      {/* Phase C. Headless is the DEFAULT for capable CLIs (DEFAULT_SWARM), so
          this checkbox is the opt-OUT. It only appears once at least one
          configured CLI can actually be driven as a stream process — offering
          it for a CLI that would silently keep its terminal is the kind of dead
          switch this mission has already shipped twice. */}
      {headlessRoles > 0 && (
        <div style={row}>
          <span style={label}>
            Headless workers
            <span style={{ display: "block", fontSize: 10.5 }}>
              run {headlessRoles === teamSize ? "every agent" : `${headlessRoles} of ${teamSize} agents`} as a
              piped JSON process instead of a terminal: exact turn boundaries, no keystroke injection, no
              redraw races. Each pane shows a transcript (tool calls, tokens, errors) and can be taken over
              interactively at any time.
            </span>
          </span>
          <input type="checkbox" checked={!!cfg.headless} onChange={(e) => patch({ headless: e.target.checked })} />
        </div>
      )}
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={label}>
          Run concurrent
          <span style={{ display: "block", fontSize: 10.5 }}>let builders and reviewers run wild — lifts the one-turn-at-a-time cap so every role can think at once. Only safe when your endpoint can serve parallel completions.</span>
        </span>
        <input type="checkbox" checked={cfg.concurrent} onChange={(e) => patch({ concurrent: e.target.checked })} />
      </div>
    </>
  );
}

// ── Team ──────────────────────────────────────────────────────────────────────

function TeamCategory({ cfg, patch }: CategoryProps) {
  return (
    <>
      <div style={row}>
        <span style={label}>Scout (read-only codebase mapper)</span>
        <input type="checkbox" checked={cfg.scout} onChange={(e) => patch({ scout: e.target.checked })} />
      </div>
      <div style={row}>
        <span style={label}>Builders</span>
        <select style={field} value={cfg.builders} onChange={(e) => patch({ builders: Number(e.target.value) })}>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={label}>
          Reviewers (gate every task)
          <span style={{ display: "block", fontSize: 10.5 }}>
            {reviewerCount(cfg) === 0
              ? "none — the coordinator is the merge gate"
              : "done tasks fan out over the review panes; a task merges once approved"}
          </span>
        </span>
        <select
          style={field}
          value={reviewerCount(cfg)}
          // `reviewer: undefined` drops the legacy boolean the moment the count
          // is edited — left set, reviewerCount() would floor the choice at 1
          // and "0 reviewers" could never be selected.
          onChange={(e) => patch({ reviewers: Number(e.target.value), reviewer: undefined })}
        >
          {Array.from({ length: MAX_REVIEWERS + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </>
  );
}

// ── Agent commands ────────────────────────────────────────────────────────────

function CommandsCategory({ cfg, patch, setErr }: CategoryProps) {
  const cliProfiles = useLayout((s) => s.cliProfiles);
  const brief = (role: string) => <RoleBriefRow role={role} cfg={cfg} patch={patch} setErr={setErr} />;
  return (
    <>
      <div style={{ ...label, marginBottom: 8 }}>Agent command per role <span style={{ fontSize: 10 }}>(boot prompt is appended as one quoted arg)</span></div>
      <div style={{ display: "grid", gap: 10 }}>
        {(["coordinator", "scout"] as const).map((k) => {
          const off = k === "scout" && !cfg.scout;
          return (
            <div key={k} style={{ display: "grid", gap: 3 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...label, width: 78, flex: "0 0 auto" }}>{k}</span>
                <input
                  list="swarm-agent-cmds"
                  disabled={off}
                  style={{ ...field, flex: 1, minWidth: 0, opacity: off ? 0.4 : 1 }}
                  value={cfg.agentCmds[k]}
                  onChange={(e) => patch({ agentCmds: { ...cfg.agentCmds, [k]: e.target.value } })}
                />
              </label>
              {/* A role that will not spawn gets no brief picker — briefRoles()
                  is the same gate, so nothing can be attached to a dead role. */}
              {!off && brief(k)}
            </div>
          );
        })}
        {Array.from({ length: Math.max(1, cfg.builders) }, (_, i) => {
          const builders = cfg.agentCmds.builders ?? [];
          const fallback = builders[0] || DEFAULT_AGENT_CMD;
          return (
            <div key={`builder-${i}`} style={{ display: "grid", gap: 3 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...label, width: 78, flex: "0 0 auto" }}>builder-{i + 1}</span>
                <input
                  list="swarm-agent-cmds"
                  placeholder={i === 0 ? "claude" : fallback}
                  style={{ ...field, flex: 1, minWidth: 0 }}
                  value={builders[i] ?? ""}
                  onChange={(e) => {
                    const next = [...builders];
                    while (next.length <= i) next.push("");
                    next[i] = e.target.value;
                    patch({ agentCmds: { ...cfg.agentCmds, builders: next } });
                  }}
                />
              </label>
              {brief(`builder-${i + 1}`)}
            </div>
          );
        })}
        {Array.from({ length: reviewerCount(cfg) }, (_, i) => {
          // Mirrors the builders[] editor: entry i is reviewer-(i+1), blank
          // inherits reviewers[0] (and reviewers[0] blank inherits the legacy
          // single `reviewer` command) — see migrateAgentCmds()/cmdForRole().
          const reviewers = cfg.agentCmds.reviewers ?? [];
          const fallback = reviewers[0] || cfg.agentCmds.reviewer || DEFAULT_AGENT_CMD;
          return (
            <div key={`reviewer-${i}`} style={{ display: "grid", gap: 3 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...label, width: 78, flex: "0 0 auto" }}>reviewer-{i + 1}</span>
                <input
                  list="swarm-agent-cmds"
                  placeholder={i === 0 ? DEFAULT_AGENT_CMD : fallback}
                  style={{ ...field, flex: 1, minWidth: 0 }}
                  value={reviewers[i] ?? ""}
                  onChange={(e) => {
                    const next = [...reviewers];
                    while (next.length <= i) next.push("");
                    next[i] = e.target.value;
                    patch({ agentCmds: { ...cfg.agentCmds, reviewers: next } });
                  }}
                />
              </label>
              {brief(`reviewer-${i + 1}`)}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--muted)" }}>
        Blank brief = the generated role brief. A picked .md replaces that role's body; the
        coordination protocol (task bus, claims, merge gate) is always appended to it.
      </div>
      <datalist id="swarm-agent-cmds">
        {cliProfiles.map((p) => <option key={p.id} value={cliProfileCommand(p)} label={p.name} />)}
        {KNOWN_AGENT_CMDS.map((c) => <option key={c} value={c} />)}
      </datalist>
    </>
  );
}

/** The ".md brief" control under one role's command input: a read-only display
 *  of what is picked, a Browse button (native picker → read the file now, so a
 *  later edit cannot silently change an already-launched swarm) and a Clear
 *  that falls back to the generated brief. */
function RoleBriefRow({ role, cfg, patch, setErr }: CategoryProps & { role: string }) {
  const [busy, setBusy] = useState(false);
  const brief = cfg.roleBriefs?.[role];

  async function browse() {
    setBusy(true);
    try {
      const path = await pickMarkdownFile(`Brief for ${role}`);
      if (!path) return; // cancelled — keep whatever was already picked
      const body = await readText(path);
      patch({ roleBriefs: withRoleBrief(cfg.roleBriefs, role, { path, body }) });
      setErr("");
    } catch (e) {
      // Same footer slot launch() writes to — one error line for the dialog.
      setErr(`Could not read a brief for ${role}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ ...label, width: 78, flex: "0 0 auto", fontSize: 10.5 }}>brief .md</span>
      <input
        readOnly
        title={brief?.path ?? ""}
        placeholder="generated brief"
        value={brief ? briefFileName(brief.path) : ""}
        style={{ ...field, flex: 1, minWidth: 0, fontSize: 11, color: brief ? "var(--text)" : "var(--muted)" }}
      />
      <button onClick={browse} disabled={busy} style={{ ...field, flex: "0 0 auto", fontSize: 11, cursor: busy ? "wait" : "pointer" }}>
        {busy ? "…" : "Browse"}
      </button>
      {brief && (
        <button
          onClick={() => patch({ roleBriefs: withRoleBrief(cfg.roleBriefs, role, null) })}
          title="Fall back to the generated brief"
          style={{ ...field, flex: "0 0 auto", fontSize: 11, cursor: "pointer" }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ── On mission complete ──────────────────────────────────────────────────────

/** One command per line, run once when the swarm's mission is 100% complete
 *  (every task done) — the "what to do after" the swarm built the thing.
 *  Blank = nothing runs, which stays the default so existing habits are
 *  untouched. Same draft-edit pattern as every other category: patch the
 *  shared config, launch() ships whatever is in the box. */
function OnCompleteCategory({ cfg, patch }: CategoryProps) {
  return (
    <>
      <div style={{ ...label, marginBottom: 8 }}>Commands to run once, when the swarm is 100% complete <span style={{ fontSize: 10 }}>(after the last task is done)</span></div>
      <textarea
        rows={8}
        placeholder={"One shell command per line, e.g.\nnpm test"}
        value={cfg.onComplete ?? ""}
        onChange={(e) => patch({ onComplete: e.target.value })}
        style={{ ...field, width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit" }}
      />
      <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--muted)" }}>
        One shell command per line, run in order when every task of this swarm is complete.
        Leave blank to run nothing.
      </div>
    </>
  );
}
