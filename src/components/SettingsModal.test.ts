import { describe, expect, it, vi } from "vitest";

// SettingsModal pulls in the layout store -> terminalPool -> xterm, which touches
// `self` at import time and dies under vitest's node environment (no jsdom in
// this repo) — same stub as FirstRun.test.ts. Nothing below renders or invokes.
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

const {
  INSTALL_MESSAGE, versionLabel, updateCheckMessage, updateOfferLabel, dirtyTreeWarning,
  buildProgressMessage,
  liveSessionCount, terminalCostWarning, nextInstallStep, installButtonLabel,
} = await import("./SettingsModal");

describe("versionLabel", () => {
  // The whole point: after a self-update the user must be able to read back what
  // they are now running, and quote it to support.
  it("names the running version", () => {
    expect(versionLabel("0.1.3")).toBe("Version 0.1.3");
    expect(versionLabel("0.1.2")).toBe("Version 0.1.2");
    expect(versionLabel("10.4.11")).toBe("Version 10.4.11");
  });

  // app_version returns CARGO_PKG_VERSION, which is bare, but the feed and the
  // release zips spell versions with a leading v. Only one form may reach the
  // user, or "Version v0.1.3" shows up the first time someone passes the other.
  it("prints one version form whichever way it arrives", () => {
    expect(versionLabel("v0.1.3")).toBe("Version 0.1.3");
    expect(versionLabel("V0.1.3")).toBe("Version 0.1.3");
    expect(versionLabel("  0.1.3  ")).toBe("Version 0.1.3");
  });

  // Nothing is worse here than a confidently wrong version: this line is what
  // someone checks an update against. With no answer, show no line at all.
  it("says nothing at all when the backend has not answered", () => {
    expect(versionLabel(null)).toBe("");
    expect(versionLabel(undefined)).toBe("");
    expect(versionLabel("")).toBe("");
    expect(versionLabel("   ")).toBe("");
  });

  it("never renders a placeholder in place of a version", () => {
    for (const v of [null, undefined, "", "  "]) {
      expect(versionLabel(v)).not.toMatch(/undefined|null|NaN|unknown/i);
    }
  });
});

describe("INSTALL_MESSAGE", () => {
  // Shown from the click until the first update-progress event. An update is now
  // a pull AND a full rebuild, so the honest expectation to set is minutes.
  it("says what is happening and that the app will restart", () => {
    expect(INSTALL_MESSAGE).toMatch(/pull/i);
    expect(INSTALL_MESSAGE).toMatch(/rebuild/i);
    expect(INSTALL_MESSAGE).toMatch(/restart/i);
  });

  it("sets the expectation that the wait is long and normal", () => {
    expect(INSTALL_MESSAGE).toMatch(/minute/i);
  });

  // Real detail comes from buildProgressMessage, driven by output that actually
  // arrived. This string is shown when none has — so any step count or percentage
  // baked into it would be invented.
  it("claims no progress it cannot actually measure", () => {
    expect(INSTALL_MESSAGE).not.toMatch(/%|\bstep\b|\d+\s*(of|\/)\s*\d+/i);
  });

  // The old message promised "a ~13 MB download". There is no download any more,
  // and a message describing the previous mechanism is worse than none.
  it("does not describe the retired download-and-swap updater", () => {
    expect(INSTALL_MESSAGE).not.toMatch(/download|MB|verif/i);
  });
});

describe("update check outcomes", () => {
  // A checkout that CANNOT update itself — no git, no upstream, detached HEAD —
  // is neither current nor broken. Collapsing it into "up to date" would tell
  // someone they are on the newest code when nothing was ever checked.
  it("does not call an un-updatable checkout up to date", () => {
    const msg = updateCheckMessage({ status: "blocked", reason: "no upstream configured" });
    expect(msg).not.toMatch(/up to date/i);
    // git's own words are passed through — they name the branch or the remote.
    expect(msg).toContain("no upstream configured");
  });

  it("still says up to date when that is actually true", () => {
    expect(updateCheckMessage({ status: "upToDate" })).toBe("You're up to date.");
  });

  // An offer speaks for itself — the version, the remote and the commit subjects
  // render on their own lines, so the status line must not compete with them.
  it("says nothing extra when an update is offered", () => {
    const info = { behind: 2, upstream: "origin/master", version: "0.1.38", notes: ["x"], dirty: false };
    expect(updateCheckMessage({ status: "available", info })).toBe("");
  });

  // A shape this build doesn't understand is the one case where we know nothing.
  // Falling back to "You're up to date." would be a lie about the only thing the
  // user came here to learn.
  it("never claims currency for an answer it cannot read", () => {
    for (const bad of [null, undefined, {} as never, { status: "nonsense" } as never]) {
      expect(updateCheckMessage(bad)).not.toMatch(/up to date/i);
      expect(updateCheckMessage(bad)).toMatch(/rebuild/i);
    }
  });
});

describe("updateOfferLabel", () => {
  const info = { behind: 4, upstream: "origin/master", version: "0.1.38", notes: [], dirty: false };

  // The remote is named because an update BUILDS what it pulls: whoever can push
  // to it runs code on this machine. That belongs next to the button.
  it("names the version, the commit count and the remote", () => {
    expect(updateOfferLabel(info)).toBe("v0.1.38 available — 4 commits from origin/master");
  });

  // The version is read from the incoming package.json and can legitimately be
  // missing; the commit count never is, so it carries the sentence alone.
  it("still says what is coming when the version could not be read", () => {
    expect(updateOfferLabel({ ...info, version: "" })).toBe("Update available — 4 commits from origin/master");
    expect(updateOfferLabel({ ...info, version: "" })).not.toMatch(/undefined|v\s*—/);
  });

  it("counts one commit in the singular", () => {
    expect(updateOfferLabel({ ...info, behind: 1 })).toContain("1 commit from");
    expect(updateOfferLabel({ ...info, behind: 1 })).not.toContain("1 commits");
  });

  it("renders nothing without an offer", () => {
    expect(updateOfferLabel(null)).toBe("");
    expect(updateOfferLabel(undefined)).toBe("");
  });
});

describe("dirtyTreeWarning", () => {
  const clean = { behind: 1, upstream: "origin/master", version: "0.1.38", notes: [], dirty: false };

  // An agent editing this app has a dirty tree nearly all the time, so this is a
  // heads-up and NOT a refusal — `git pull --ff-only` fails only when the incoming
  // commits touch a locally modified file, and then it changes nothing.
  it("warns without threatening the user's work", () => {
    const msg = dirtyTreeWarning({ ...clean, dirty: true });
    expect(msg).toMatch(/uncommitted/i);
    expect(msg).toMatch(/without touching|stops/i);
    expect(msg).not.toMatch(/lost|discard|overwritten\b(?!.*\bif\b)/i);
  });

  it("stays quiet on a clean tree", () => {
    expect(dirtyTreeWarning(clean)).toBe("");
    expect(dirtyTreeWarning(null)).toBe("");
  });
});

describe("buildProgressMessage", () => {
  const p = { step: 4, steps: 4, command: "cargo build --release", line: "   Compiling pixelmarch v0.1.37" };

  // The two things that are actually known: which step, and what it just printed.
  it("names the step and the command's latest line", () => {
    expect(buildProgressMessage(p)).toBe("Step 4 of 4 — cargo build --release: Compiling pixelmarch v0.1.37");
  });

  // A step that has not printed anything yet is a real state (cargo is silent for
  // seconds while it resolves), and it must not render a trailing colon.
  it("holds the step line before any output arrives", () => {
    expect(buildProgressMessage({ ...p, line: "" })).toBe("Step 4 of 4 — cargo build --release");
    expect(buildProgressMessage({ ...p, line: "   " })).not.toMatch(/:\s*$/);
  });

  // Before the first event there is no step to name, so the static message stands.
  it("falls back to the static message with no event yet", () => {
    expect(buildProgressMessage(null)).toBe(INSTALL_MESSAGE);
    expect(buildProgressMessage(undefined)).toBe(INSTALL_MESSAGE);
  });

  // THE LINE THIS FILE EXISTS TO HOLD: a build has no total, so there is no
  // percentage to show. The old updater could draw one because a download has a
  // Content-Length; inventing the same shape here invents the number behind it.
  it("shows no percentage, because a build has none to show", () => {
    expect(buildProgressMessage(p)).not.toMatch(/%/);
    expect(buildProgressMessage({ ...p, line: "50%" })).not.toMatch(/\(\s*\d+\s*%\s*\)/);
  });
});

describe("the terminal cost of updating", () => {
  // Since task-18 a self-update stops and restarts the terminal host, so every
  // shell dies with it. Until now the user found that out by losing work.
  it("names what is actually lost, in plain words", () => {
    const w = terminalCostWarning(2);
    expect(w).toMatch(/stopped/i);
    expect(w).toMatch(/scrollback/i);
    expect(w).toContain("2 open terminal sessions");
  });

  it("counts one session as one", () => {
    const w = terminalCostWarning(1);
    expect(w).toContain("1 open terminal session");
    expect(w).not.toContain("sessions");
  });

  // A warning nobody needs is noise, and noise is how warnings get ignored.
  it("says nothing when there is nothing to lose", () => {
    expect(terminalCostWarning(0)).toBe("");
    expect(terminalCostWarning(-1)).toBe("");
  });

  // Informed consent, not a deterrent: the update is good and refusing it is
  // worse than losing a shell, so the wording must not tell anyone to hold off.
  it("does not discourage updating", () => {
    expect(terminalCostWarning(3)).not.toMatch(/don't update|do not update|avoid updating|cancel/i);
  });
});

describe("liveSessionCount", () => {
  // A pane gets a paneStatus entry when its shell starts and loses it when the
  // pane closes, so "started and not exited" is exactly the set of live shells.
  it("counts shells that started and have not exited", () => {
    expect(liveSessionCount({ a: { startedAt: 1 }, b: { startedAt: 2 } })).toBe(2);
  });

  it("does not count a shell that already exited", () => {
    expect(liveSessionCount({ a: { startedAt: 1, exit: { code: 0, at: 9 } }, b: { startedAt: 2 } })).toBe(1);
  });

  it("is zero before anything has started", () => {
    expect(liveSessionCount({})).toBe(0);
    expect(liveSessionCount(null)).toBe(0);
    expect(liveSessionCount(undefined)).toBe(0);
  });
});

describe("the warning comes BEFORE the pull", () => {
  // THE POINT OF THIS CHANGE: with sessions open, the first click on Install can
  // only ask. Nothing is pulled or built until the cost has been shown and accepted.
  it("asks first and installs second when sessions are open", () => {
    expect(nextInstallStep(false, 2)).toBe("confirm");
    expect(nextInstallStep(true, 2)).toBe("install");
  });

  // Every update where no terminal is open pays no friction at all.
  it("installs on the first click when nothing is running", () => {
    expect(nextInstallStep(false, 0)).toBe("install");
  });

  // "OK" would not tell anyone what they are agreeing to; the button names it.
  it("names the cost on the confirming button", () => {
    expect(installButtonLabel(false, 2)).toBe("Install & restart");
    expect(installButtonLabel(false, 0)).toBe("Install & restart");
    expect(installButtonLabel(true, 2)).toBe("Close 2 sessions & install");
    expect(installButtonLabel(true, 1)).toBe("Close 1 session & install");
  });
});
