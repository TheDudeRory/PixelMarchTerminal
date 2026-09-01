import { describe, expect, it } from "vitest";
import { driftCommand, driftPrompt } from "./drift";

const URL = "http://127.0.0.1:8734/t/abc123";

// The prompt is single-quoted onto the command line, so ONE apostrophe in it
// would end the quoted arg and hand the rest of the sentence to the shell. This
// is the whole safety contract of the file.
describe("driftPrompt", () => {
  it("carries no apostrophe", () => {
    expect(driftPrompt("ai_dashboard", URL)).not.toContain("'");
  });

  it("names the project and the endpoints the agent must read", () => {
    const p = driftPrompt("ai_dashboard", URL);
    expect(p).toContain("ai_dashboard");
    expect(p).toContain(`${URL}/keys?project=ai_dashboard`);
    expect(p).toContain(`${URL}/memory/ai_dashboard/<key>`);
  });

  it("forbids writing notes without approval", () => {
    expect(driftPrompt("p", URL)).toMatch(/Do NOT write, patch or delete any note/);
  });
});

describe("driftCommand", () => {
  it("passes the prompt to claude positionally, quoted as one arg", () => {
    const line = driftCommand("claude", "p", URL, false);
    expect(line.startsWith("claude '")).toBe(true);
    expect(line.endsWith("'")).toBe(true);
    // exactly two quotes = exactly one argument
    expect(line.split("'").length - 1).toBe(2);
  });

  it("adds the CLI's own skip flag only when asked", () => {
    expect(driftCommand("claude", "p", URL, true)).toContain("--dangerously-skip-permissions");
    expect(driftCommand("gemini", "p", URL, true)).toContain("--yolo");
    expect(driftCommand("claude", "p", URL, false)).not.toContain("--dangerously");
  });

  it("uses the prompt flag for CLIs whose positional arg is not a prompt", () => {
    expect(driftCommand("opencode", "p", URL, false)).toContain("opencode --prompt '");
    expect(driftCommand("gemini", "p", URL, false)).toContain("-i '");
  });

  it("keeps a client's own args and reads its binary through them", () => {
    const line = driftCommand("claude --model claude-opus-5", "p", URL, true);
    expect(line.startsWith("claude --model claude-opus-5 --dangerously-skip-permissions '")).toBe(true);
  });

  it("refuses a project name that would break out of the quoting", () => {
    expect(driftCommand("claude", "dave's repo", URL, false)).toBe("");
    expect(driftCommand("", "p", URL, false)).toBe("");
  });
});
