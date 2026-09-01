import { describe, it, expect } from "vitest";
import { paneFromProfile, starterProfiles, newProfile, type ShellInfo } from "./profiles";

const shells: ShellInfo[] = [
  { id: "powershell", label: "Windows PowerShell", path: "C:/pwsh.exe", args: [] },
  { id: "cmd", label: "Command Prompt", path: "C:/cmd.exe", args: [] },
  { id: "gitbash", label: "Git Bash", path: "C:/bash.exe", args: ["-i", "-l"] },
];

describe("profiles", () => {
  it("builds a pane snapshotting the profile's settings", () => {
    const p = newProfile({ name: "Claude Code", shellPath: "C:/pwsh.exe", startupCommand: "claude", restartPolicy: "rerun" });
    const pane = paneFromProfile(p);
    expect(pane.title).toBe("Claude Code");
    expect(pane.shell).toBe("C:/pwsh.exe");
    expect(pane.startupCommand).toBe("claude");
    expect(pane.profileId).toBe(p.id);
    expect(pane.restartPolicy).toBe("rerun");
  });

  it("seeds starter profiles bound to detected shells (incl. cmd.exe)", () => {
    const seeded = starterProfiles(shells);
    expect(seeded.map((p) => p.name)).toEqual(
      expect.arrayContaining(["PowerShell", "Command Prompt", "Claude Code", "Python venv"]),
    );
    expect(seeded.find((p) => p.name === "PowerShell")?.shellPath).toBe("C:/pwsh.exe");
    expect(seeded.find((p) => p.name === "Command Prompt")?.shellPath).toBe("C:/cmd.exe");
    expect(seeded.find((p) => p.name === "Claude Code")?.startupCommand).toBe("claude");
  });
});
