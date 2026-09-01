import { describe, expect, it, vi } from "vitest";
import type { LicenseStatus } from "../lib/ipc";

// LicenseSettings pulls in @tauri-apps/api through lib/ipc at import time;
// nothing below invokes it (same stub as SwarmDialog.test.ts).
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const { canManageSubscription, formatDate, friendlyError, licenseView, planLabel } =
  await import("./LicenseSettings");

// Expiry timestamps and their expected rendering come from `date -u`, not from
// running formatDate:
//   date -u -d @1790000000 "+%-d %B %Y"  ->  21 September 2026
//   date -u -d @1767225600 "+%-d %B %Y"  ->  1 January 2026
//   date -u -d @1735689600 "+%-d %B %Y"  ->  1 January 2025
const EXP = 1790000000;
const EXP_TEXT = "21 September 2026";

const status = (p: Partial<LicenseStatus>): LicenseStatus => ({
  licensed: false,
  state: "unlicensed",
  status: null,
  plan: null,
  expires_at: null,
  license_key: null,
  last_check: null,
  offline: false,
  device_id: null,
  ...p,
});

const licensed = (state: string, p: Partial<LicenseStatus> = {}) =>
  status({ licensed: true, state, status: state, plan: "monthly", expires_at: EXP, license_key: "PM-AAAA-BBBB-CCCC", ...p });

describe("formatDate", () => {
  it("renders UTC dates in a fixed, locale-independent form", () => {
    expect(formatDate(EXP)).toBe(EXP_TEXT);
    expect(formatDate(1767225600)).toBe("1 January 2026");
    expect(formatDate(1735689600)).toBe("1 January 2025");
  });

  it("has nothing to say about a missing or nonsense expiry", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate(0)).toBe("");
    expect(formatDate(-5)).toBe("");
    expect(formatDate(NaN)).toBe("");
  });
});

describe("planLabel", () => {
  it("names the two catalog plans", () => {
    expect(planLabel("monthly")).toBe("Monthly");
    expect(planLabel("yearly")).toBe("Yearly");
  });

  // The plan rides on the Paddle price's custom_data, so it can be absent or a
  // value we have never heard of. Neither may reach the user verbatim.
  it("never prints an unknown plan back at the user", () => {
    expect(planLabel(null)).toBe("PixelMarch Pro");
    expect(planLabel("")).toBe("PixelMarch Pro");
    expect(planLabel("enterprise_seat_v2")).toBe("PixelMarch Pro");
  });
});

describe("licenseView", () => {
  it("says it is still working while the status is being fetched", () => {
    const v = licenseView(null);
    expect(v.headline).toBe("Checking your license…");
    expect(v.showKeyInput).toBe(false);
    expect(v.canCheck).toBe(false);
  });

  it("asks an unlicensed install for a key, with nothing to check or remove", () => {
    const v = licenseView(status({}));
    expect(v.headline).toBe("Not activated");
    expect(v.detail).toMatch(/license key/i);
    expect(v.showKeyInput).toBe(true);
    expect(v.canCheck).toBe(false);
    expect(v.canDeactivate).toBe(false);
  });

  it("shows an active subscription with its plan and renewal date", () => {
    const v = licenseView(licensed("active"));
    expect(v.headline).toBe("Active — Monthly");
    expect(v.detail).toBe(`Your subscription renews on ${EXP_TEXT}.`);
    expect(v.tone).toBe("ok");
    expect(v.showKeyInput).toBe(false);
    expect(v.canCheck).toBe(true);
    expect(v.canDeactivate).toBe(true);
  });

  it("calls a trial a trial and says when billing starts", () => {
    const v = licenseView(licensed("trialing", { plan: "yearly" }));
    expect(v.headline).toBe("Trial — Yearly");
    expect(v.detail).toContain(`free trial until ${EXP_TEXT}`);
    expect(v.tone).toBe("ok");
  });

  // The whole point of past_due: access is still on, and the user has something
  // to fix. Rendering it as plain "active" would hide the second half.
  it("explains past_due as a payment problem with access continuing", () => {
    const v = licenseView(licensed("past_due"));
    expect(v.headline).toBe("We could not take payment");
    expect(v.detail).toContain(`keeps working until ${EXP_TEXT}`);
    expect(v.detail).toMatch(/payment details/i);
    expect(v.tone).toBe("warn");
    expect(v.showKeyInput).toBe(false);
  });

  it("tells a canceled-but-still-valid subscriber how long they keep it", () => {
    const v = licenseView(licensed("canceled"));
    expect(v.headline).toBe("Canceled — access continues");
    expect(v.detail).toContain(`until ${EXP_TEXT}`);
    expect(v.detail).toMatch(/will not renew/i);
    expect(v.tone).toBe("warn");
    expect(v.showKeyInput).toBe(false);
  });

  // Expired keeps the stored key: the user may have just renewed, and Check now
  // is the way back.
  it("offers both re-check and re-entry when the license has run out", () => {
    const v = licenseView(status({ state: "expired", expires_at: EXP, license_key: "PM-AAAA-BBBB-CCCC" }));
    expect(v.headline).toBe("Your license has run out");
    expect(v.detail).toContain(`Access ended on ${EXP_TEXT}`);
    expect(v.showKeyInput).toBe(true);
    expect(v.canCheck).toBe(true);
    expect(v.tone).toBe("warn");
  });

  it("distinguishes an unverifiable license from an absent one", () => {
    const v = licenseView(status({ state: "invalid", license_key: "PM-AAAA-BBBB-CCCC" }));
    expect(v.headline).not.toBe("Not activated");
    expect(v.headline).toMatch(/could not verify/i);
    expect(v.showKeyInput).toBe(true);
    expect(v.canCheck).toBe(true);
  });

  // A state the backend grows later must still render as something safe.
  it("falls back to the unverifiable wording for an unknown state", () => {
    const v = licenseView(status({ state: "suspended_pending_review" }));
    expect(v.headline).toMatch(/could not verify/i);
    expect(v.detail).not.toContain("suspended_pending_review");
  });

  // "Canceled" is ordinary English and stays; the machine-only spellings must
  // never reach the user.
  it("never leaks the state enum or the raw status into what the user reads", () => {
    for (const state of ["unlicensed", "active", "trialing", "past_due", "canceled", "expired", "invalid"]) {
      const v = licenseView(status({ licensed: state === "active", state, status: state, expires_at: EXP }));
      expect(`${v.headline} ${v.detail}`).not.toMatch(/[a-z]+_[a-z]+|unlicensed|trialing|invalid/);
    }
  });

  // license.rs sets `offline` for a 403 and a 404 too, not just an unreachable
  // server, so the note must not claim the network is down.
  it("adds a stale-check note without claiming the network failed", () => {
    const v = licenseView(licensed("active", { offline: true }));
    expect(v.detail).toContain(`renews on ${EXP_TEXT}`);
    expect(v.detail).toContain("did not complete");
    expect(v.detail).not.toMatch(/could not reach|no internet|offline/i);
  });

  it("still works when the token carries no expiry", () => {
    for (const state of ["active", "trialing", "past_due", "canceled", "expired"]) {
      const v = licenseView(status({ licensed: state !== "expired", state, expires_at: null, license_key: "K" }));
      expect(v.detail).not.toContain("undefined");
      expect(v.detail).not.toContain(" on .");
      expect(v.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("friendlyError", () => {
  // These strings are the ones license.rs actually produces (validate_remote and
  // refresh_in), copied from that file — not invented here.
  // Passed through as sentences, and respelled: license.rs writes "licence",
  // the site and legal docs write "license", and the user must see one spelling.
  it("passes through the backend's human-phrased messages as sentences", () => {
    expect(friendlyError("we do not recognise that licence key -- check it for typos"))
      .toBe("We do not recognise that license key — check it for typos.");
    expect(friendlyError("that licence is not currently active"))
      .toBe("That license is not currently active.");
    expect(friendlyError("could not reach the licence server"))
      .toBe("Could not reach the license server.");
    expect(friendlyError("enter your licence key first")).toBe("Enter your license key first.");
  });

  it("keeps an Error object's message when it is one of ours", () => {
    expect(friendlyError(new Error("no licence is activated on this install")))
      .toBe("No license is activated on this install.");
  });

  // Anything we do not recognise could be an IO error, a path, or a panic —
  // never show it.
  it("replaces anything it does not recognise", () => {
    const generic = friendlyError("boom");
    expect(generic).toMatch(/^Something went wrong/);
    expect(friendlyError("write /home/u/pixelmarch/license.json.tmp: Permission denied (os error 13)")).toBe(generic);
    expect(friendlyError(new Error("Cannot read properties of undefined (reading 'token')"))).toBe(generic);
    expect(friendlyError({ some: "object" })).toBe(generic);
    expect(friendlyError(undefined)).toBe(generic);
    expect(friendlyError("")).toBe(generic);
  });

  it("never returns a path, a stack frame, or an os error code", () => {
    for (const raw of [
      "write /tmp/x/license.json.tmp: Permission denied (os error 13)",
      "Error: invoke failed\n    at Object.invoke (/app/dist/index.js:12:9)",
      "C:\\builds\\pixelmarch\\license.json",
    ]) {
      const out = friendlyError(raw);
      expect(out).not.toMatch(/[/\\]|os error|\bat \b/);
    }
  });
});

describe("canManageSubscription", () => {
  it("offers the portal to a licensed install", () => {
    expect(canManageSubscription(licensed("active"))).toBe(true);
  });

  // Whoever's card just failed is precisely who needs to reach the portal, so
  // past_due must NOT be filtered out on its way to the billing screen.
  it("still offers it when the card has failed", () => {
    expect(canManageSubscription(licensed("past_due"))).toBe(true);
  });

  it("hides it from anyone with nothing to manage", () => {
    expect(canManageSubscription(status({}))).toBe(false);
    expect(canManageSubscription(null)).toBe(false);
  });

  // license_portal reads the key from the cache file; without one the command
  // can only fail, so the button would be a dead end.
  it("hides it when there is no key to trade for a session", () => {
    expect(canManageSubscription(licensed("active", { license_key: null }))).toBe(false);
  });
});
