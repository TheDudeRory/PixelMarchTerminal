import { describe, expect, it } from "vitest";
import inputRs from "../../src-tauri/src/macros/input.rs?raw";
import {
  KEY_GROUPS, canonicalToken, comboFromEvent, filterGroups, isKnownToken,
  joinCombo, keyLabel, splitCombo, tokenFromCode,
} from "./keys";

const tokens = KEY_GROUPS.flatMap((g) => g.keys.map((k) => k.token));

describe("catalog", () => {
  it("has the media keys no keyboard can record", () => {
    for (const t of ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrev", "MediaStop",
                     "AudioVolumeUp", "AudioVolumeDown", "AudioVolumeMute"])
      expect(tokens).toContain(t);
  });

  it("has no duplicate tokens", () => {
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  // The send side is parse_key_token; a token it rejects fails only at run
  // time, so check the Rust source names every multi-char token we can emit.
  it("every token parses on the macro send side", () => {
    const literals = new Set([...inputRs.matchAll(/"([A-Z0-9]+)"/g)].map((m) => m[1]));
    const missing = tokens.filter((t) => t.length > 1 && !literals.has(t.toUpperCase()));
    expect(missing).toEqual([]);
  });
});

describe("canonicalToken", () => {
  it("accepts catalog tokens case-insensitively", () => {
    expect(canonicalToken("mediaplaypause")).toBe("MediaPlayPause");
    expect(canonicalToken("F13")).toBe("F13");
  });
  it("maps older spellings onto the catalog", () => {
    expect(canonicalToken("Return")).toBe("Enter");
    expect(canonicalToken("Up")).toBe("ArrowUp");
    expect(canonicalToken("VolumeUp")).toBe("AudioVolumeUp");
  });
  it("rejects what neither backend knows", () => {
    expect(canonicalToken("Wibble")).toBeNull();
    expect(isKnownToken("Wibble")).toBe(false);
    expect(isKnownToken("MediaPlayPause")).toBe(true);
  });
});

describe("splitCombo / joinCombo", () => {
  it("splits modifiers off the key", () => {
    expect(splitCombo("Ctrl+Shift+MediaPlayPause")).toEqual({ mods: ["Ctrl", "Shift"], key: "MediaPlayPause" });
  });
  it("treats a lone modifier as the key (hold_key Shift)", () => {
    expect(splitCombo("Shift")).toEqual({ mods: [], key: "Shift" });
  });
  it("keeps a trailing modifier as the key", () => {
    expect(splitCombo("Ctrl+Alt")).toEqual({ mods: ["Ctrl"], key: "Alt" });
  });
  it("orders modifiers canonically regardless of click order", () => {
    expect(joinCombo(["Shift", "Ctrl"], "K")).toBe("Ctrl+Shift+K");
    expect(joinCombo([], "MediaStop")).toBe("MediaStop");
  });
});

describe("capture", () => {
  const ev = (code: string, mods: Partial<KeyboardEvent> = {}) => ({ code, ...mods }) as KeyboardEvent;

  it("strips the Key/Digit prefix browsers add", () => {
    expect(tokenFromCode("KeyA")).toBe("A");
    expect(tokenFromCode("Digit7")).toBe("7");
    expect(tokenFromCode("MediaPlayPause")).toBe("MediaPlayPause");
  });
  it("builds a combo from the held modifiers", () => {
    expect(comboFromEvent(ev("KeyC", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+C");
  });
  it("ignores a bare modifier press", () => {
    expect(comboFromEvent(ev("ShiftLeft"))).toBeNull();
  });
});

describe("picker list", () => {
  it("finds media keys by label, not just token", () => {
    const cats = filterGroups("play").flatMap((g) => g.keys.map((k) => k.token));
    expect(cats).toContain("MediaPlayPause");
  });
  it("hides modifier-only keys unless a single key is being picked", () => {
    expect(filterGroups("").some((g) => g.modifiers)).toBe(false);
    expect(filterGroups("", { modifiers: true }).some((g) => g.modifiers)).toBe(true);
  });
  it("labels a token for display", () => {
    expect(keyLabel("MediaPlayPause")).toBe("Play / Pause");
    expect(keyLabel("F13")).toBe("F13");
  });
});
