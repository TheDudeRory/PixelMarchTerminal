// Drift audit: one pane, one CLI, one question — "does this project's BigBrain
// memory still match the code?". Notes outlive the code they describe, so a note
// that was true when it was written quietly becomes a confident lie: a moved
// file, a renamed symbol, a decision a later commit reversed. Nothing in the
// brain notices that on its own — an agent reading the notes beside the repo
// does, which is all this launcher is.
import { PROMPT_FLAGS, agentBin, skipPermissionFlag } from "./swarm";

/** The audit prompt. Read-only by contract: the whole point is that a stale note
 *  gets FOUND, and an agent rewriting notes unattended is exactly how a wrong
 *  note becomes an authoritative one — so it reports and stops.
 *
 *  Written WITHOUT apostrophes on purpose. driftCommand single-quotes it onto
 *  the command line (PowerShell -Command / sh -c), and one apostrophe would end
 *  the quoted string and split the prompt into stray commands. Double quotes are
 *  safe inside and are used for the curl URLs, which carry `?` and `&`. */
export function driftPrompt(project: string, brainUrl: string): string {
  return [
    `Audit the BigBrain memory of project ${project} for drift against the code in this folder.`,
    `List its notes with: curl -s "${brainUrl}/keys?project=${project}"`,
    `Read each one with: curl -s "${brainUrl}/memory/${project}/<key>"`,
    `For every claim in every note, check the code that is actually here now: file paths that moved or vanished,`,
    `symbols that were renamed, line references that no longer point at what the note says, decisions a later commit`,
    `reversed, notes that contradict another note, and notes describing work that was finished or abandoned.`,
    `Report one line per drifted note: the key, what it claims, what is true now. Name the notes you checked and found`,
    `still accurate too, so the clean ones are not re-audited next time.`,
    `Do NOT write, patch or delete any note until I have read your report and told you which fixes to make.`,
  ].join(" ");
}

/** Command line that launches `agentCmd` on the drift prompt. Same shape as a
 *  swarm boot command: skip flag (optional), then the prompt as ONE quoted arg,
 *  positional except for the CLIs that need a flag before it (PROMPT_FLAGS).
 *  Returns "" when the prompt could not be quoted safely — see driftPrompt. */
export function driftCommand(agentCmd: string, project: string, brainUrl: string, skipPermissions: boolean): string {
  const cmd = agentCmd.trim();
  if (!cmd) return "";
  const prompt = driftPrompt(project, brainUrl);
  // A project name or brain URL carrying an apostrophe would break out of the
  // quoting the same way the prompt text could. Refuse rather than emit a
  // command line that runs half a prompt as shell.
  if (prompt.includes("'")) return "";
  const flag = skipPermissions ? skipPermissionFlag(cmd) : "";
  const promptFlag = PROMPT_FLAGS[agentBin(cmd)];
  return `${cmd}${flag ? ` ${flag}` : ""}${promptFlag ? ` ${promptFlag}` : ""} '${prompt}'`;
}
