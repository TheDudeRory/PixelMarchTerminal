import { describe, expect, it, vi } from "vitest";

// BigBrain -> stores/layout -> terminalPool -> xterm, which touches `self` at
// import time and dies under vitest's node environment (no jsdom in this repo).
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));

const { minimalEdit } = await import("./BigBrain");

// `minimalEdit` is what turns a textarea save into a `POST /patch` op=replace:
// the contract is that `find` is UNIQUE in the old body (so op=replace cannot hit
// the wrong copy, and doubles as the `expect` concurrency guard), that applying
// find->replace to the old body reproduces the new one, and that it declines
// whenever a whole-body save would be no bigger.
const applied = (before: string, e: { find: string; replace: string }) =>
  before.replace(e.find, e.replace);

const body = (...lines: string[]) => lines.join("\n");

// Overlaps counted — `"aa"` is in `"aaa"` twice, and String.split would miss it.
const occurrencesIn = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

// Enough body that a patch is actually smaller than a whole-note save — below
// that `minimalEdit` correctly declines, which would make these cases vacuous.
const longTail = Array.from({ length: 30 }, (_, i) => `tail line ${i}`);

describe("minimalEdit", () => {
  it("is null when nothing changed", () => {
    expect(minimalEdit("same\ntext", "same\ntext")).toBeNull();
  });

  it("sends only the changed line out of a long note", () => {
    const before = body(...Array.from({ length: 60 }, (_, i) => `line ${i}`));
    const after = before.replace("line 30", "line THIRTY");
    const e = minimalEdit(before, after)!;
    // Whole lines, newline included — so a deleted line takes its break with it.
    expect(e).toEqual({ find: "line 30\n", replace: "line THIRTY\n" });
    expect(applied(before, e)).toBe(after);
    // The whole point: the patch is a fraction of the body it replaces.
    expect(e.find.length + e.replace.length).toBeLessThan(after.length / 10);
  });

  it("keeps `find` unique by growing outward over repeated lines", () => {
    // The changed line reads the same as line 5, so the naive one-line anchor
    // would match twice and op=replace would edit the wrong one.
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines[5] = "dup";
    lines[25] = "dup";
    const before = body(...lines);
    lines[25] = "CHANGED";
    const after = body(...lines);
    const e = minimalEdit(before, after)!;
    expect(occurrencesIn(before, e.find)).toBe(1);
    expect(applied(before, e)).toBe(after);
  });

  it("anchors a pure insertion, which has no changed line of its own", () => {
    const before = body("alpha", "beta", "gamma", ...longTail);
    const after = body("alpha", "beta", "INSERTED", "gamma", ...longTail);
    const e = minimalEdit(before, after)!;
    expect(e.find).not.toBe("");
    expect(applied(before, e)).toBe(after);
  });

  it("takes the deleted line's newline with it", () => {
    const before = body("alpha", "beta", "gamma", ...longTail);
    const after = body("alpha", "gamma", ...longTail);
    const e = minimalEdit(before, after)!;
    expect(e.find).toBe("beta\n");
    expect(e.replace).toBe("");
    expect(applied(before, e)).toBe(after);
  });

  it("declines when the edit is the whole note anyway", () => {
    expect(minimalEdit("one two three", "four five six")).toBeNull();
  });

  it("declines when the note is too small for a patch to be a win", () => {
    expect(minimalEdit("ab", "ac")).toBeNull();
  });

  it("declines rather than risk an ambiguous anchor it cannot make unique", () => {
    // Every line identical: growing outward never yields a unique `find`, so the
    // caller must fall back to a whole-body save rather than patch the wrong line.
    const before = body("dup", "dup", "dup");
    const after = body("dup", "CHANGED", "dup");
    expect(minimalEdit(before, after)).toBeNull();
  });

  it("never returns an edit that does not reproduce the new body", () => {
    const cases: [string, string][] = [
      [body("a", "b", "c"), body("a", "b", "c", "d")],
      [body("a", "b", "c", "d", "e", "f", "g", "h"), body("a", "b", "X", "d", "e", "f", "g", "h")],
      [body("header", "", "one", "", "two", "", "three"), body("header", "", "one", "", "TWO", "", "three")],
      ["trailing\nnewline\n", "trailing\nNEWLINE\n"],
    ];
    for (const [before, after] of cases) {
      const e = minimalEdit(before, after);
      if (!e) continue;
      expect(occurrencesIn(before, e.find)).toBe(1);
      expect(applied(before, e)).toBe(after);
    }
  });
});
