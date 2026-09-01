import { useCallback, useEffect, useState } from "react";
import {
  licenseActivate,
  licenseDeactivate,
  licensePortal,
  licenseRefresh,
  licenseStatus,
  type LicenseStatus,
} from "../lib/ipc";
import { field, label as labelStyle, row as rowStyle } from "../lib/uiStyles";

// Licensing settings — the "License" category of SettingsModal, modelled on the
// Software update section next to it (one row per action, muted sub-lines under
// the label, `field` styling on every button).
//
// HARD RULE for everything below: the user never sees a status enum, a Rust
// error, or a stack trace. `licenseView()` and `friendlyError()` are the only
// two places that produce user-facing text, they are pure, and the tests drive
// every state through them — the component itself only wires them to buttons.

export type Tone = "ok" | "warn" | "muted";

export interface LicenseView {
  headline: string;
  detail: string;
  tone: Tone;
  /** Show the key entry field + Activate button. */
  showKeyInput: boolean;
  /** "Check now" needs a key already stored on this install. */
  canCheck: boolean;
  canDeactivate: boolean;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "28 July 2026" from unix seconds. Deliberately UTC and hand-formatted: the
 * server's periods are UTC, and a locale-dependent date would make this
 * component's tests pass or fail depending on the machine's timezone.
 */
export function formatDate(unix: number | null | undefined): string {
  if (unix == null || !isFinite(unix) || unix <= 0) return "";
  const d = new Date(unix * 1000);
  if (isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The plan name rides on the Paddle price's custom_data, so it can legitimately
 * be missing or something we have never heard of. Never print the raw value
 * back at the user when we cannot name it.
 */
export function planLabel(plan: string | null | undefined): string {
  switch ((plan ?? "").trim().toLowerCase()) {
    case "monthly": return "Monthly";
    case "yearly": return "Yearly";
    case "": return "PixelMarch Pro";
    default: return "PixelMarch Pro";
  }
}

// `offline` means "the last refresh did not complete". It is NOT proof the
// network is down — license.rs records a 403 (not entitled) and a 404 (unknown
// key) the same way — so the wording must not claim a network failure.
const STALE = "The last check with the license server did not complete, so this may be out of date.";

/** Everything the panel renders, derived from the backend status. Pure. */
export function licenseView(s: LicenseStatus | null): LicenseView {
  if (!s) {
    return {
      headline: "Checking your license…",
      detail: "",
      tone: "muted",
      showKeyInput: false,
      canCheck: false,
      canDeactivate: false,
    };
  }

  const on = formatDate(s.expires_at);
  const hasKey = !!s.license_key;
  const base = {
    showKeyInput: !s.licensed,
    canCheck: hasKey,
    canDeactivate: hasKey,
  };

  let headline: string;
  let detail: string;
  let tone: Tone;

  switch (s.state) {
    case "active":
      headline = `Active — ${planLabel(s.plan)}`;
      detail = on ? `Your subscription renews on ${on}.` : "Your subscription is up to date.";
      tone = "ok";
      break;
    case "trialing":
      headline = `Trial — ${planLabel(s.plan)}`;
      detail = on
        ? `You are on a free trial until ${on}. Billing starts after that.`
        : "You are on a free trial.";
      tone = "ok";
      break;
    case "past_due":
      // The point of this state: access is still ON. Saying "active" would hide
      // a payment the user needs to fix; saying "expired" would be a lie.
      headline = "We could not take payment";
      detail = on
        ? `Your last payment did not go through. PixelMarch keeps working until ${on} — update your payment details before then to keep it.`
        : "Your last payment did not go through. PixelMarch keeps working for now — update your payment details to keep it.";
      tone = "warn";
      break;
    case "canceled":
      headline = "Canceled — access continues";
      detail = on
        ? `Your subscription is canceled and will not renew. You keep PixelMarch until ${on}.`
        : "Your subscription is canceled and will not renew. You keep PixelMarch until the end of the paid period.";
      tone = "warn";
      break;
    case "expired":
      headline = "Your license has run out";
      detail = on
        ? `Access ended on ${on}. Renew your subscription, then use Check now.`
        : "Access has ended. Renew your subscription, then use Check now.";
      tone = "warn";
      break;
    case "unlicensed":
      headline = "Not activated";
      detail = "Paste the license key from your purchase confirmation to activate PixelMarch on this install.";
      tone = "muted";
      break;
    // "invalid", plus anything a future backend adds: the stored license did not
    // verify (edited file, or a build carrying the wrong signing key). Do not
    // pretend it is merely unlicensed — that hides a real problem — but do not
    // show the enum either.
    default:
      headline = "We could not verify the license on this install";
      detail = "Use Check now to fetch it again, or re-enter your license key below.";
      tone = "warn";
      // An unverifiable license must always be re-enterable, even though a key
      // is on disk.
      base.showKeyInput = true;
      break;
  }

  if (s.offline) detail = detail ? `${detail} ${STALE}` : STALE;

  return { headline, detail, tone, ...base };
}

// Messages license.rs already phrases for a human. Anything else (an IO error,
// a path, a panic string) is replaced wholesale — a user must never be shown a
// filesystem path or a Rust error, and a message we do not recognise could be
// either.
const KNOWN_ERRORS = [
  "do not recognise that licence key",
  "not currently active",
  "could not reach the licence server",
  "licence server is having trouble",
  "licence server sent a reply we could not read",
  "licence server sent a token we could not verify",
  "licence server issued an already-expired token",
  "enter your licence key first",
  "no licence is activated on this install",
  "refusing to send a licence key over an unauthenticated connection",
];

const GENERIC_ERROR =
  "Something went wrong activating that license. Check the key and your internet connection, then try again.";

/** Turn a rejected invoke into one sentence a customer can act on. Pure. */
export function friendlyError(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const text = raw.trim();
  if (!text) return GENERIC_ERROR;
  const lower = text.toLowerCase();
  const known = KNOWN_ERRORS.some((k) => lower.includes(k));
  if (!known) return GENERIC_ERROR;
  // Backend messages are lower-case fragments; present them as a sentence, keep
  // the "--" it uses for asides readable, and spell it the way the rest of the
  // product does (license.rs and the swarm notes use the British "licence"; the
  // site, the legal docs and this panel use "license" — the user must see one
  // spelling, and license.rs belongs to another task).
  const sentence = text.replace(/\s--\s/g, " — ").replace(/licence/g, "license").replace(/Licence/g, "License");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + (/[.!?]$/.test(sentence) ? "" : ".");
}

// Customer portal. There is no URL on this side to link to: `license_portal`
// fetches a session URL with a bearer token in it and hands it straight to the
// browser from Rust, so the only question the UI gets to ask is whether to draw
// the button at all.
//
// past_due deliberately counts as licensed here — a lapsed card is exactly the
// case where someone needs the portal most, and hiding it would strand them.
export function canManageSubscription(status: LicenseStatus | null): boolean {
  return !!status?.licensed && !!status.license_key;
}

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--text)",
  warn: "#e0b46c",
  muted: "var(--muted)",
};

export default function LicenseCategory() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  // license_status can block on a network round trip (up to 15s when the server
  // is unreachable), so it is fetched once here behind the "Checking…" headline
  // rather than on every render.
  const [busy, setBusy] = useState(true);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: Tone } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await licenseStatus());
    } catch (e) {
      setMsg({ text: friendlyError(e), tone: "warn" });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (op: () => Promise<LicenseStatus>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await op());
      setMsg({ text: ok, tone: "ok" });
    } catch (e) {
      setMsg({ text: friendlyError(e), tone: "warn" });
    } finally {
      setBusy(false);
    }
  }, []);

  // Separate from `run` because this one returns no LicenseStatus — the portal
  // URL never crosses into JS, so there is nothing to fold back into state.
  const openPortal = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      await licensePortal();
      setMsg({ text: "Opened your billing portal in your browser.", tone: "ok" });
    } catch (e) {
      setMsg({ text: friendlyError(e), tone: "warn" });
    } finally {
      setBusy(false);
    }
  }, []);

  const view = licenseView(busy && !status ? null : status);
  const portal = canManageSubscription(status);

  return (
    <>
      <div style={{ ...rowStyle, borderBottom: "none", alignItems: "flex-start" }}>
        <span style={labelStyle}>
          <span style={{ color: TONE_COLOR[view.tone], fontSize: 12.5, display: "block" }}>{view.headline}</span>
          {view.detail && (
            <span style={{ color: "var(--muted)", fontSize: 10, display: "block", marginTop: 2 }}>{view.detail}</span>
          )}
          {msg && (
            <span style={{ color: msg.tone === "warn" ? "#e06c6c" : "var(--muted)", fontSize: 10, display: "block", marginTop: 4 }}>
              {msg.text}
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => void run(licenseRefresh, "License re-checked.")}
            disabled={busy || !view.canCheck}
            style={{ ...field, cursor: busy || !view.canCheck ? "not-allowed" : "pointer", opacity: busy || !view.canCheck ? 0.5 : 1 }}
          >
            Check now
          </button>
          {view.canDeactivate && (
            <button
              onClick={() => void run(licenseDeactivate, "License removed from this install.")}
              disabled={busy}
              style={{ ...field, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}
            >
              Deactivate
            </button>
          )}
        </div>
      </div>

      {view.showKeyInput && (
        <div style={{ ...rowStyle, borderBottom: "none" }}>
          <span style={labelStyle}>License key</span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <input
              style={{ ...field, width: 240, fontFamily: "monospace" }}
              placeholder="PM-XXXX-XXXX-XXXX"
              value={key}
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) void run(() => licenseActivate(key), "License activated."); }}
            />
            <button
              onClick={() => void run(() => licenseActivate(key), "License activated.")}
              disabled={busy || !key.trim()}
              style={{ ...field, cursor: busy || !key.trim() ? "not-allowed" : "pointer", background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", opacity: busy || !key.trim() ? 0.5 : 1 }}
            >
              Activate
            </button>
          </div>
        </div>
      )}

      {status?.licensed && status.license_key && (
        <div style={{ ...rowStyle, borderBottom: "none" }}>
          <span style={labelStyle}>License key</span>
          <code style={{ fontSize: 11, color: "var(--muted)" }}>{status.license_key}</code>
        </div>
      )}

      {portal && (
        <div style={{ ...rowStyle, borderBottom: "none" }}>
          <span style={labelStyle}>
            Subscription
            <span style={{ color: "var(--muted)", fontSize: 10, display: "block" }}>
              Update your card, download invoices, or cancel.
            </span>
          </span>
          <button
            onClick={openPortal}
            disabled={busy}
            style={{ ...field, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            Manage subscription
          </button>
        </div>
      )}

      <p style={{ marginTop: 14, fontSize: 11, color: "var(--muted)" }}>
        Your license is stored in the app's <code>data/</code> folder, so it travels with this install.
        PixelMarch checks it with the license server at most once an hour, and only near expiry —
        it keeps working while that check fails.
      </p>
    </>
  );
}
