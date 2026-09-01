import { describe, expect, it } from "vitest";
import { cliProfileCommand, newCliProfile } from "./cliProfiles";

describe("cliProfileCommand", () => {
  it("returns the bare command when no model or extra args", () => {
    expect(cliProfileCommand(newCliProfile({ command: "claude" }))).toBe("claude");
  });

  it("adds --model for claude/codex/aider/opencode", () => {
    expect(cliProfileCommand(newCliProfile({ command: "claude", model: "claude-opus-4-8" }))).toBe("claude --model claude-opus-4-8");
    expect(cliProfileCommand(newCliProfile({ command: "codex", model: "o3" }))).toBe("codex --model o3");
    expect(cliProfileCommand(newCliProfile({ command: "aider", model: "sonnet" }))).toBe("aider --model sonnet");
    expect(cliProfileCommand(newCliProfile({ command: "opencode", model: "big" }))).toBe("opencode --model big");
  });

  it("uses -m for gemini", () => {
    expect(cliProfileCommand(newCliProfile({ command: "gemini", model: "gemini-2.5-pro" }))).toBe("gemini -m gemini-2.5-pro");
  });

  it("falls back to --model for unknown CLIs", () => {
    expect(cliProfileCommand(newCliProfile({ command: "somecli", model: "x" }))).toBe("somecli --model x");
  });

  it("resolves the flag from the binary even when the command carries args", () => {
    expect(cliProfileCommand(newCliProfile({ command: "gemini --yolo", model: "g" }))).toBe("gemini --yolo -m g");
  });

  it("appends extra args last and skips empty model", () => {
    expect(cliProfileCommand(newCliProfile({ command: "claude", model: " ", extraArgs: "--verbose" }))).toBe("claude --verbose");
    expect(cliProfileCommand(newCliProfile({ command: "claude", model: "m", extraArgs: "--verbose" }))).toBe("claude --model m --verbose");
  });
});
