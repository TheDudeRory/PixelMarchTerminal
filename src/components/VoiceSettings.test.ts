import { describe, expect, it, vi } from "vitest";
import type { VoiceModelInfo, VoiceModelProgress } from "../lib/ipc";

// VoiceSettings pulls in @tauri-apps/api (and a CSS import) at module load;
// nothing below invokes the backend.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const { formatBytes, percent, modelRow, progressReducer } = await import("./VoiceSettings");

const info = (p: Partial<VoiceModelInfo> = {}): VoiceModelInfo => ({
  id: "base.en-q8_0",
  label: "base.en q8_0",
  file: "ggml-base.en-q8_0.bin",
  present: false,
  size_bytes: null,
  expected_size: 81_781_811,
  complete: false,
  selected: true,
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q8_0.bin",
  ...p,
});

const ev = (p: Partial<VoiceModelProgress> = {}): VoiceModelProgress => ({
  id: "base.en-q8_0",
  downloaded: 0,
  total: 81_781_811,
  status: "progress",
  error: null,
  ...p,
});

describe("formatBytes", () => {
  it("scales and tolerates a missing size", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(81_781_811)).toBe("78 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});

describe("percent", () => {
  it("is null without a known total and never leaves 0–100", () => {
    expect(percent(10, null)).toBeNull();
    expect(percent(10, 0)).toBeNull();
    expect(percent(50, 200)).toBe(25);
    expect(percent(999, 200)).toBe(100);
  });
});

describe("modelRow", () => {
  it("reports an installed model", () => {
    const r = modelRow(info({ present: true, complete: true, size_bytes: 81_781_811 }));
    expect(r.state).toBe("installed");
    expect(r.busy).toBe(false);
    expect(r.detail).toContain("78 MB");
  });

  // The whole point of the feature: a truncated leftover is present but useless,
  // and must never be reported as installed.
  it("calls a wrong-sized file damaged, not installed", () => {
    const r = modelRow(info({ present: true, complete: false, size_bytes: 1024 }));
    expect(r.state).toBe("incomplete");
    expect(r.detail).toContain("expected");
  });

  it("reports a missing model with its download size", () => {
    const r = modelRow(info());
    expect(r.state).toBe("missing");
    expect(r.detail).toContain("78 MB");
  });

  it("shows live progress and stays busy while downloading", () => {
    const r = modelRow(info(), ev({ downloaded: 40_890_905 }));
    expect(r.state).toBe("downloading");
    expect(r.busy).toBe(true);
    expect(r.progress).toBe(50);
    expect(r.detail).toContain("50%");
  });

  it("is busy while verifying too", () => {
    const r = modelRow(info(), ev({ status: "verifying", downloaded: 81_781_811 }));
    expect(r.state).toBe("verifying");
    expect(r.busy).toBe(true);
  });

  it("surfaces a failure without hiding the on-disk state", () => {
    const r = modelRow(info(), ev({ status: "error", error: "sha256 mismatch" }));
    expect(r.state).toBe("missing");
    expect(r.busy).toBe(false);
    expect(r.error).toBe("sha256 mismatch");
  });

  it("falls back to a generic message when an error carries no text", () => {
    expect(modelRow(info(), ev({ status: "error", error: null })).error).toBe("download failed");
  });
});

describe("progressReducer", () => {
  it("tracks the newest event per id", () => {
    const a = progressReducer({}, ev({ downloaded: 10 }));
    const b = progressReducer(a, ev({ downloaded: 20 }));
    const c = progressReducer(b, ev({ id: "tiny.en", downloaded: 5 }));
    expect(b["base.en-q8_0"].downloaded).toBe(20);
    expect(Object.keys(c).sort()).toEqual(["base.en-q8_0", "tiny.en"]);
    expect(a).not.toBe(b); // new object each time, so React re-renders
  });

  it("drops a finished install so the refreshed disk status takes over", () => {
    const a = progressReducer({}, ev({ downloaded: 20 }));
    expect(progressReducer(a, ev({ status: "done" }))).toEqual({});
  });

  it("keeps an error so the user can read why it failed", () => {
    const a = progressReducer({}, ev({ status: "error", error: "boom" }));
    expect(a["base.en-q8_0"].error).toBe("boom");
  });

  it("returns the same object when a done event has nothing to clear", () => {
    const empty = {};
    expect(progressReducer(empty, ev({ status: "done" }))).toBe(empty);
  });
});
