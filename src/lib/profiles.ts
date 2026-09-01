// Reusable pane templates. A profile snapshots its settings onto each pane it
// creates, so editing a profile later doesn't mutate existing panes.
import { newPane, DEFAULT_MONITOR, type MonitorConfig, type Pane, type PaneKind, type RestartPolicy } from "./layout-tree";

export interface ShellInfo {
  id: string;
  label: string;
  path: string;
  args: string[];
}

export interface PaneProfile {
  id: string;
  name: string;
  kind?: PaneKind; // undefined = "terminal"
  monitor?: MonitorConfig; // for kind: "monitor"
  shellPath?: string; // resolved path; undefined = backend default shell
  args?: string[];
  cwd?: string;
  startupCommand?: string;
  env?: Record<string, string>;
  color?: string;
  fontSize?: number;
  restartPolicy: RestartPolicy;
  bigBrainTargets?: string[]; // agent-config files to inject the BigBrain block into; empty/undefined = off
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

export function newProfile(init: Partial<PaneProfile> = {}): PaneProfile {
  return { id: uid(), name: "New profile", restartPolicy: "rerun", ...init };
}

/** Build a pane (terminal template) from a profile. */
export function paneFromProfile(p: PaneProfile): Pane {
  return newPane({
    title: p.name,
    kind: p.kind,
    monitor: p.kind === "monitor" ? { ...DEFAULT_MONITOR, ...p.monitor } : undefined,
    shell: p.shellPath,
    args: p.args,
    cwd: p.cwd,
    startupCommand: p.startupCommand,
    env: p.env,
    restartPolicy: p.restartPolicy,
    color: p.color,
    fontSize: p.fontSize,
    profileId: p.id,
    bigBrainTargets: p.bigBrainTargets,
  });
}

/** Seed starter profiles based on the shells actually present. */
export function starterProfiles(shells: ShellInfo[]): PaneProfile[] {
  const byId = (id: string) => shells.find((s) => s.id === id);
  const best = byId("pwsh") ?? byId("powershell") ?? shells[0];
  const cmd = byId("cmd");
  const ps = (extra: Partial<PaneProfile>): Partial<PaneProfile> => ({
    shellPath: best?.path,
    args: best?.args,
    ...extra,
  });
  return [
    newProfile({ name: "PowerShell", ...ps({}), color: "#4c8bf5" }),
    newProfile({ name: "Command Prompt", shellPath: cmd?.path, args: cmd?.args, color: "#9aa0a6" }),
    newProfile({ name: "Claude Code", ...ps({ startupCommand: "claude" }), color: "#e0a44c", restartPolicy: "rerun" }),
    newProfile({
      name: "Python venv",
      ...ps({ startupCommand: "if (Test-Path .venv\\Scripts\\Activate.ps1) { .\\.venv\\Scripts\\Activate.ps1 }" }),
      color: "#5fbf6a",
    }),
    newProfile({ name: "System Monitor", kind: "monitor", color: "#46c7c7" }),
  ];
}
