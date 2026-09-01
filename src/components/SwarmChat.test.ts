import { describe, expect, it, vi } from "vitest";
import { isInjectable } from "../lib/swarm";

// The component pulls in the layout store, which pulls in terminalPool -> xterm,
// which touches `self` at import time and dies under vitest's node environment
// (no jsdom in this repo). Stub the pool: none of it runs in these tests.
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));

const { toInjectable, payloadFor, chatTargets, resolveTargets, routeDraft, chatChannel, parseAsk, parseAnswer, askAnswerBody, askAnswerNudge } = await import("./SwarmChat");

describe("toInjectable", () => {
  it("folds a multi-line paste to one line", () => {
    const out = toInjectable("first line\nsecond\tline\r\nthird");
    expect(out).toBe("first line second line third");
    expect(isInjectable(out)).toBe(true);
  });

  it("maps smart punctuation to ASCII instead of dropping it", () => {
    expect(toInjectable("don’t — “ship” it…")).toBe('don\'t - "ship" it...');
  });

  it("strips characters the PTY codepage cannot carry", () => {
    const out = toInjectable("build ✓ done éé");
    expect(out).toBe("build done");
    expect(isInjectable(out)).toBe(true);
  });

  it("every result either passes isInjectable or is empty (rejected by send)", () => {
    for (const raw of ["hi", "  ", "❤❤", "a\nb", "@all go", "tabs\t\tand   spaces"]) {
      const out = toInjectable(raw);
      expect(out === "" || isInjectable(out)).toBe(true);
    }
  });
});

describe("payloadFor", () => {
  const stream = (id: string) => id === "head";

  it("hands a stream pane the message verbatim — multi-line UTF-8 included", () => {
    const raw = "deploy plan:\n- step one ✓\n- étape deux\n\ndon’t flatten me";
    expect(payloadFor("head", raw, stream)).toBe(raw);
  });

  it("folds the same message for a TUI pane", () => {
    const out = payloadFor("tui", "first line\nsecond ✓ line", stream);
    expect(out).toBe("first line second line");
    expect(isInjectable(out)).toBe(true);
  });

  it("returns empty for a TUI pane when nothing survives the fold, but keeps the stream copy", () => {
    expect(payloadFor("tui", "❤❤\n✓", stream)).toBe("");
    expect(payloadFor("head", "❤❤\n✓", stream)).toBe("❤❤\n✓");
  });
});

describe("chatTargets", () => {
  it("addresses an agent pane by its typed role, not by its title", () => {
    const out = chatTargets([{ id: "p1", title: "notes — do not rename me", role: "reviewer" }]);
    expect(out).toEqual([{ id: "p1", name: "reviewer", label: "notes — do not rename me", agent: true }]);
  });

  it("keeps a role-less human shell addressable by its title", () => {
    const out = chatTargets([{ id: "p1", title: "Terminal 3" }]);
    expect(out).toEqual([{ id: "p1", name: "Terminal 3", label: "Terminal 3", agent: false }]);
  });

  it("ignores a title that merely looks like a role", () => {
    const [t] = chatTargets([{ id: "p1", title: "coordinator", role: "builder-2" }]);
    expect(t.name).toBe("builder-2");
  });

  it("drops a pane with neither a role nor a usable title", () => {
    expect(chatTargets([{ id: "p1", title: "   " }])).toEqual([]);
  });

  // brain-findings 1.3: two same-titled shells both matched one @name, so one typed
  // message started two turns and charged the budget twice under a single key.
  it("dedupes same-titled shells, case-insensitively, so one address is one pane", () => {
    const out = chatTargets([
      { id: "p1", title: "Terminal 1" },
      { id: "p2", title: "terminal 1" },
      { id: "p3", title: "Terminal 2" },
    ]);
    expect(out.map((t) => t.id)).toEqual(["p1", "p3"]); // first pane wins
  });
});

describe("resolveTargets", () => {
  const panes = chatTargets([
    { id: "c", title: "coordinator", role: "coordinator" },
    { id: "b1", title: "builder-1", role: "builder-1" },
    { id: "h", title: "Terminal 3" },
    { id: "h2", title: "Terminal 3" }, // a second shell with the same title
  ]);

  // brain-findings 1.3: @all used to reach the human's OWN shells — it woke nothing
  // there, ate a turn slot under the shell's cosmetic title, and interrupted whatever
  // the human was running in it.
  it("broadcasts to role panes only, never to a role-less human shell", () => {
    expect(resolveTargets(panes, "all").map((t) => t.name)).toEqual(["coordinator", "builder-1"]);
  });

  it("still reaches a human shell by its own @title — once", () => {
    expect(resolveTargets(panes, "Terminal 3").map((t) => t.id)).toEqual(["h"]);
  });

  it("matches an address case-insensitively and reaches exactly one pane", () => {
    expect(resolveTargets(panes, "BUILDER-1").map((t) => t.id)).toEqual(["b1"]);
    expect(resolveTargets(panes, "builder-9")).toEqual([]);
  });
});

describe("routeDraft", () => {
  // brain-findings 1.3: a plain Agents-tab send was a BROADCAST, so one line was read
  // into every pane's next turn. Narrow is the default; a broadcast is typed on purpose.
  it("sends a plain Agents-tab line to the coordinator, not to everyone", () => {
    expect(routeDraft("agents", "why is task-4 stuck?")).toEqual({ target: "coordinator", body: "why is task-4 stuck?" });
  });

  it("broadcasts only when the human explicitly types @all", () => {
    expect(routeDraft("agents", "@all stop what you are doing")).toEqual({ target: "all", body: "stop what you are doing" });
  });

  it("narrows to one role on @role", () => {
    expect(routeDraft("agents", "@builder-2 rebase on master first")).toEqual({ target: "builder-2", body: "rebase on master first" });
  });

  it("keeps a leading @foo as text on the Coordinator tab, where @-routing does not apply", () => {
    expect(routeDraft("coordinator", "@all hands mission update")).toEqual({ target: "coordinator", body: "@all hands mission update" });
  });

  it("is null for an empty draft", () => {
    expect(routeDraft("agents", "   ")).toBeNull();
    expect(routeDraft("coordinator", "")).toBeNull();
  });
});

describe("chatChannel", () => {
  it("puts the human<->coordinator axis on the Coordinator tab", () => {
    expect(chatChannel({ sender: "human", to: "coordinator" })).toBe("coordinator");
    expect(chatChannel({ sender: "human", to: undefined })).toBe("coordinator"); // human default target
    expect(chatChannel({ sender: "coordinator", to: "human" })).toBe("coordinator");
  });

  it("keeps agent coordination — including the coordinator relaying to builders — on the Agents tab", () => {
    expect(chatChannel({ sender: "coordinator", to: "builder-1" })).toBe("agents");
    expect(chatChannel({ sender: "coordinator", to: "all" })).toBe("agents");
    expect(chatChannel({ sender: "builder-1", to: "coordinator" })).toBe("agents");
    expect(chatChannel({ sender: "reviewer-1", to: "all" })).toBe("agents");
    expect(chatChannel({ sender: "human", to: "builder-2" })).toBe("agents"); // human @-routed a specific agent
  });

  it("treats an untagged coordinator note as chatter, so a forgotten 'to: human' cannot flood the human tab", () => {
    expect(chatChannel({ sender: "coordinator", to: undefined })).toBe("agents");
  });
});

describe("parseAsk", () => {
  it("parses a multiple-choice ask with an optional free box", () => {
    const a = parseAsk({ key: "ask-3", value: "ask: Ship it?\noption: Yes\noption: No\nfree: 1", updated: 5 });
    expect(a).toEqual({ key: "ask-3", n: 3, question: "Ship it?", options: ["Yes", "No"], free: true, updated: 5 });
  });

  it("forces a free-text box when there are no options, so an ask is always answerable", () => {
    const a = parseAsk({ key: "ask-1", value: "ask: What should the title say?", updated: 0 });
    expect(a?.options).toEqual([]);
    expect(a?.free).toBe(true);
  });

  it("honours an explicit 'free: 0' to make a strict multiple choice", () => {
    const a = parseAsk({ key: "ask-2", value: "ask: Pick one\noption: A\noption: B\nfree: 0", updated: 0 });
    expect(a?.free).toBe(false);
  });

  it("rejects non-ask keys and a note with no question", () => {
    expect(parseAsk({ key: "ask-answer-1", value: "option: Yes", updated: 0 })).toBeNull();
    expect(parseAsk({ key: "task-5", value: "ask the human", updated: 0 })).toBeNull();
    expect(parseAsk({ key: "ask-9", value: "option: Yes\noption: No", updated: 0 })).toBeNull();
  });
});

describe("parseAnswer", () => {
  it("reads the option and/or free text back out", () => {
    expect(parseAnswer({ key: "ask-answer-3", value: "option: Yes" })).toEqual({ n: 3, text: "Yes" });
    expect(parseAnswer({ key: "ask-answer-4", value: "option: Other\ntext: do it later" })).toEqual({ n: 4, text: "Other — do it later" });
  });

  it("ignores non-answer keys", () => {
    expect(parseAnswer({ key: "ask-3", value: "ask: q" })).toBeNull();
  });
});

describe("askAnswerBody", () => {
  it("labels the option and free text on their own lines", () => {
    expect(askAnswerBody("Yes", "")).toBe("option: Yes");
    expect(askAnswerBody("", "later please")).toBe("text: later please");
    expect(askAnswerBody("Other", "next week")).toBe("option: Other\ntext: next week");
  });

  it("is empty when the human supplied neither, so the form refuses to submit", () => {
    expect(askAnswerBody("", "  ")).toBe("");
  });
});

describe("askAnswerNudge", () => {
  // The note alone never woke the coordinator, which is what made a working form look
  // broken. The nudge is the message that actually starts its turn, so it has to name
  // the ask AND carry the choice inline.
  it("names the ask and repeats the choice", () => {
    expect(askAnswerNudge(1, "Both")).toBe("answered ask-1: Both (full answer in note ask-answer-1)");
  });

  it("survives injection folding, so a real option reaches the pane intact", () => {
    const shown = "Both — updater fix first (fast unblock), then the flagship.";
    const text = toInjectable(askAnswerNudge(1, shown));
    expect(isInjectable(text)).toBe(true);
    expect(text).toContain("ask-1");
    expect(text).toContain("Both - updater fix first (fast unblock)");
  });
});
