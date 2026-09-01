// CLI client profiles — a named AI-agent CLI invocation (binary + model + extra
// args), e.g. "Claude Opus" → `claude --model claude-opus-4-8`. Used as startup
// commands for panes and as swarm role commands. Persisted in pixelmarch.json.
import { agentBin } from "./swarm";

export interface CliProfile {
  id: string;
  name: string;
  command: string; // agent CLI, usually one of KNOWN_AGENT_CMDS (may carry its own args)
  model?: string; // model id passed via the CLI's model flag; empty = CLI default
  extraArgs?: string; // appended verbatim after the model flag
}

/** Per-CLI model flag, keyed by binary name (see agentBin). Unknown CLIs fall
 *  back to "--model" — the common convention. */
export const MODEL_FLAGS: Record<string, string> = {
  claude: "--model",
  codex: "--model",
  aider: "--model",
  gemini: "-m",
  opencode: "--model",
};

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

export function newCliProfile(init: Partial<CliProfile> = {}): CliProfile {
  return { id: uid(), name: "New CLI profile", command: "claude", ...init };
}

/** Final command line for a profile: command + model flag (if a model is set)
 *  + extra args. E.g. {command:"claude", model:"claude-opus-4-8"} →
 *  "claude --model claude-opus-4-8". */
export function cliProfileCommand(p: CliProfile): string {
  const parts = [p.command.trim()];
  const model = p.model?.trim();
  if (model) parts.push(`${MODEL_FLAGS[agentBin(p.command)] ?? "--model"} ${model}`);
  const extra = p.extraArgs?.trim();
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join(" ");
}
