import { beforeEach, describe, expect, it } from "vitest";
import { collectPanes, newPane } from "./layout-tree";
import { AGENT_CAPS, MCP_SERVER, agentCaps, hasMcp, mcpConfigFlag, speaksMcp, DEFAULT_AGENT_CMD, DEFAULT_SWARM, composeBrief, protocolNotes, MAX_REVIEWERS, isReviewerRole, migrateSwarmConfig, RESET_COMMANDS, STARVED_AFTER_MS, TURN_HOLD_MS, WAKE_MESSAGES, clearRolesOf, clearsRole, cmdForRole, gridRoot, interruptKey, isInjectable, isRolePane, liveTurns, migrateAgentCmds, nudgeText, onTurnBudget, parentProject, bootPrompt, forceTurnSlot, registerSwarm, roleKind, trackedSwarms, releaseTurnSlot, reportBusy, resetCommand, retainSwarms, setTurnBudget, setTurnCapOverride, skipPermissionFlag, swarmPanes, swarmLiveInRepo, swarmProject, swarmRoles, swarmsInRepo, takeTurnSlot, turnBudget, turnCap, type RoleKind } from "./swarm";

// hostDispatch and headless are now ON by default; pin both off here so the
// long-poll (/wait) and PTY/TUI boot paths these tests exercise stay covered.
const cfg = { ...DEFAULT_SWARM, mission: "Fix the auth flow in the API server", cwd: "C:/repo", builders: 2, hostDispatch: false, headless: false };
const URL = "http://127.0.0.1:8734";

describe("swarm", () => {
  it("swarmProject slugs the mission, parent repo first", () => {
    expect(swarmProject(cfg.mission, cfg.cwd)).toMatch(/^repo-swarm-fix-the-auth-flow-[a-z0-9]{4}$/);
    expect(swarmProject(cfg.mission)).toMatch(/^swarm-fix-the-auth-flow-[a-z0-9]{4}$/); // no cwd: no prefix
  });

  it("roles match config shape", () => {
    const names = swarmRoles("swarm-x", URL, cfg).map((r) => r.name);
    expect(names).toEqual(["coordinator", "builder-1", "builder-2", "scout", "reviewer-1"]);
    const solo = swarmRoles("swarm-x", URL, { ...cfg, builders: 1, scout: false, reviewers: 0, reviewer: false });
    expect(solo.map((r) => r.name)).toEqual(["coordinator", "builder-1"]);
  });

  it("reviewers are numbered like builders and scale to N", () => {
    const names = (n: number) => swarmRoles("swarm-x", URL, { ...cfg, reviewers: n, reviewer: undefined }).map((r) => r.name);
    expect(names(3)).toEqual(["coordinator", "builder-1", "builder-2", "scout", "reviewer-1", "reviewer-2", "reviewer-3"]);
    expect(names(0)).toEqual(["coordinator", "builder-1", "builder-2", "scout"]);
    expect(names(9).filter((n) => n.startsWith("reviewer")).length).toBe(MAX_REVIEWERS); // clamped
    // each reviewer's brief is addressed to it alone and keeps its own status note
    const three = swarmRoles("swarm-x", URL, { ...cfg, reviewers: 3, reviewer: undefined });
    for (const i of [1, 2, 3]) {
      const brief = three.find((r) => r.name === `reviewer-${i}`)!.brief;
      expect(brief).toContain(`You are REVIEWER-${i}`);
      expect(brief).toContain(`"status-reviewer-${i}"`);
      expect(brief).toContain("one of 3 reviewers"); // don't re-verdict another reviewer's task
    }
    // a single reviewer gets no fan-out warning to reason about
    expect(swarmRoles("swarm-x", URL, cfg).find((r) => r.name === "reviewer-1")!.brief).not.toContain("one of");
    // the coordinator's merge gate follows the count
    const coordinator = (c: Partial<typeof cfg>) => swarmRoles("swarm-x", URL, { ...cfg, ...c })[0].brief;
    expect(coordinator({ reviewers: 3, reviewer: undefined })).toContain("3 reviewer(s)");
    expect(coordinator({ reviewers: 0, reviewer: undefined })).not.toContain("reviewer(s)");
  });

  it("migrates the legacy reviewer:boolean config", () => {
    // old saved config: reviewer:true was the whole setting
    expect(migrateSwarmConfig({ reviewer: true }).reviewers).toBe(1);
    expect(migrateSwarmConfig({ reviewer: false }).reviewers).toBe(0);
    expect("reviewer" in migrateSwarmConfig({ reviewer: true })).toBe(false); // legacy field dropped
    // new config: the number is authoritative
    expect(migrateSwarmConfig({ reviewers: 3 }).reviewers).toBe(3);
    expect(migrateSwarmConfig({ reviewers: 99 }).reviewers).toBe(MAX_REVIEWERS);
    expect(migrateSwarmConfig({ reviewers: -1 }).reviewers).toBe(0);
    expect(migrateSwarmConfig({}).reviewers).toBe(1); // neither field: one reviewer, as before
    // both present (a UI still writing the flag): the flag decides on/off, the number the size
    expect(migrateSwarmConfig({ reviewers: 3, reviewer: false }).reviewers).toBe(0);
    expect(migrateSwarmConfig({ reviewers: 3, reviewer: true }).reviewers).toBe(3);
    expect(migrateSwarmConfig({ reviewers: 0, reviewer: true }).reviewers).toBe(1);
    // panes follow the migrated count
    expect(swarmPanes("swarm-x", URL, migrateSwarmConfig({ ...cfg, reviewer: false })).some((p) => p.role?.startsWith("reviewer"))).toBe(false);
  });

  it("each reviewer can run its own agent", () => {
    const cmds = { coordinator: "claude", scout: "claude", reviewer: "codex", reviewers: ["gemini", ""] };
    expect(cmdForRole(cmds, "reviewer-1")).toBe("gemini");
    expect(cmdForRole(cmds, "reviewer-2")).toBe("codex"); // empty entry, unmigrated: legacy single client
    expect(cmdForRole(cmds, "reviewer")).toBe("gemini"); // pre-multi-reviewer pane role
    // the migration densifies reviewers[] exactly like builders[], seeded from the legacy field
    expect(migrateAgentCmds(cmds, 1, 3).reviewers).toEqual(["gemini", "gemini", "gemini"]); // empty entry inherits reviewers[0]
    expect(migrateAgentCmds({ coordinator: "c", scout: "c", reviewer: "codex" }, 1, 2).reviewers).toEqual(["codex", "codex"]);
    expect(migrateAgentCmds({ coordinator: "c", scout: "c", reviewer: "" }, 1, 1).reviewers).toEqual([DEFAULT_AGENT_CMD]);
    expect(migrateAgentCmds({ coordinator: "c", scout: "c", reviewer: "codex" }, 1, 0).reviewers).toEqual([]); // reviewers off
    const perReviewer = { ...cmds, builders: ["claude"], reviewers: ["gemini", "codex"] };
    const panes = swarmPanes("swarm-x", URL, { ...cfg, reviewers: 2, reviewer: undefined, agentCmds: perReviewer, skipPermissions: false });
    expect(panes.find((p) => p.role === "reviewer-1")!.startupCommand).toMatch(/^gemini -i '/);
    expect(panes.find((p) => p.role === "reviewer-2")!.startupCommand).toMatch(/^codex '/);
  });

  it("the grid keeps every pane with N reviewers", () => {
    const panes = swarmPanes("swarm-x", URL, { ...cfg, builders: 4, reviewers: 4, reviewer: undefined });
    expect(panes.length).toBe(10); // coordinator + 4 builders + scout + 4 reviewers
    expect(collectPanes(gridRoot(panes)).map((p) => p.id).sort()).toEqual(panes.map((p) => p.id).sort());
  });

  it("briefs carry the brain project + the protocol-core pointer; the contract lives in the note", () => {
    for (const r of swarmRoles("swarm-x", URL, cfg)) {
      expect(r.brief).toContain(`${URL}/memory/swarm-x/`);
      expect(r.brief).toContain("READ NOTE protocol-core");
      expect(r.brief).toContain('"status-<your role>"');
      // the moved sections are NOT re-stated in any brief — that was the whole point
      expect(r.brief).not.toContain("TASK BUS");
      expect(r.brief).not.toContain("Lifecycle:");
      expect(r.brief).not.toContain("STRUCTURED QUESTIONS");
    }
    // builders share one template: the briefs differ only by the interpolated role string
    const byName = Object.fromEntries(swarmRoles("swarm-x", URL, cfg).map((r) => [r.name, r.brief]));
    expect(byName["builder-1"].replace(/builder-1/gi, (m) => (m === "BUILDER-1" ? "BUILDER-2" : "builder-2"))).toBe(byName["builder-2"]);
    // the shared contract is stored ONCE, per wire flavor, with the claim gate and chat routing
    const notes = protocolNotes("swarm-x", URL, "repo", false, false);
    const core = notes.find((n) => n.key === "protocol-core")!.body;
    const coreMcp = notes.find((n) => n.key === "protocol-core-mcp")!.body;
    for (const body of [core, coreMcp]) {
      expect(body).toContain("Claim");
      expect(body).toContain("collision guard");
      expect(body).toContain("no plan yet");
      expect(body).toContain("Lifecycle: open → claimed → done → approved|changes → merged");
      expect(body).toContain("protocol-chat");
      expect(body).toContain("NEVER touch files owned by another role's claimed task");
    }
    expect(core).toContain(`${URL}/claim`);
    expect(core).toContain("chat-human-<n>");
    expect(coreMcp).toContain("task_claim");
    expect(coreMcp).toContain("chat_send");
    expect(coreMcp).not.toContain("curl"); // MCP flavor never shells out
  });

  // The audit's largest single token saving: 37 of one run's 57 chat notes were
  // coordinator-authored wakes for transitions swarmDispatch already watches, and
  // decision essays posted as chat AND as a note. Every brief now forbids both.
  // the rules are wrapped prose, so assert against a whitespace-flattened,
  // case-folded copy — a re-wrap must not fail a test about what the brief SAYS.
  const flat = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  it("every brief forbids chatting a transition the bus already wakes", () => {
    for (const dispatch of [false, true]) {
      const roles = swarmRoles("swarm-x", URL, { ...cfg, hostDispatch: dispatch });
      for (const r of roles) {
        const b = flat(r.brief);
        expect(b, r.name).toContain("chat is expensive");
        expect(b, r.name).toContain("never chat to prompt an action the bus already triggers");
        // the exact set swarmDispatch types a [host] wake for (plus the host's merge message)
        expect(b, r.name).toContain("open/done/changes/approved/merged");
        // the wake source has to match the wire: host dispatch vs the role's own long poll
        expect(b, r.name).toContain(dispatch ? "the host watches the bus" : "each role's own /wait returns on it");
        // and it stays cheap — a length ceiling instead of an essay about essays
        expect(b, r.name).toContain("anything longer is a note");
      }
    }
  });

  it("only the coordinator carries the decision-note and scope-correction rules", () => {
    const byName = Object.fromEntries(swarmRoles("swarm-x", URL, cfg).map((r) => [r.name, r.brief]));
    const coord = flat(byName["coordinator"]);
    // 1.2: one decision note + a one-line pointer; never the body inlined into chat
    expect(coord).toContain('one note "decision-<slug>"');
    expect(coord).toContain("never inline a note body into chat");
    expect(coord).toContain("there is no legitimate coordinator-authored wake");
    // 2.1 (brief half): scope moves by patching the owning task, never by a new task
    expect(coord).toContain('"correction-task-<n>-scope"');
    expect(coord).toContain("never create a new task for scope an existing open/claimed/changes task already covers");
    // workers get the compressed form only — they neither write decisions nor create tasks,
    // so paying for those lines in 4 more panes is exactly the cost this change removes
    for (const name of ["builder-1", "builder-2", "scout", "reviewer-1"]) {
      expect(byName[name], name).not.toContain("decision-<slug>");
      expect(byName[name], name).not.toContain("correction-task-<n>-scope");
    }
  });

  it("the shared core notes tell agents to remember learnings to the parent project", () => {
    expect(parentProject("C:/repo")).toBe("repo");
    expect(parentProject("Z:\\SVN\\ai_dashboard\\")).toBe("ai_dashboard");
    // the parent-memory rule lives in the shared notes now, not in every brief
    const notes = protocolNotes("swarm-x", URL, "repo", false, false);
    for (const key of ["protocol-core", "protocol-core-mcp"])
      expect(notes.find((n) => n.key === key)!.body).toContain('PARENT MEMORY (BigBrain project "repo"');
    expect(notes.find((n) => n.key === "protocol-memory")!.body).toContain(`${URL}/memory/repo/`);
    // no cwd: section omitted rather than pointing at a bogus project
    const noParent = protocolNotes("swarm-x", URL, "", false, false);
    expect(noParent.find((n) => n.key === "protocol-memory")).toBeUndefined();
    for (const n of noParent) expect(n.body).not.toContain("PARENT MEMORY");
    for (const r of swarmRoles("swarm-x", URL, { ...cfg, cwd: "" })) expect(r.brief).not.toContain("PARENT MEMORY");
  });

  it("builders, scout, and reviewer hold until tasked; only coordinator works immediately", () => {
    const roles = swarmRoles("swarm-x", URL, cfg);
    for (const r of roles) {
      const holds = r.brief.includes("HOLD UNTIL TASKED");
      if (r.name === "coordinator") expect(holds).toBe(false);
      else expect(holds).toBe(true);
    }
  });

  // The coordinator is the ONE role with no HOLD UNTIL TASKED, because on its
  // first cycle it really does explore. Every LATER wake reads the same brief from
  // the top — the host wipes its context between cycles and bootPrompt() sends it
  // straight back to note "role-coordinator" — so step 1 ("Explore just enough to
  // decompose the mission") was being re-run mid-mission: seen live, an `unblock`
  // wake spent its whole turn reading repo files while the one blocked task sat
  // there. The gate has to come BEFORE the numbered steps, or it is advice the
  // model reaches after it has already started exploring.
  it("the coordinator brief gates a resume before step 1, so a woken coordinator does not re-explore", () => {
    for (const builders of [1, 3]) {
      const coord = swarmRoles("swarm-x", URL, { ...cfg, builders })[0].brief;
      expect(coord).toContain('ALREADY RUNNING? READ NOTE "plan" BEFORE ANYTHING ELSE');
      expect(coord).toContain("do NOT explore, do NOT read repo files");
      expect(coord).toContain("AFTER ANY RESUME");
      // ordering: the gate precedes the decompose step it is guarding
      expect(coord.indexOf("ALREADY RUNNING?")).toBeLessThan(coord.indexOf("\n1. "));
    }
  });

  // The scout pane was launched, briefed, and then never tasked: step 1 opened
  // with "Explore just enough to decompose the mission", which is a licence to
  // read the repo, while the scout was an optional aside that cost a task post,
  // a round trip, and (with resets on) a whole cycle. Cheap path wins every
  // time, so the scout idled the entire mission.
  it("a scout in the team makes scouting the coordinator's first act, not an option", () => {
    const coord = swarmRoles("swarm-x", URL, { ...cfg, scout: true })[0].brief;
    expect(coord).toContain("SCOUT FIRST");
    expect(coord).toContain("you do NOT read the codebase yourself");
    expect(coord).not.toContain("Explore just enough");
    expect(coord).toContain('Tag EVERY scout request "role":"scout"');
    // No scout, no scout-first paragraph — it has to explore itself then.
    const noScout = swarmRoles("swarm-x", URL, { ...cfg, scout: false })[0].brief;
    expect(noScout).not.toContain("SCOUT FIRST");
    expect(noScout).toContain("Explore just enough");
  });

  // One builder and no reviewer means a split buys neither parallelism nor a
  // review gate, yet the brief still demanded 2-8 tasks and "one-file
  // deliverables STILL get split" — turns spent carving a mission one builder
  // does end to end anyway.
  it("a solo unreviewed swarm is told not to over-split", () => {
    const solo = swarmRoles("swarm-x", URL, { ...cfg, builders: 1, reviewer: false, reviewers: 0 })[0].brief;
    expect(solo).toContain("DO NOT OVER-SPLIT");
    expect(solo).toContain("ONE\n   task is a perfectly good plan");
    expect(solo).not.toContain("ONE-FILE DELIVERABLES STILL GET SPLIT");
    expect(solo).toContain("into 1-3 ");
    // A reviewer restores the gate, so the split mandate comes back.
    const gated = swarmRoles("swarm-x", URL, { ...cfg, builders: 1, reviewer: true, reviewers: 1 })[0].brief;
    expect(gated).toContain("ONE-FILE DELIVERABLES STILL GET SPLIT");
    expect(gated).not.toContain("DO NOT OVER-SPLIT");
    // Many builders keep the original floor.
    expect(swarmRoles("swarm-x", URL, { ...cfg, builders: 3 })[0].brief).toContain("into 2-8 ");
  });

  it("a one-builder swarm drops the collision framing from both briefs", () => {
    // Seen live: at builders:1 the coordinator still read "NON-OVERLAPPING file
    // ownership, so builders run in parallel" and split scope to dodge a conflict
    // that cannot happen — nothing ever runs beside a solo builder.
    const solo = swarmRoles("swarm-x", URL, { ...cfg, builders: 1 });
    const coord = solo.find((r) => r.name === "coordinator")!.brief;
    const builder = solo.find((r) => r.name === "builder-1")!.brief;
    expect(coord).toContain("1 builder (SOLO");
    expect(coord).toContain("SEQUENTIAL tasks");
    expect(coord).toContain("file overlap BETWEEN tasks is fine");
    expect(coord).not.toContain("NON-OVERLAPPING");
    expect(coord).not.toContain("run in parallel");
    expect(coord).not.toContain("no collision");
    expect(builder).not.toContain("builders never collide");
    expect(builder).not.toContain("another builder");
    expect(builder).not.toContain("other builders");
    // …and a multi-builder swarm keeps every one of them
    const many = swarmRoles("swarm-x", URL, { ...cfg, builders: 3 });
    const coordN = many.find((r) => r.name === "coordinator")!.brief;
    expect(coordN).toContain("3 builders");
    expect(coordN).toContain("NON-OVERLAPPING");
    expect(coordN).toContain("so builders run in parallel");
    expect(many.find((r) => r.name === "builder-2")!.brief).toContain("builders never collide");
    // the worktree rule itself survives at 1 builder — the repo root is the host's
    expect(builder).toContain("ISOLATED WORKTREE");
    expect(builder).toContain("git worktree add .swarm/task-<n> -b swarm/task-<n>");
  });

  it("scout and reviewer briefs follow the builder count too", () => {
    const solo = swarmRoles("swarm-x", URL, { ...cfg, builders: 1, reviewers: 1, reviewer: undefined });
    const many = swarmRoles("swarm-x", URL, { ...cfg, builders: 3, reviewers: 1, reviewer: undefined });
    const brief = (roles: typeof solo, name: string) => roles.find((r) => r.name === name)!.brief;
    // scout: mapping for one sequential builder is about ORDER, not parallel-safe slices
    expect(brief(solo, "scout")).toContain("ONE BUILDER works everything you map");
    expect(brief(solo, "scout")).toContain("nothing runs in parallel");
    expect(brief(many, "scout")).not.toContain("ONE BUILDER");
    // the claim's reason is the honest one either way — the brain refuses a done from a non-owner
    expect(brief(solo, "scout")).toContain("makes you its OWNER");
    expect(brief(solo, "scout")).not.toContain("collision guard");
    expect(brief(many, "scout")).not.toContain("collision guard");
    // reviewer: at one builder a "changes" verdict stalls the whole mission
    expect(brief(solo, "reviewer-1")).toContain("stalls the ENTIRE mission");
    expect(brief(solo, "reviewer-1")).toContain("so the builder redoes it");
    expect(brief(many, "reviewer-1")).not.toContain("stalls the ENTIRE mission");
    expect(brief(many, "reviewer-1")).toContain("so the owning builder redoes it");
    // …and the multi-reviewer fan-out warning still keys off the REVIEWER count, not builders
    const twoReviewers = swarmRoles("swarm-x", URL, { ...cfg, builders: 1, reviewers: 2, reviewer: undefined });
    expect(twoReviewers.find((r) => r.name === "reviewer-2")!.brief).toContain("one of 2 reviewers");
  });

  it("the shared task-bus note states the claim's real purpose at one builder", () => {
    const body = (solo: boolean) => protocolNotes("swarm-x", URL, "repo", false, false, solo).find((p) => p.key === "protocol-core")!.body;
    const mcpBody = (solo: boolean) => protocolNotes("swarm-x", URL, "repo", false, false, solo).find((p) => p.key === "protocol-core-mcp")!.body;
    for (const b of [body(true), mcpBody(true)]) {
      expect(b).toContain("makes you the task's OWNER");
      expect(b).not.toContain("collision guard");
      expect(b).not.toContain("someone beat you"); // nobody to beat you to it
    }
    for (const b of [body(false), mcpBody(false)]) {
      expect(b).toContain("collision guard");
      expect(b).toContain("someone beat you");
    }
    // the claim rule itself is unchanged in both — a claim is still mandatory
    for (const b of [body(true), body(false)]) expect(b).toContain("Claim a task before working it");
    // and "no plan yet" survives either way
    for (const b of [body(true), mcpBody(true)]) expect(b).toContain("no plan yet");
  });

  it("each role long-polls only its slice of the task bus", () => {
    const brief = (name: string) => swarmRoles("swarm-x", URL, cfg).find((r) => r.name === name)!.brief;
    const wait = (filters: string) => `${URL}/wait?project=swarm-x&${filters}&timeout=55&compact=1`;
    expect(brief("builder-1")).toContain(wait("status=open,changes&role=builder&mine=builder-1"));
    expect(brief("scout")).toContain(wait("status=open&role=scout"));
    expect(brief("reviewer-1")).toContain(wait("status=done&role=builder"));
    // The host performs merges now; the coordinator waits for tasks the host
    // has already MERGED, so it can unblock their successors.
    expect(brief("coordinator")).toContain(wait("status=merged"));
    const noReviewer = swarmRoles("swarm-x", URL, { ...cfg, reviewers: 0, reviewer: false });
    expect(noReviewer.find((r) => r.name === "coordinator")!.brief).toContain(wait("status=merged"));
    // builders check review feedback addressed to them by owner
    expect(brief("builder-2")).toContain(`${URL}/tasks?project=swarm-x&status=changes&owner=builder-2&compact=1`);
    // coordinator tags scout requests so builders can't claim them, and unblocks
    // successors (opens them) — but it no longer merges: the host does that, and
    // the brain refuses an agent-posted "merged".
    expect(brief("coordinator")).toContain('"role":"scout"');
    // The unblock is spelled as the whole call, not a bare JSON payload: a payload
    // with no URL reads as "write this object somewhere", and a builder answered
    // exactly that by writing it into the task NOTE, erasing the task's header.
    expect(brief("coordinator")).toContain(`${URL}/task-status?project=swarm-x&task=task-<n>&status=open`);
    expect(brief("coordinator")).not.toContain('"status":"merged"');
  });

  it("context resets: per-CLI wipe command, and briefs carry the cycle protocol only when enabled", () => {
    expect(resetCommand("claude --dangerously-skip-permissions")).toBe("/clear");
    expect(resetCommand("opencode")).toBe("/new");
    expect(resetCommand("pi --model sonnet")).toBe("/new"); // pi has no /clear — verified 0.84.2
    expect(resetCommand("my-custom-agent")).toBe(""); // unknown CLI: re-brief only
    // Every kind selected = every brief carries the cycle protocol.
    for (const r of swarmRoles("swarm-x", URL, { ...cfg, clearRoles: ["coordinator", "scout", "builder", "reviewer"] })) {
      expect(r.brief).toContain("CONTEXT RESET");
      expect(r.brief).toContain(`${URL}/memory/swarm-x/reset-`);
      expect(r.brief).toContain("CYCLE");
      // the wipe can only land on an idle pane — every brief must order a hard stop
      expect(r.brief).toContain("STOP");
    }
    // turn-abort key for stuck panes: ESC for TUIs, Ctrl+C for aider, ESC fallback
    expect(interruptKey("claude --dangerously-skip-permissions")).toBe("\x1b");
    expect(interruptKey("aider")).toBe("\x03");
    expect(interruptKey("my-custom-agent")).toBe("\x1b");
  });

  it("context resets are PER ROLE KIND: only the selected kinds carry the handshake", () => {
    // Builders only: builder briefs get the reset handshake; coordinator/scout/reviewer do not.
    const roles = swarmRoles("swarm-x", URL, { ...cfg, clearRoles: ["builder"] });
    for (const r of roles) {
      const wants = /^builder-\d+$/.test(r.name);
      expect(r.brief.includes("CONTEXT RESET")).toBe(wants);
      expect(r.brief.includes(`${URL}/memory/swarm-x/reset-`)).toBe(wants);
    }
    // The coordinator's own cycle-reset sentence only appears when its kind is selected.
    const coord = (kinds: RoleKind[]) => swarmRoles("swarm-x", URL, { ...cfg, clearRoles: kinds }).find((r) => r.name === "coordinator")!.brief;
    expect(coord(["builder"])).not.toContain("request a context reset and STOP");
    expect(coord(["coordinator"])).toContain("request a context reset and STOP");
  });

  it("a selected coordinator gets EVERY cycle end, not just the merge one", () => {
    const coord = (kinds: RoleKind[]) => swarmRoles("swarm-x", URL, { ...cfg, scout: true, clearRoles: kinds }).find((r) => r.name === "coordinator")!.brief;
    const on = coord(["coordinator"]);
    // The merge is one of several, and planning — the biggest context it ever
    // holds — is the first one to go.
    expect(on).toContain("CYCLE ENDS ARE NOT ONLY MERGES");
    expect(on).toContain("THAT ENDS YOUR FIRST CYCLE");
    // The scout REPORT ends a cycle; posting the request does not — charging a
    // cycle for the request is what made self-exploring the cheaper path.
    expect(on).toContain("a scout report is folded into the plan (posting the request does not)");
    expect(on).not.toContain("Posting a scout\n   request ENDS A CYCLE");
    // It must also know the host can wipe it without being asked — otherwise a
    // note it has not written yet reads as safe.
    expect(on).toContain("the host also wipes you on its own after a merge");
    // None of it exists for a coordinator the human left out of the selection.
    const off = coord(["builder"]);
    expect(off).not.toContain("CYCLE ENDS ARE NOT ONLY MERGES");
    expect(off).not.toContain("THAT ENDS YOUR FIRST CYCLE");
  });

  it("roleKind / clearsRole collapse numbered panes to a kind", () => {
    expect(roleKind("builder-3")).toBe("builder");
    expect(roleKind("reviewer-2")).toBe("reviewer");
    expect(roleKind("reviewer")).toBe("reviewer"); // legacy bare reviewer
    expect(roleKind("coordinator")).toBe("coordinator");
    expect(roleKind("nope")).toBe("");
    expect(clearsRole(["builder"], "builder-2")).toBe(true);
    expect(clearsRole(["builder"], "coordinator")).toBe(false);
    expect(clearsRole([], "builder-1")).toBe(false);
    expect(clearsRole(undefined, "builder-1")).toBe(false);
  });

  it("clearRolesOf migrates legacy swarmResets:true to every role kind", () => {
    expect(clearRolesOf({})).toEqual([]);
    expect(clearRolesOf({ swarmResets: false })).toEqual([]);
    expect(clearRolesOf({ swarmResets: true })).toEqual(["coordinator", "scout", "builder", "reviewer"]);
    // The explicit list wins over the legacy flag and is returned in canonical order.
    expect(clearRolesOf({ swarmResets: true, swarmClearRoles: ["reviewer", "builder"] })).toEqual(["builder", "reviewer"]);
    expect(clearRolesOf({ swarmClearRoles: [] })).toEqual([]); // explicit empty = off, not "all"
  });

  it("host dispatch: briefs are poll-free when enabled, keep the /wait long-poll when off", () => {
    expect(DEFAULT_SWARM.hostDispatch).toBe(true); // poll-free workers are the default
    expect(DEFAULT_SWARM.headless).toBe(true); // capable agents run piped by default; the checkbox is the opt-out
    for (const r of swarmRoles("swarm-x", URL, { ...cfg, hostDispatch: true })) {
      expect(r.brief).toContain("THE HOST WAKES YOU");
      expect(r.brief).toContain("STOP");
      expect(r.brief).not.toContain(`${URL}/wait?`); // never poll — the host watches the bus
    }
    for (const r of swarmRoles("swarm-x", URL, cfg)) {
      expect(r.brief).toContain(`${URL}/wait?`);
      expect(r.brief).not.toContain("THE HOST WAKES YOU");
    }
    // off by default: no reset handshake anywhere in the briefs
    expect(cfg.clearRoles).toEqual([]);
    for (const r of swarmRoles("swarm-x", URL, cfg)) {
      expect(r.brief).not.toContain("CONTEXT RESET");
      expect(r.brief).not.toContain(`${URL}/memory/swarm-x/reset-`);
    }
  });

  it("lazy workers: only the coordinator boots, the rest hold their command", () => {
    const panes = swarmPanes("swarm-x", URL, { ...cfg, hostDispatch: true, lazyWorkers: true });
    const coordinator = panes.find((p) => p.title === "coordinator")!;
    expect(coordinator.startupCommand).toMatch(/^claude /);
    expect(coordinator.pendingCommand).toBeUndefined();
    for (const p of panes.filter((p) => p.title !== "coordinator")) {
      expect(p.startupCommand).toBeUndefined(); // pane opens as a bare shell
      expect(p.pendingCommand).toMatch(/^claude /); // host types this on the first wake
    }
  });

  it("lazy workers off (or without host dispatch) boots every role at once", () => {
    for (const c of [{ hostDispatch: true, lazyWorkers: false }, { hostDispatch: false, lazyWorkers: true }]) {
      for (const p of swarmPanes("swarm-x", URL, { ...cfg, ...c })) {
        expect(p.startupCommand).toMatch(/^claude /);
        expect(p.pendingCommand).toBeUndefined();
      }
    }
  });

  it("per-role agent commands land in the right panes", () => {
    // legacy `builder` shape: the migration is what still honors it (see below)
    const cmds = migrateAgentCmds({ coordinator: "claude", builder: "codex", scout: "gemini", reviewer: "claude" }, 3);
    expect(cmdForRole(cmds, "builder-3")).toBe("codex");
    expect(cmdForRole(cmds, "scout")).toBe("gemini");
    expect(cmdForRole({ coordinator: "claude", builders: [""], scout: "x", reviewer: "x" }, "builder-1")).toBe("claude"); // empty falls back
    const panes = swarmPanes("swarm-x", URL, { ...cfg, agentCmds: cmds, skipPermissions: false });
    expect(panes.find((p) => p.title === "builder-2")!.startupCommand).toMatch(/^codex '/);
    expect(panes.find((p) => p.title === "scout")!.startupCommand).toMatch(/^gemini -i '/);
    expect(panes.find((p) => p.title === "coordinator")!.startupCommand).toMatch(/^claude '/);
  });

  it("each builder can run its own agent; the migration resolves every fallback once", () => {
    // per-builder array: builder-N -> builders[N-1]
    const perBuilder = { coordinator: "claude", builders: ["codex", "gemini"], scout: "claude", reviewer: "claude" };
    expect(cmdForRole(perBuilder, "builder-1")).toBe("codex");
    expect(cmdForRole(perBuilder, "builder-2")).toBe("gemini");
    // cmdForRole itself has NO fallback chain left (finding 3.16) — the array is
    // densified up front, so an out-of-range/empty entry is impossible in practice.
    expect(cmdForRole(perBuilder, "builder-3")).toBe("claude"); // unmigrated: nothing at index 2
    expect(migrateAgentCmds(perBuilder, 3).builders).toEqual(["codex", "gemini", "codex"]); // inherits builders[0]
    expect(migrateAgentCmds({ ...perBuilder, builders: ["codex", ""] }, 2).builders).toEqual(["codex", "codex"]);
    // legacy single `builder` field: the FIELD is gone from AgentCmds, an old
    // config carrying one is folded into the array exactly once, here.
    expect(migrateAgentCmds({ coordinator: "claude", builder: "opencode", scout: "claude", reviewer: "claude" }, 2).builders)
      .toEqual(["opencode", "opencode"]);
    expect("builder" in migrateAgentCmds({ coordinator: "claude", builder: "opencode", scout: "c", reviewer: "c" }, 1)).toBe(false);
    // nothing configured at all still yields a usable client
    expect(migrateAgentCmds({ coordinator: "claude", scout: "c", reviewer: "c" }, 2).builders).toEqual(["claude", "claude"]);
    // panes wire each builder to its own client
    const panes = swarmPanes("swarm-x", URL, { ...cfg, builders: 3, agentCmds: perBuilder, skipPermissions: false });
    expect(panes.find((p) => p.title === "builder-1")!.startupCommand).toMatch(/^codex '/);
    expect(panes.find((p) => p.title === "builder-2")!.startupCommand).toMatch(/^gemini -i '/);
    expect(panes.find((p) => p.title === "builder-3")!.startupCommand).toMatch(/^codex '/); // inherits builders[0]
  });

  it("CLIs whose positional arg is not a prompt get their prompt flag", () => {
    const cmds = { coordinator: "opencode", builder: "gemini", scout: "claude", reviewer: "claude" };
    const panes = swarmPanes("swarm-x", URL, { ...cfg, agentCmds: cmds, skipPermissions: false });
    // opencode's positional arg is the project dir — prompt must go via --prompt
    expect(panes.find((p) => p.title === "coordinator")!.startupCommand).toMatch(/^opencode --prompt '/);
    // gemini's positional prompt is one-shot — -i keeps the session interactive
    expect(panes.find((p) => p.title === "builder-1")!.startupCommand).toMatch(/^gemini -i '/);
  });

  it("skipPermissions injects each CLI's bypass flag", () => {
    expect(skipPermissionFlag("claude")).toBe("--dangerously-skip-permissions");
    expect(skipPermissionFlag("claude --model opus")).toBe("--dangerously-skip-permissions");
    expect(skipPermissionFlag("gemini")).toBe("--yolo");
    expect(skipPermissionFlag("my-custom-agent")).toBe(""); // unknown client: no flag
    expect(skipPermissionFlag("claude --dangerously-skip-permissions")).toBe(""); // no double flag
    const cmds = { coordinator: "claude", builder: "codex", scout: "gemini", reviewer: "claude" };
    const on = swarmPanes("swarm-x", URL, { ...cfg, agentCmds: cmds, skipPermissions: true });
    expect(on.find((p) => p.title === "coordinator")!.startupCommand).toMatch(/^claude --dangerously-skip-permissions '/);
    expect(on.find((p) => p.title === "builder-1")!.startupCommand).toMatch(/^codex --dangerously-bypass-approvals-and-sandbox '/);
    expect(on.find((p) => p.title === "scout")!.startupCommand).toMatch(/^gemini --yolo -i '/);
    const off = swarmPanes("swarm-x", URL, { ...cfg, agentCmds: cmds, skipPermissions: false });
    for (const p of off) expect(p.startupCommand).not.toContain("--dangerously");
  });

  it("CLI-profile commands (binary + model args) keep flag lookups and ordering", () => {
    // A saved CLI profile yields e.g. "claude --model claude-opus-4-8" as the role
    // agentCmd — bypass + prompt flags must still resolve from the first token.
    const cmds = { coordinator: "opencode --model big", builder: "claude --model claude-opus-4-8", scout: "gemini -m g --yolo", reviewer: "claude" };
    const panes = swarmPanes("swarm-x", URL, { ...cfg, agentCmds: cmds, skipPermissions: true });
    expect(panes.find((p) => p.title === "builder-1")!.startupCommand).toMatch(/^claude --model claude-opus-4-8 --dangerously-skip-permissions '/);
    expect(panes.find((p) => p.title === "coordinator")!.startupCommand).toMatch(/^opencode --model big --prompt '/);
    // profile already carries --yolo: not doubled, -i still added
    expect(panes.find((p) => p.title === "scout")!.startupCommand).toMatch(/^gemini -m g --yolo -i '/);
  });

  it("panes boot by fetching their role note; grid keeps every pane", () => {
    const panes = swarmPanes("swarm-x", URL, cfg);
    expect(panes[0].startupCommand).toContain(`curl -s ${URL}/memory/swarm-x/role-coordinator`);
    // single-quoted for PowerShell -Command: no double quotes or apostrophes inside
    for (const p of panes) expect(p.startupCommand!.slice(p.startupCommand!.indexOf("'"))).toMatch(/^'[^'"]*'$/);
    const root = gridRoot(panes);
    expect(collectPanes(root).map((p) => p.id).sort()).toEqual(panes.map((p) => p.id).sort());
  });

  it("the boot prompt is one plain ASCII line", () => {
    // It ships two ways and both break on a newline: embedded in a shell command
    // line (PowerShell answers a line break with ">>" and then a ParserError, so
    // the agent never launches) and typed into a TUI input box by the reset /
    // runaway watchers (a newline submits the half-typed prompt). Non-ASCII is
    // out too — the PTY codepage is not guaranteed to be UTF-8.
    const prompt = bootPrompt("swarm-x", URL, "builder-1");
    expect(prompt).not.toMatch(/[\r\n]/);
    expect(prompt).toMatch(/^[\x20-\x7e]+$/);
    expect(isInjectable(prompt)).toBe(true);
    // the boot prompt is ALSO embedded in a shell command line as '<prompt>'
    expect(prompt).not.toMatch(/['"]/);
    for (const p of swarmPanes("swarm-x", URL, cfg)) expect(p.startupCommand).not.toMatch(/[\r\n]/);
  });

  it("EVERY string that reaches submitPrompt is one plain ASCII line", () => {
    // The invariant used to be tested on bootPrompt alone, and everything else
    // typed into a pane drifted: the [host] wake messages all carried em dashes,
    // which a non-UTF-8 PTY codepage turns into mojibake inside the TUI's input
    // box. Walk every injectable string this module owns instead.
    const injected = [
      bootPrompt("swarm-x", URL, "coordinator"),
      nudgeText("builder-2"),
      nudgeText(""),
      ...Object.values(RESET_COMMANDS),
      ...Object.values(WAKE_MESSAGES).map((m) => m("task-1, task-2", "builder-1")),
    ];
    for (const text of injected) {
      expect(isInjectable(text), JSON.stringify(text)).toBe(true);
      expect(text).not.toMatch(/[\r\n]/);
    }
    expect(isInjectable("two\nlines")).toBe(false);
    expect(isInjectable("em — dash")).toBe(false);
    expect(isInjectable("")).toBe(false);
  });
});

describe("turn concurrency budget (app-global)", () => {
  beforeEach(() => {
    setTurnCapOverride(undefined);
    retainSwarms([]); // fresh ledger — the budget is module-global by design
  });

  it("derives one live turn per builder of the LARGEST swarm, never zero", () => {
    expect(turnCap()).toBe(1); // no swarm registered: the coordinator still gets to run
    registerSwarm("swarm-a", 0);
    expect(turnCap()).toBe(1); // a swarm with no builder pane still lets the coordinator run
    registerSwarm("swarm-a", 3);
    expect(turnCap()).toBe(3);
    // THE BUG (finding 1.1): a second swarm on the same endpoint used to ADD its
    // own cap, so the endpoint saw 2N concurrent completions. It must not.
    registerSwarm("swarm-b", 2);
    expect(turnCap()).toBe(3);
  });

  it("spends ONE budget across every swarm", () => {
    registerSwarm("swarm-a", 1);
    registerSwarm("swarm-b", 1); // two 1-builder swarms = still one live turn total
    expect(takeTurnSlot("swarm-a", "coordinator")).toBe(true);
    expect(takeTurnSlot("swarm-b", "coordinator")).toBe(false); // the other swarm's turn is live
    expect(liveTurns()).toEqual(["swarm-a/coordinator"]);
    releaseTurnSlot("swarm-a", "coordinator");
    expect(takeTurnSlot("swarm-b", "coordinator")).toBe(true);
  });

  it("a 'run concurrent' swarm lifts the cap for its own panes but still records the load", () => {
    registerSwarm("swarm-a", 1, true); // concurrent
    const t0 = 2_000_000;
    // Cap is 1, but concurrent lets every role take a slot — none is refused.
    expect(takeTurnSlot("swarm-a", "coordinator", t0)).toBe(true);
    expect(takeTurnSlot("swarm-a", "builder-1", t0)).toBe(true);
    expect(takeTurnSlot("swarm-a", "reviewer-1", t0)).toBe(true); // would be false at cap=1
    // The holds are still recorded, so the load is visible (mirror stays truthful).
    expect(liveTurns(t0).sort()).toEqual(["swarm-a/builder-1", "swarm-a/coordinator", "swarm-a/reviewer-1"]);
    // A NON-concurrent swarm sees that global load and is still capped.
    registerSwarm("swarm-b", 1, false);
    expect(takeTurnSlot("swarm-b", "coordinator", t0)).toBe(false);
    // Toggling concurrent off (re-register) restores the cap for swarm-a too.
    reportBusy("swarm-a", []); // clear its holds
    registerSwarm("swarm-a", 1, false);
    expect(takeTurnSlot("swarm-a", "coordinator", t0)).toBe(true);
    expect(takeTurnSlot("swarm-a", "builder-1", t0)).toBe(false); // capped again
  });

  it("counts measured panes, and a pane already live keeps its one slot", () => {
    registerSwarm("swarm-a", 2);
    reportBusy("swarm-a", ["builder-1", "builder-1", "coordinator"]); // dedupes
    expect(liveTurns().sort()).toEqual(["swarm-a/builder-1", "swarm-a/coordinator"]);
    expect(takeTurnSlot("swarm-a", "builder-1")).toBe(true); // already live — not a second slot
    expect(takeTurnSlot("swarm-a", "reviewer")).toBe(false); // at the cap
    reportBusy("swarm-a", []); // turns ended
    expect(takeTurnSlot("swarm-a", "reviewer")).toBe(true);
  });

  it("expires a hold whose wake never landed, so the budget cannot wedge", () => {
    registerSwarm("swarm-a", 1);
    const t0 = 1_000_000;
    expect(takeTurnSlot("swarm-a", "builder-1", t0)).toBe(true);
    expect(takeTurnSlot("swarm-a", "coordinator", t0 + TURN_HOLD_MS - 1)).toBe(false);
    expect(takeTurnSlot("swarm-a", "coordinator", t0 + TURN_HOLD_MS)).toBe(true); // hold aged out
    expect(liveTurns(t0 + TURN_HOLD_MS)).toEqual(["swarm-a/coordinator"]);
  });

  it("a forced overrun is counted and ages out like any other hold", () => {
    // injectPromptWaiting gives up waiting and injects anyway. That turn is real:
    // it must show in liveTurns() (so nothing else is let in on top of it) and it
    // must expire, instead of being an untracked turn nobody can see or reclaim.
    registerSwarm("swarm-a", 1);
    const t0 = 2_000_000;
    expect(takeTurnSlot("swarm-a", "builder-1", t0)).toBe(true);
    expect(takeTurnSlot("swarm-a", "coordinator", t0)).toBe(false); // at the cap
    forceTurnSlot("swarm-a", "coordinator", t0);
    expect(liveTurns(t0).sort()).toEqual(["swarm-a/builder-1", "swarm-a/coordinator"]);
    expect(turnBudget("swarm-a")).toEqual({ cap: 1, inFlight: 2, busy: ["builder-1", "coordinator"], starved: [] });
    expect(liveTurns(t0 + TURN_HOLD_MS)).toEqual([]); // both aged out
  });

  it("a forced slot for an already-measured pane does not double-count", () => {
    registerSwarm("swarm-a", 2);
    reportBusy("swarm-a", ["coordinator"]);
    forceTurnSlot("swarm-a", "coordinator");
    expect(liveTurns()).toEqual(["swarm-a/coordinator"]);
  });

  it("a closed swarm stops holding the budget", () => {
    registerSwarm("swarm-a", 1);
    reportBusy("swarm-a", ["coordinator"]);
    registerSwarm("swarm-b", 1);
    expect(takeTurnSlot("swarm-b", "coordinator")).toBe(false);
    retainSwarms(["swarm-b"]); // swarm-a's workspace was closed
    expect(takeTurnSlot("swarm-b", "coordinator")).toBe(true);
  });

  it("an app-global override wins and clears", () => {
    registerSwarm("swarm-a", 1);
    setTurnCapOverride(2);
    expect(turnCap()).toBe(2);
    expect(takeTurnSlot("swarm-a", "coordinator")).toBe(true);
    expect(takeTurnSlot("swarm-a", "builder-1")).toBe(true);
    expect(takeTurnSlot("swarm-a", "reviewer")).toBe(false);
    setTurnCapOverride(0); // 0 is "no override", not "block everything"
    expect(turnCap()).toBe(1);
    setTurnCapOverride(2);
    setTurnCapOverride(undefined);
    expect(turnCap()).toBe(1);
  });

  it("mirrors the budget per swarm as slots move", () => {
    registerSwarm("swarm-a", 2);
    reportBusy("swarm-a", ["coordinator"]);
    expect(turnBudget("swarm-a")).toEqual({ cap: 2, inFlight: 1, busy: ["coordinator"], starved: [] });
    takeTurnSlot("swarm-a", "builder-1");
    expect(turnBudget("swarm-a")).toEqual({ cap: 2, inFlight: 2, busy: ["coordinator", "builder-1"], starved: [] });
    releaseTurnSlot("swarm-a", "builder-1");
    expect(turnBudget("swarm-a")).toEqual({ cap: 2, inFlight: 1, busy: ["coordinator"], starved: [] });
  });

  it("a pane refused at the cap long enough is mirrored as starved, and a granted slot clears it", () => {
    // The invisible-starvation shape (finding-reviewer-never-starts): another
    // swarm's busy panes hold the whole app-global budget, so this swarm's
    // launch silently retries every tick — the mirror has to say so.
    registerSwarm("swarm-a", 1);
    registerSwarm("swarm-b", 1);
    const t0 = 3_000_000;
    reportBusy("swarm-a", ["builder-1"], t0); // measured busy never ages out on its own
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0)).toBe(false);
    expect(turnBudget("swarm-b").starved).toEqual([]); // refused, but not starved yet
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 10_000)).toBe(false);
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 20_000)).toBe(false);
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + STARVED_AFTER_MS)).toBe(false);
    expect(turnBudget("swarm-b").starved).toEqual([{ title: "reviewer-1", since: t0 }]);
    reportBusy("swarm-a", [], t0 + STARVED_AFTER_MS); // the other swarm's turn ended
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + STARVED_AFTER_MS + 1000)).toBe(true);
    expect(turnBudget("swarm-b").starved).toEqual([]);
  });

  it("a starvation streak restarts after a gap, and a caller that stops asking drops out of the mirror", () => {
    registerSwarm("swarm-a", 1);
    registerSwarm("swarm-b", 1);
    const t0 = 4_000_000;
    reportBusy("swarm-a", ["builder-1"], t0);
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0)).toBe(false);
    // Next refusal arrives past the freshness window — a NEW streak, so being
    // refused once every few minutes never accumulates into "starved".
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 20_000)).toBe(false);
    // Steady refusals every dispatcher tick from here on keep the streak alive.
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 30_000)).toBe(false);
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 40_000)).toBe(false);
    expect(turnBudget("swarm-b").starved).toEqual([]); // 20s streak — measured from the restart, not t0
    expect(takeTurnSlot("swarm-b", "reviewer-1", t0 + 20_000 + STARVED_AFTER_MS)).toBe(false);
    expect(turnBudget("swarm-b").starved).toEqual([{ title: "reviewer-1", since: t0 + 20_000 }]);
    // The work drains (nothing calls takeTurnSlot any more): the next publish —
    // any ledger event, here the per-tick measurement — ages the entry out.
    reportBusy("swarm-b", [], t0 + 20_000 + STARVED_AFTER_MS + 60_000);
    expect(turnBudget("swarm-b").starved).toEqual([]);
  });

  it("only role panes count against the cap", () => {
    for (const r of ["coordinator", "scout", "reviewer", "reviewer-1", "reviewer-12", "builder-1", "builder-12"]) expect(isRolePane({ role: r })).toBe(true);
    // the human's own splits — these can emit output forever and must not eat a slot
    for (const r of [undefined, "", "shell", "builder", "builder-x", "reviewer-x", "Coordinator"]) expect(isRolePane({ role: r })).toBe(false);
    // reviewer panes, old (bare) and new (numbered) alike, are what dispatch fans "done" tasks over
    for (const r of ["reviewer", "reviewer-1", "reviewer-12"]) expect(isReviewerRole(r)).toBe(true);
    for (const r of ["reviewers", "reviewer-x", "builder-1", "coordinator", ""]) expect(isReviewerRole(r)).toBe(false);
  });

  it("publishes the budget and notifies only on a real change", () => {
    const seen: { project: string; inFlight: number }[] = [];
    const off = onTurnBudget((project, b) => seen.push({ project, inFlight: b.inFlight }));
    setTurnBudget("swarm-c", { cap: 2, inFlight: 1, busy: ["coordinator"], starved: [] });
    setTurnBudget("swarm-c", { cap: 2, inFlight: 1, busy: ["coordinator"], starved: [] }); // identical — no fire
    expect(seen).toEqual([{ project: "swarm-c", inFlight: 1 }]);
    setTurnBudget("swarm-c", { cap: 2, inFlight: 2, busy: ["coordinator", "builder-1"], starved: [] });
    expect(seen.length).toBe(2);
    expect(turnBudget("swarm-c")).toEqual({ cap: 2, inFlight: 2, busy: ["coordinator", "builder-1"], starved: [] });
    expect(turnBudget("swarm-never-seen")).toEqual({ cap: 0, inFlight: 0, busy: [], starved: [] });
    off();
    setTurnBudget("swarm-c", { cap: 2, inFlight: 0, busy: [], starved: [] });
    expect(seen.length).toBe(2); // unsubscribed
  });
});

describe("budget tracking covers dispatch-off swarms", () => {
  // REGRESSION: the tick used to filter on `w.swarm && w.swarmDispatch`, so a
  // swarm with host dispatch off was absent from retainSwarms() and had its
  // ledger deleted every POLL_MS — while swarmNudge/swarmRunaway kept injecting
  // into it (they iterate `w.swarm` alone). Its live turns were then invisible to
  // the app-global cap, which is exactly the over-subscription the cap prevents.
  const ws = [
    { swarm: "swarm-a", swarmDispatch: true },
    { swarm: "swarm-b", swarmDispatch: false },
    { swarm: undefined, swarmDispatch: true }, // a plain workspace
    {},
  ];

  it("tracks every swarm workspace regardless of swarmDispatch", () => {
    expect(trackedSwarms(ws).map((w) => w.swarm)).toEqual(["swarm-a", "swarm-b"]);
  });
});

describe("a relaunch on a repo another swarm is already in", () => {
  // The sweep at launch removes .swarm/task-<n> trees and swarm/task-<n>
  // branches. Those are repo-scoped, so running it while ANOTHER swarm is
  // working in the same repo would delete that swarm's live worktrees — which is
  // why the launch asks this first and skips the sweep on any answer but "none".
  const wsOf = (swarm: string | undefined, ...cwds: (string | undefined)[]) => ({
    swarm,
    root: gridRoot(cwds.map((cwd, i) => ({ ...newPane(), id: `${swarm ?? "plain"}-${i}`, role: "builder-1", cwd }))),
  });

  it("names the swarms already pointed at the repo, and normalises only the cosmetic path differences", () => {
    const workspaces = [
      wsOf("swarm-a", "/repo"),
      wsOf("swarm-b", "/repo/"),
      wsOf("swarm-c", " /repo "),
      wsOf("swarm-d", "/other"),
      wsOf(undefined, "/repo"), // a plain workspace in the same repo is not a swarm
    ];
    expect(swarmsInRepo(workspaces, "/repo")).toEqual(["swarm-a", "swarm-b", "swarm-c"]);
    expect(swarmsInRepo(workspaces, "/other")).toEqual(["swarm-d"]);
    expect(swarmsInRepo(workspaces, "/elsewhere")).toEqual([]);
  });

  it("does not read a pane with no cwd as a match — an empty path is not every repo", () => {
    expect(swarmsInRepo([wsOf("swarm-a", undefined, "")], "")).toEqual([]);
    expect(swarmsInRepo([wsOf("swarm-a", undefined, "/repo")], "/repo")).toEqual(["swarm-a"]);
  });

  // The gate on the relaunch sweep. Every case here except the first two ends in
  // "sweep", and the whole point is that a workspace on disk never gets a vote
  // on its own: it survives the kill that the swarm did not.
  describe("is a swarm actually running in this repo", () => {
    const ghost = [wsOf("swarm-a", "/repo")]; // persisted, and it outlives a pkill

    it("takes a live owner that is not this process at its word", () => {
      // A second PixelMarch running a swarm here. Its panes are not in OUR
      // workspace list and never will be, so the list must not be consulted.
      expect(swarmLiveInRepo({ locked: true, live: true, ours: false }, [], "/repo")).toBe(true);
    });

    it("counts this process's own swarm as live only while its panes are open", () => {
      expect(swarmLiveInRepo({ locked: true, live: true, ours: true }, ghost, "/repo")).toBe(true);
      // Same live process, workspace deleted: the guard is armed by something
      // that is running, but the swarm it was armed for is gone. Cancel, then
      // relaunch — this is the case that must reclaim rather than skip.
      expect(swarmLiveInRepo({ locked: true, live: true, ours: true }, [], "/repo")).toBe(false);
      // A swarm on a DIFFERENT repo is not this repo's swarm.
      expect(swarmLiveInRepo({ locked: true, live: true, ours: true }, [wsOf("swarm-a", "/other")], "/repo")).toBe(false);
    });

    it("reads a lock whose owner was killed as a leftover, however convincing the workspace list is", () => {
      // THE regression. Both ghosts agree a swarm is here; only the process
      // table knows the truth, and it is the one that decides.
      expect(swarmLiveInRepo({ locked: true, live: false, ours: false }, ghost, "/repo")).toBe(false);
    });

    it("reads no lock, and an unanswerable probe, as nothing running", () => {
      expect(swarmLiveInRepo({ locked: false, live: false, ours: false }, ghost, "/repo")).toBe(false);
      expect(swarmLiveInRepo({ ok: false } as never, ghost, "/repo")).toBe(false);
      expect(swarmLiveInRepo(null, ghost, "/repo")).toBe(false);
      expect(swarmLiveInRepo(undefined, ghost, "/repo")).toBe(false);
    });
  });
});

describe("user-supplied role briefs", () => {
  const brief = (c: typeof cfg, name: string) => swarmRoles("swarm-x", URL, c).find((r) => r.name === name)!.brief;
  const md = (path: string, body: string) => ({ path, body });

  it("a supplied md replaces the role body but keeps the protocol block", () => {
    const custom = { ...cfg, roleBriefs: { "builder-1": md("C:/briefs/builder.md", "You are a MINIMALIST builder. Write no comments.") } };
    const b1 = brief(custom, "builder-1");
    expect(b1).toContain("You are a MINIMALIST builder.");
    expect(b1).not.toContain("HOLD UNTIL TASKED"); // generated body is gone
    // protocol survives: coordination endpoints and the pointer to the shared contract
    expect(b1).toContain("COORDINATION (BigBrain project");
    expect(b1).toContain("READ NOTE protocol-core");
    expect(b1).toContain(`${URL}/memory/swarm-x/`);
    // and only that role changed
    expect(brief(custom, "builder-2")).toBe(brief(cfg, "builder-2"));
  });

  it("overrides every customisable role independently", () => {
    const roles = ["coordinator", "builder-1", "builder-2", "scout", "reviewer-1"];
    const custom = { ...cfg, roleBriefs: Object.fromEntries(roles.map((r) => [r, md(`${r}.md`, `CUSTOM ${r}`)])) };
    for (const r of roles) {
      expect(brief(custom, r)).toContain(`CUSTOM ${r}`);
      expect(brief(custom, r)).toContain("READ NOTE protocol-core");
    }
    // only the coordinator's protocol carries the task-creation recipe
    const createRecipe = `-X POST ${URL}/task -d`;
    expect(brief(custom, "coordinator")).toContain(createRecipe);
    expect(brief(custom, "builder-1")).not.toContain(createRecipe);
  });

  it("a blank or missing entry falls back to the generated brief", () => {
    const blank = { ...cfg, roleBriefs: { scout: md("s.md", "   \n\t "), "builder-1": md("b.md", "") } };
    expect(brief(blank, "scout")).toBe(brief(cfg, "scout"));
    expect(brief(blank, "builder-1")).toBe(brief(cfg, "builder-1"));
    expect(swarmRoles("swarm-x", URL, { ...cfg, roleBriefs: undefined })).toEqual(swarmRoles("swarm-x", URL, cfg));
  });

  it("ignores keys that are not roles this swarm spawned", () => {
    const stray = { ...cfg, roleBriefs: { designer: md("d.md", "CUSTOM designer"), "builder-9": md("b9.md", "CUSTOM builder-9"), "reviewer-3": md("r3.md", "CUSTOM reviewer-3") } };
    const roles = swarmRoles("swarm-x", URL, stray);
    expect(roles).toEqual(swarmRoles("swarm-x", URL, cfg));
    for (const r of roles) expect(r.brief).not.toContain("CUSTOM ");
  });

  it("composeBrief is pure and always appends the protocol", () => {
    expect(composeBrief("GENERATED", "  MY BRIEF  ", "PROTOCOL")).toBe("MY BRIEF\nPROTOCOL");
    expect(composeBrief("GENERATED", "", "PROTOCOL")).toBe("GENERATED");
    expect(composeBrief("GENERATED", undefined, "PROTOCOL")).toBe("GENERATED");
  });
});

describe("MCP panes (Phase B3)", () => {
  const MCPP = "/portable/pixelmarch-mcp.json";
  const mcpCfg = { ...cfg, hostDispatch: true };

  it("the flag is appended only for a CLI that has MCP AND a config to point at", () => {
    expect(mcpConfigFlag("claude", MCPP)).toBe(`--mcp-config '${MCPP}'`);
    expect(hasMcp("claude")).toBe(true);
    // no path (older binary, host that cannot write it) = today's exact command line
    expect(mcpConfigFlag("claude", "")).toBe("");
    // a CLI whose MCP support was never verified keeps the curl path
    for (const bin of Object.keys(AGENT_CAPS).filter((b) => !agentCaps(b).mcp)) expect(mcpConfigFlag(bin, MCPP)).toBe("");
    expect(mcpConfigFlag("some-unknown-cli", MCPP)).toBe("");
    // a quote in the path would split the command line — refuse instead
    expect(mcpConfigFlag("claude", "/tmp/it's/mcp.json")).toBe("");
    expect(speaksMcp("claude", MCPP)).toBe(true);
    expect(speaksMcp("claude", "")).toBe(false);
  });

  it("--strict-mcp-config is never passed: it would disable the user's own MCP servers", () => {
    expect(mcpConfigFlag("claude", MCPP)).not.toContain("--strict");
    const pane = swarmPanes("swarm-x", URL, mcpCfg, "", MCPP)[0];
    expect(pane.startupCommand).not.toContain("--strict");
  });

  it("a host-dispatch builder is told how to redo a task handed back as changes", () => {
    // The loop this exists for: a builder woken by the `changes` wake ran step 1
    // ("snapshot what is open"), found NOTHING open (its own rework is `changes`,
    // never `open`), and the brief said stop. The wake re-fired every REWAKE_MS
    // and the task never moved off `changes` — one live swarm burned a builder's
    // whole context that way (note swarm-changes-wake-builder-loop).
    const brief = swarmRoles("swarm-x", URL, { ...cfg, hostDispatch: true }).find((r) => r.name === "builder-1")!.brief;
    expect(brief).toContain("came back with CHANGES");
    expect(brief).toContain("status=changes&owner=builder-1"); // the feedback query, at step 1
    expect(brief).toContain("status=claimed&owner=builder-1"); // the retake, not /claim
    expect(brief).toContain("review-task-<n>");
    // and the wake that sends it there names the same call, never the bare "re-claim"
    const wake = WAKE_MESSAGES.changes("task-4", "builder-1");
    expect(wake).toContain('status: "claimed"');
    expect(wake).toContain("review-task-4");
    expect(wake).toContain("correction-task-4-scope");
    expect(wake).not.toContain("re-claim");
  });

  it("boot prompt and command agree: MCP wording only where the flag is", () => {
    const withMcp = bootPrompt("swarm-x", URL, "builder-1", true);
    expect(withMcp).not.toContain("curl");
    expect(withMcp).toContain("note_get");
    expect(withMcp).toContain(MCP_SERVER);
    expect(withMcp).toContain("role-builder-1");
    expect(isInjectable(withMcp)).toBe(true); // still one line of printable ASCII, still no quotes
    expect(withMcp).not.toMatch(/['"]/);
    // default is unchanged — every non-MCP pane keeps the curl prompt verbatim
    expect(bootPrompt("swarm-x", URL, "builder-1")).toContain(`curl -s ${URL}/memory/swarm-x/role-builder-1`);

    const boot = swarmPanes("swarm-x", URL, mcpCfg, "", MCPP)[0].startupCommand!;
    expect(boot).toContain(`--mcp-config '${MCPP}'`);
    expect(boot).toContain("note_get");
    expect(boot).not.toContain("curl");
    // no config path = the old command line and the old prompt, together
    const plain = swarmPanes("swarm-x", URL, mcpCfg)[0].startupCommand!;
    expect(plain).not.toContain("--mcp-config");
    expect(plain).toContain("curl -s");
  });

  it("the prompt is never the arg after --mcp-config: the flag is variadic and would eat it", () => {
    // claude 2.1.218: `claude --mcp-config m.json 'You are agent ...'` dies with
    // "MCP config file not found: You are agent ..." — the pane never boots.
    for (const pane of swarmPanes("swarm-x", URL, mcpCfg, "/portable/hooks.json", MCPP)) {
      const cmd = pane.startupCommand ?? pane.pendingCommand!;
      expect(cmd, pane.title).toContain("--mcp-config");
      // whatever follows the flag's value must be an option terminator, not the prompt
      expect(cmd, pane.title).toMatch(/--mcp-config '[^']*' --( |$)/);
      expect(cmd, pane.title).toMatch(/ -- '[^']*'$/);
      // and the prompt is still the last thing on the line, single-quoted, unsplit
      expect(cmd.trimEnd().endsWith("'"), pane.title).toBe(true);
    }
    // a pane with hooks but no MCP keeps its command line byte-for-byte: --settings
    // takes exactly one value, so there is nothing to terminate.
    const hooksOnly = swarmPanes("swarm-x", URL, mcpCfg, "/portable/hooks.json")[0].startupCommand!;
    expect(hooksOnly).toContain("--settings '/portable/hooks.json' '");
    expect(hooksOnly).not.toContain(" -- ");
  });

  it("an unquotable config path drops the flag AND the MCP wording together", () => {
    const bad = "/home/o'brien/mcp.json";
    expect(mcpConfigFlag("claude", bad)).toBe("");
    expect(speaksMcp("claude", bad)).toBe(false); // the brief asks the same question the flag does
    for (const r of swarmRoles("swarm-x", URL, mcpCfg, bad)) {
      expect(r.brief, r.name).toContain("curl -s"); // curl brief on a curl command line
      expect(r.brief, r.name).not.toContain("note_get");
    }
    for (const p of swarmPanes("swarm-x", URL, mcpCfg, "", bad)) {
      expect((p.startupCommand ?? p.pendingCommand)!, p.title).not.toContain("--mcp-config");
    }
  });

  it("an MCP-capable brief contains zero curl, and says how to reach the bus instead", () => {
    const roles = swarmRoles("swarm-x", URL, mcpCfg, MCPP);
    for (const r of roles) {
      expect(r.brief, r.name).not.toContain("curl");
      expect(r.brief, r.name).toContain(`MCP server "${MCP_SERVER}"`);
      expect(r.brief, r.name).toContain("note_get {project: swarm-x");
      // the shared contract arrives via the MCP-flavor core note, not the curl one
      expect(r.brief, r.name).toContain("protocol-core-mcp");
    }
    // each role still learns ITS task-bus verbs in tool-call form
    const brief = (name: string) => roles.find((r) => r.name === name)!.brief;
    expect(brief("builder-1")).toContain("task_claim {project: swarm-x");
    expect(brief("builder-1")).toContain("tasks_list {project: swarm-x");
    expect(brief("builder-1")).toContain("no plan yet"); // the claim gate survives the rewording
    expect(brief("scout")).toContain("task_claim {project: swarm-x");
    expect(brief("reviewer-1")).toContain('task_status {project: swarm-x, task: task-<n>, status: "approved"}');
    // The coordinator unblocks successors (opens them); it no longer posts "merged" —
    // the host does that, and the brain refuses an agent-posted merge.
    expect(brief("coordinator")).toContain('task_status {project: swarm-x, task: task-<n>, status: "open"}');
    expect(brief("coordinator")).not.toContain('status: "merged"');
    expect(brief("coordinator")).toContain("task_create");
  });

  it("a pane whose CLI cannot load MCP keeps its curl brief, in the same swarm", () => {
    const mixed = { ...mcpCfg, agentCmds: { ...mcpCfg.agentCmds, builders: ["claude", "aider"] } };
    const roles = swarmRoles("swarm-x", URL, mixed, MCPP);
    expect(roles.find((r) => r.name === "builder-1")!.brief).not.toContain("curl");
    const b2 = roles.find((r) => r.name === "builder-2")!.brief;
    expect(b2).toContain(`curl -s ${URL}/memory/swarm-x/`); // aider: unverified, so today's path
    expect(b2).not.toContain("task_claim {");
  });
});
