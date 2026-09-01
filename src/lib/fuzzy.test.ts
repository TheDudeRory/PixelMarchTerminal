import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "./fuzzy";

describe("fuzzy", () => {
  it("matches subsequences and rejects non-subsequences", () => {
    expect(fuzzyScore("np", "New pane")).not.toBeNull();
    expect(fuzzyScore("xyz", "New pane")).toBeNull();
  });

  it("empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks consecutive / word-start matches higher", () => {
    const contiguous = fuzzyScore("pane", "New pane")!;
    const scattered = fuzzyScore("pane", "p a n e x")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("filter returns matches sorted best-first", () => {
    const items = ["Close pane", "New pane: PowerShell", "Split down"];
    const out = fuzzyFilter("pane", items, (s) => s);
    expect(out).toContain("Close pane");
    expect(out).not.toContain("Split down");
  });
});
