//! Licensing client: offline verification of Ed25519 entitlement tokens.
//!
//! The server (`server/src/token.rs`) signs a small claims blob; this module is
//! the port of its `verify()` into the app. That file is the executable
//! specification of the format -- if the two ever disagree, it wins.
//!
//! Two properties matter more than anything else here:
//!
//!   * **The signature is checked before the payload is parsed.** The token
//!     arrives from disk or from the network, both of which an attacker can
//!     write to. Deserialising it first and checking afterwards is how
//!     "verified" code paths end up not being.
//!   * **A failed network call never revokes access.** The whole reason the
//!     entitlement is signed is so an outage at api.pixelmarch.io is not an
//!     outage for people who have paid. Refreshing is best-effort; a cached
//!     token that still verifies and has not expired grants access, full stop.
//!
//! The format is deliberately JWT-shaped but not JWT: `b64url(payload).b64url(sig)`,
//! URL-safe, unpadded, and with no algorithm header -- so there is no `alg: none`
//! to confuse and no algorithm agility to get wrong.
//!
//! ## Where the token lives
//!
//! Next to the executable, like everything else this app persists (see
//! `state.rs`). PixelMarch ships as a single portable exe; an entitlement in
//! `~/.config` or `%APPDATA%` would not travel with the binary, so moving the
//! folder to another machine would silently drop the licence.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The signing key's public half, baked in at compile time. Public by design --
/// it can only be used to *check* tokens, never to mint them.
const PUBLIC_KEY: &str = "mNDa5TsTfrU9zGae2i1tR6XRBbnIozVFdFcSrhvq3z0";

/// The same constant, readable by `update.rs`'s test that the two signing keys are
/// not the same key. Test-only: nothing in the app should reach across for it.
#[cfg(test)]
pub(crate) const PUBLIC_KEY_FOR_TESTS: &str = PUBLIC_KEY;

/// Cached entitlement, in the profile (portable install, see module docs).
const CACHE_FILE: &str = "license.json";
/// The per-install device id, kept in its own file so `license_deactivate`
/// (which deletes the cache) does not churn it.
const DEVICE_FILE: &str = "device-id";

const DEFAULT_API_BASE: &str = "https://api.pixelmarch.io";

/// Start trying to renew this long before `exp`. The server issues 7-day
/// tokens, so a day of slack is many launches' worth of chances to get online.
const REFRESH_WINDOW_SECS: i64 = 24 * 60 * 60;
/// Do not re-attempt a refresh more often than this. Without it, a UI that
/// polls `license_status` would hammer the server (and stall on connect
/// timeouts) once inside the refresh window.
const REFRESH_COOLDOWN_SECS: i64 = 60 * 60;

const NET_TIMEOUT: Duration = Duration::from_secs(15);

// --------------------------------------------------------------- the token --

/// Mirror of `server/src/token.rs::Claims`. Field order matters: the server
/// signs exactly the bytes `serde_json` produces for this struct, so a
/// re-serialisation here would not round-trip. We never re-serialise -- the
/// payload is verified as received.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub lic: String,
    pub plan: String,
    pub status: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    BadSignature,
    Expired { exp: i64, now: i64 },
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed => write!(f, "token is malformed"),
            Self::BadSignature => write!(f, "token signature is invalid"),
            Self::Expired { exp, now } => write!(f, "token expired at {exp} (now {now})"),
        }
    }
}

/// Port of `server/src/token.rs::verify`. Kept structurally identical to it on
/// purpose -- this is the one function in the app whose behaviour has to match
/// another codebase byte for byte.
pub fn verify(token: &str, key: &VerifyingKey, now: i64) -> Result<Claims, VerifyError> {
    let (payload_b64, sig_b64) = token.split_once('.').ok_or(VerifyError::Malformed)?;

    let payload = B64.decode(payload_b64).map_err(|_| VerifyError::Malformed)?;
    let sig_bytes = B64.decode(sig_b64).map_err(|_| VerifyError::Malformed)?;
    let sig_array: [u8; 64] = sig_bytes.try_into().map_err(|_| VerifyError::Malformed)?;

    // Signature first, always. Nothing below may look at the payload until we
    // know the server produced it.
    key.verify(&payload, &Signature::from_bytes(&sig_array))
        .map_err(|_| VerifyError::BadSignature)?;

    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| VerifyError::Malformed)?;

    if now > claims.exp {
        return Err(VerifyError::Expired { exp: claims.exp, now });
    }

    Ok(claims)
}

/// The baked-in verifying key. Fallible rather than a `lazy_static` panic: a
/// build with a mangled constant should refuse to grant a licence, not abort
/// the app on launch.
fn public_key() -> Result<VerifyingKey, String> {
    let bytes = B64
        .decode(PUBLIC_KEY)
        .map_err(|e| format!("baked-in public key is not valid base64url: {e}"))?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "baked-in public key is not 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("baked-in public key is not on the curve: {e}"))
}

// ------------------------------------------------------------- disk + state --

/// What we keep on disk. The token carries plan/status/expiry already, so
/// nothing here duplicates it -- a mismatch between the two would just be a
/// second source of truth to get wrong.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Cache {
    license_key: String,
    token: String,
    /// Unix seconds of the last refresh *attempt* (successful or not). Drives
    /// the cooldown, not entitlement.
    #[serde(default)]
    last_check: i64,
}

/// Coarse state for the UI, derived from the token. Deliberately not the raw
/// Paddle status string: `past_due` still grants access during its grace
/// window, and the UI needs to know that without re-implementing the rules.
#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatus {
    /// The only field that decides whether paid features are on.
    pub licensed: bool,
    /// "unlicensed" | "active" | "trialing" | "past_due" | "canceled" | "expired" | "invalid"
    pub state: String,
    /// Raw subscription status from the token, when there is one.
    pub status: Option<String>,
    pub plan: Option<String>,
    /// Unix seconds; when access lapses unless renewed.
    pub expires_at: Option<i64>,
    pub license_key: Option<String>,
    pub last_check: Option<i64>,
    /// The last refresh attempt failed. Access is unaffected -- this is for
    /// telling the user why the expiry date is not moving.
    pub offline: bool,
    pub device_id: Option<String>,
}

impl LicenseStatus {
    fn unlicensed() -> Self {
        Self {
            licensed: false,
            state: "unlicensed".into(),
            status: None,
            plan: None,
            expires_at: None,
            license_key: None,
            last_check: None,
            offline: false,
            device_id: None,
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache_path(dir: &Path) -> PathBuf {
    dir.join(CACHE_FILE)
}

/// A missing or unreadable cache is "not licensed", never an error: a fresh
/// unzip has no cache, and a corrupt one should not wedge the app.
fn read_cache(dir: &Path) -> Option<Cache> {
    let raw = std::fs::read_to_string(cache_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Atomic tmp-then-rename, same as `state.rs`: a crash mid-write must not leave
/// a half-written entitlement behind.
fn write_cache(dir: &Path, cache: &Cache) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{CACHE_FILE}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, cache_path(dir)).map_err(|e| e.to_string())
}

/// Stable per install, and deliberately *not* derived from anything that
/// identifies the machine or its owner. A hardware serial or a hostname would
/// leave the server holding a fingerprint it has no business having; a random
/// id written once tells it only "the same install as last time", which is all
/// seat counting ever needs. It lives in the profile, so it travels with the
/// portable folder exactly like the licence does.
fn device_id(dir: &Path) -> Result<String, String> {
    let path = dir.join(DEVICE_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::write(&path, &id).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(id)
}

// ------------------------------------------------------------------ network --

/// Resolve the licence service base. Same rule as `update.rs`'s `pick_base`, and for the
/// same reason: this URL is where a licence key (a bearer credential) gets sent and where
/// the entitlement answer comes back from, so redirecting it is both credential theft and
/// a licence bypass. The process environment is attacker input on a machine we do not
/// control, so NO build reads it — the only override is the value compiled into the
/// binary (`PIXELMARCH_LICENSE_URL=https://… cargo build --release`), and otherwise
/// `DEFAULT_API_BASE`.
///
/// Split from `api_base` so the precedence is testable without touching the environment.
fn pick_api_base(baked: Option<&str>) -> String {
    let clean = |v: &str| {
        let v = v.trim();
        (!v.is_empty()).then(|| v.to_string())
    };
    baked.and_then(clean).unwrap_or_else(|| DEFAULT_API_BASE.to_string())
}

/// Where the licence service lives: the compile-time bake if there was one, else the
/// vendor default. `PIXELMARCH_LICENSE_URL` in the process environment is ignored by
/// every build; the e2e harness aims the client with `PIXELMARCH_E2E_BASE`, which is
/// `#[cfg(test)]` and so is not compiled into any shipped binary at all. Whatever comes
/// out still has to clear `guard_url`, which refuses plain HTTP off loopback.
fn api_base() -> String {
    pick_api_base(option_env!("PIXELMARCH_LICENSE_URL"))
}

/// A licence key is a bearer credential, so it must not travel in clear text.
/// Loopback is exempt (it never leaves the machine) so the e2e harness can
/// point the app at a local server.
fn guard_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if lower.starts_with("http://") && is_loopback_host(&lower) {
        return Ok(());
    }
    Err(format!(
        "refusing to send a licence key over an unauthenticated connection ({url}): use HTTPS"
    ))
}

/// The host must *parse* as a loopback address (or be exactly `localhost`).
/// A prefix test would wave through `127.evil.com`, which resolves off-box.
fn is_loopback_host(url: &str) -> bool {
    use std::net::IpAddr;
    let after = url.split("://").nth(1).unwrap_or(url);
    let authority = after.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

#[derive(Deserialize)]
struct ValidateResponse {
    token: String,
}

/// Ask the server for a fresh token. Errors are already phrased for a human --
/// the UI must never have to show a status enum or a transport error.
fn validate_remote(base: &str, license_key: &str, device: &str) -> Result<String, String> {
    let url = format!("{}/v1/license/validate", base.trim_end_matches('/'));
    guard_url(&url)?;

    let resp = ureq::post(&url)
        .timeout(NET_TIMEOUT)
        .send_json(ureq::json!({ "license_key": license_key, "device_id": device }));

    match resp {
        Ok(r) => {
            let body: ValidateResponse = r
                .into_json()
                .map_err(|_| "the licence server sent a reply we could not read".to_string())?;
            Ok(body.token)
        }
        Err(ureq::Error::Status(404, _)) => {
            Err("we do not recognise that licence key -- check it for typos".into())
        }
        Err(ureq::Error::Status(403, _)) => {
            Err("that licence is not currently active".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("the licence server is having trouble (error {code}) -- try again shortly"))
        }
        Err(_) => Err("could not reach the licence server".into()),
    }
}

#[derive(Deserialize)]
struct PortalResponse {
    url: String,
}

/// Trade the licence key for a Paddle customer-portal session URL.
///
/// Same `guard_url` as `validate_remote`: the licence key is a bearer credential
/// on the way out, and the URL that comes back is another one on the way in, so
/// neither may cross plain HTTP. Note this deliberately does NOT reuse
/// `update.rs`'s guard -- that one has a compile-time `PIXELMARCH_ALLOW_HTTP_UPDATE`
/// escape hatch for LAN update servers, and a build that set that flag for the
/// updater must not silently start leaking licence keys too.
///
/// Every status the server can answer with is mapped to a sentence a person can
/// act on. 503 in particular is not a fault: the portal is switched off whenever
/// the service has no Paddle API key, and everything else keeps working.
fn portal_url_remote(base: &str, license_key: &str) -> Result<String, String> {
    let url = format!("{}/v1/portal", base.trim_end_matches('/'));
    guard_url(&url)?;

    let resp = ureq::post(&url)
        .timeout(NET_TIMEOUT)
        .send_json(ureq::json!({ "license_key": license_key }));

    match resp {
        Ok(r) => {
            let body: PortalResponse = r
                .into_json()
                .map_err(|_| "the licence server sent a reply we could not read".to_string())?;
            // A 200 carrying an empty url would send the browser to "about:blank"
            // and look like the button silently did nothing.
            if body.url.trim().is_empty() {
                return Err("the licence server did not return a billing portal link".into());
            }
            Ok(body.url)
        }
        Err(ureq::Error::Status(404, _)) => {
            Err("we do not recognise that licence key -- check it for typos".into())
        }
        Err(ureq::Error::Status(403, _)) => Err("that licence is not currently active".into()),
        Err(ureq::Error::Status(429, _)) => {
            Err("too many billing portal requests just now -- try again in a minute".into())
        }
        Err(ureq::Error::Status(503, _)) => {
            Err("the billing portal is not available right now -- email support@pixelmarch.io \
                 and we will sort it out".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("the licence server is having trouble (error {code}) -- try again shortly"))
        }
        Err(_) => Err("could not reach the licence server".into()),
    }
}

// ------------------------------------------------------------------- status --

/// Coarse UI state for a token that has already verified.
fn state_for(claims: &Claims) -> &'static str {
    match claims.status.as_str() {
        "trialing" => "trialing",
        "past_due" => "past_due",
        "canceled" | "cancelled" => "canceled",
        _ => "active",
    }
}

/// Build the status a verified cache implies. Pure, and the verifying key is a
/// parameter rather than the baked-in constant, so the tests can drive every
/// state the UI has to render with tokens signed by a key they control.
/// `None` = this build's baked-in key is unusable, which is not a licence.
fn status_from(cache: &Cache, now: i64, offline: bool, key: Option<&VerifyingKey>) -> LicenseStatus {
    let mut out = LicenseStatus {
        licensed: false,
        state: "unlicensed".into(),
        status: None,
        plan: None,
        expires_at: None,
        license_key: Some(cache.license_key.clone()).filter(|k| !k.is_empty()),
        last_check: (cache.last_check > 0).then_some(cache.last_check),
        offline,
        device_id: None,
    };

    let verdict = match key {
        Some(k) => verify(&cache.token, k, now),
        None => Err(VerifyError::Malformed),
    };

    match verdict {
        Ok(claims) => {
            out.licensed = true;
            out.state = state_for(&claims).into();
            out.status = Some(claims.status.clone());
            out.plan = Some(claims.plan.clone());
            out.expires_at = Some(claims.exp);
        }
        Err(VerifyError::Expired { exp, .. }) => {
            out.state = "expired".into();
            out.expires_at = Some(exp);
        }
        // A token we cannot verify is worth exactly as much as no token, but
        // saying "unlicensed" would hide a real problem (a tampered file, a
        // build with the wrong key) behind a state the user can't act on.
        Err(_) => out.state = "invalid".into(),
    }

    out
}

/// Renew only when the token is close to lapsing, and not more than once an
/// hour. Returning false is the common case -- most launches touch no network.
fn needs_refresh(claims: &Claims, now: i64, last_check: i64) -> bool {
    now >= claims.exp - REFRESH_WINDOW_SECS && now - last_check >= REFRESH_COOLDOWN_SECS
}

/// The whole status path, with the directory and endpoint injected so the
/// offline behaviour is testable against a server that genuinely is not there.
fn status_in(dir: &Path, base: &str, now: i64, key: Option<&VerifyingKey>) -> LicenseStatus {
    let Some(mut cache) = read_cache(dir) else {
        return LicenseStatus::unlicensed();
    };
    if cache.token.is_empty() || cache.license_key.is_empty() {
        return LicenseStatus::unlicensed();
    }

    let mut offline = false;
    let due = key
        .and_then(|k| verify(&cache.token, k, now).ok())
        .map(|claims| needs_refresh(&claims, now, cache.last_check))
        // An expired or unverifiable cached token is exactly when a refresh is
        // most worth attempting -- it is the only way back to licensed.
        .unwrap_or(true);

    if due {
        cache.last_check = now;
        // Record the attempt even if it fails, so a server that is down does
        // not turn into a retry loop on every status poll.
        let _ = write_cache(dir, &cache);
        match device_id(dir).and_then(|dev| validate_remote(base, &cache.license_key, &dev)) {
            Ok(token) => {
                cache.token = token;
                let _ = write_cache(dir, &cache);
            }
            // NOT a denial. A cached token that still verifies keeps working;
            // this is the entire point of signing the entitlement.
            Err(_) => offline = true,
        }
    }

    let mut out = status_from(&cache, now, offline, key);
    out.device_id = device_id(dir).ok();
    out
}

fn refresh_in(
    dir: &Path,
    base: &str,
    license_key: &str,
    now: i64,
    key: &VerifyingKey,
) -> Result<LicenseStatus, String> {
    let licence = license_key.trim().to_uppercase();
    if licence.is_empty() {
        return Err("enter your licence key first".into());
    }
    let dev = device_id(dir)?;
    let token = validate_remote(base, &licence, &dev)?;

    // Never store a token we could not verify: a licence file that fails to
    // check is indistinguishable from a tampered one, and accepting it here
    // would move the trust decision from the signature to the transport.
    verify(&token, key, now).map_err(|e| match e {
        VerifyError::Expired { .. } => "the licence server issued an already-expired token".to_string(),
        _ => format!("the licence server sent a token we could not verify ({e})"),
    })?;

    let cache = Cache { license_key: licence, token, last_check: now };
    write_cache(dir, &cache)?;
    let mut out = status_from(&cache, now, false, Some(key));
    out.device_id = Some(dev);
    Ok(out)
}

// ----------------------------------------------------------------- commands --

#[tauri::command]
pub fn license_status() -> Result<LicenseStatus, String> {
    let dir = crate::state::state_dir()?;
    Ok(status_in(&dir, &api_base(), now(), public_key().ok().as_ref()))
}

#[tauri::command]
pub fn license_activate(key: String) -> Result<LicenseStatus, String> {
    let dir = crate::state::state_dir()?;
    refresh_in(&dir, &api_base(), &key, now(), &public_key()?)
}

/// Re-check the licence we already hold. Same path as activation, minus the
/// user typing the key again.
#[tauri::command]
pub fn license_refresh() -> Result<LicenseStatus, String> {
    let dir = crate::state::state_dir()?;
    let cache = read_cache(&dir).ok_or("no licence is activated on this install")?;
    refresh_in(&dir, &api_base(), &cache.license_key, now(), &public_key()?)
}

/// Open Paddle's customer portal in the user's browser: update the card,
/// cancel, download invoices.
///
/// The session URL is opened here rather than returned to the webview on
/// purpose. Paddle embeds a bearer token in it that is good for roughly a day
/// (see the `paddle-portal-session-gotchas` note), so it is a credential: handing
/// it to the frontend would put it in the DOM, in devtools, and in any error
/// toast that echoes a failed navigation. Nothing outside this function ever
/// sees it, and it is never written to the cache file or logged.
///
/// Called on click, never on render. Each call costs the server a live Paddle
/// API request, so polling this to decide whether to draw a button would bill a
/// request per repaint. The button's visibility keys off `licensed` instead.
#[tauri::command]
pub fn license_portal(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = crate::state::state_dir()?;
    let cache = read_cache(&dir).ok_or("no licence is activated on this install")?;
    let url = portal_url_remote(&api_base(), &cache.license_key)?;

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "could not open your browser -- check your default browser setting".to_string())
}

/// Forget the licence on this install. The device id stays: reactivating the
/// same folder should look like the same seat, not a new one.
#[tauri::command]
pub fn license_deactivate() -> Result<LicenseStatus, String> {
    let dir = crate::state::state_dir()?;
    match std::fs::remove_file(cache_path(&dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not remove the cached licence: {e}")),
    }
    Ok(LicenseStatus::unlicensed())
}

// -------------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;

    // Test vector produced by OpenSSL 3.6.3 (`openssl pkeyutl -sign -rawin`),
    // NOT by this code or by ed25519-dalek. Seed
    // 4041...5e5f wrapped as PKCS#8; payload is the exact JSON the server's
    // `Claims` serialises to. Timestamps came from `date -u -d`:
    //   iat 1782864000 = 2026-07-01T00:00:00Z
    //   exp 1783468800 = 2026-07-08T00:00:00Z  (iat + 7 days, the server's TTL)
    const VECTOR_PUBKEY: &str = "JUO5L_EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0";
    const VECTOR_PAYLOAD: &str = "eyJsaWMiOiJQTS1WRUNUT1ItMDAwMSIsInBsYW4iOiJ5ZWFybHkiLCJzdGF0dXMiOiJhY3RpdmUiLCJpYXQiOjE3ODI4NjQwMDAsImV4cCI6MTc4MzQ2ODgwMH0";
    const VECTOR_SIG: &str = "aELsuvZO3Kl5ZhreQ_WCZCBfPbsHzyedvZIeBsXOeiyddgbyYi2-FKfbEXdPCInw2kenuojaEs9ZwioIWCP6BA";
    const VECTOR_IAT: i64 = 1_782_864_000;
    const VECTOR_EXP: i64 = 1_783_468_800;

    fn vector_token() -> String {
        format!("{VECTOR_PAYLOAD}.{VECTOR_SIG}")
    }

    fn vector_key() -> VerifyingKey {
        let bytes: [u8; 32] = B64.decode(VECTOR_PUBKEY).unwrap().try_into().unwrap();
        VerifyingKey::from_bytes(&bytes).unwrap()
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixelmarch-license-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_valid_token_and_returns_its_claims() {
        let got = verify(&vector_token(), &vector_key(), VECTOR_IAT).unwrap();
        assert_eq!(
            got,
            Claims {
                lic: "PM-VECTOR-0001".into(),
                plan: "yearly".into(),
                status: "active".into(),
                iat: VECTOR_IAT,
                exp: VECTOR_EXP,
                dev: None,
            }
        );
    }

    #[test]
    fn accepts_a_token_right_up_to_its_expiry_and_not_after() {
        assert!(verify(&vector_token(), &vector_key(), VECTOR_EXP).is_ok());
        assert_eq!(
            verify(&vector_token(), &vector_key(), VECTOR_EXP + 1),
            Err(VerifyError::Expired { exp: VECTOR_EXP, now: VECTOR_EXP + 1 })
        );
    }

    /// The token is genuine, but signed by a key that is not ours -- which is
    /// what every forged licence would look like.
    #[test]
    fn rejects_a_token_signed_by_another_key() {
        let ours = public_key().unwrap();
        assert_eq!(
            verify(&vector_token(), &ours, VECTOR_IAT),
            Err(VerifyError::BadSignature)
        );
    }

    /// The obvious attack: edit `exp` in the payload, keep the signature.
    #[test]
    fn rejects_a_payload_edited_to_extend_expiry() {
        let payload = String::from_utf8(B64.decode(VECTOR_PAYLOAD).unwrap()).unwrap();
        let forged = payload.replace(&VECTOR_EXP.to_string(), "4000000000");
        assert_ne!(forged, payload, "the edit must actually change the payload");
        let token = format!("{}.{VECTOR_SIG}", B64.encode(forged.as_bytes()));
        assert_eq!(
            verify(&token, &vector_key(), VECTOR_IAT),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn rejects_malformed_input() {
        let key = vector_key();
        let no_signature = format!("{VECTOR_PAYLOAD}.");
        for bad in ["", "nodot", "!!!.!!!", "YWJj.YWJj", ".", no_signature.as_str()] {
            assert!(
                matches!(
                    verify(bad, &key, VECTOR_IAT),
                    Err(VerifyError::Malformed) | Err(VerifyError::BadSignature)
                ),
                "expected {bad:?} to be rejected"
            );
        }
    }

    /// Truncating the signature must not be mistaken for a short-but-valid one.
    #[test]
    fn rejects_a_signature_of_the_wrong_length() {
        let short = &VECTOR_SIG[..40];
        assert_eq!(
            verify(&format!("{VECTOR_PAYLOAD}.{short}"), &vector_key(), VECTOR_IAT),
            Err(VerifyError::Malformed)
        );
    }

    #[test]
    fn the_baked_in_public_key_is_a_usable_ed25519_key() {
        assert!(public_key().is_ok());
        assert_eq!(public_key().unwrap().to_bytes().len(), 32);
    }

    /// The point of the whole design: the server being unreachable must not
    /// take away access someone has already paid for. The endpoint here is a
    /// loopback port nothing listens on, so the refresh genuinely fails.
    #[test]
    fn offline_with_a_valid_cached_token_still_grants_access() {
        let dir = tmpdir("offline");
        // Deliberately inside the refresh window, so the code really does try
        // the network rather than skipping it.
        let now = VECTOR_EXP - 3600;
        write_cache(
            &dir,
            &Cache { license_key: "PM-VECTOR-0001".into(), token: vector_token(), last_check: 0 },
        )
        .unwrap();

        let status = status_in(&dir, "http://127.0.0.1:1", now, Some(&vector_key()));

        assert!(status.licensed, "a cached, still-valid token must survive an outage");
        assert!(status.offline, "and the UI should be able to say the refresh failed");
        assert_eq!(status.state, "active");
        assert_eq!(status.plan.as_deref(), Some("yearly"));
        assert_eq!(status.expires_at, Some(VECTOR_EXP));
        // The failed call must not have destroyed what we had.
        assert_eq!(read_cache(&dir).unwrap().token, vector_token());
    }

    /// ...but an expired cached token is not a licence, offline or not.
    #[test]
    fn offline_with_an_expired_cached_token_does_not_grant_access() {
        let dir = tmpdir("offline-expired");
        write_cache(
            &dir,
            &Cache { license_key: "PM-VECTOR-0001".into(), token: vector_token(), last_check: 0 },
        )
        .unwrap();

        let status = status_in(&dir, "http://127.0.0.1:1", VECTOR_EXP + 1, Some(&vector_key()));

        assert!(!status.licensed);
        assert_eq!(status.state, "expired");
        assert!(status.offline);
    }

    #[test]
    fn no_cache_is_unlicensed_and_touches_no_network() {
        let dir = tmpdir("empty");
        let status = status_in(&dir, "http://127.0.0.1:1", VECTOR_IAT, Some(&vector_key()));
        assert!(!status.licensed);
        assert_eq!(status.state, "unlicensed");
        assert!(!status.offline);
        assert_eq!(status.license_key, None);
    }

    #[test]
    fn a_token_far_from_expiry_is_not_refreshed() {
        let claims = verify(&vector_token(), &vector_key(), VECTOR_IAT).unwrap();
        assert!(!needs_refresh(&claims, VECTOR_IAT, 0), "6 days of life left");
        assert!(
            needs_refresh(&claims, VECTOR_EXP - REFRESH_WINDOW_SECS, 0),
            "exactly at the window edge"
        );
        assert!(
            !needs_refresh(&claims, VECTOR_EXP - 60, VECTOR_EXP - 60),
            "inside the window but just checked -- cooldown applies"
        );
    }

    #[test]
    fn a_corrupt_cache_reads_as_unlicensed_rather_than_erroring() {
        let dir = tmpdir("corrupt");
        std::fs::write(cache_path(&dir), "{ not json").unwrap();
        assert_eq!(status_in(&dir, "http://127.0.0.1:1", VECTOR_IAT, Some(&vector_key())).state, "unlicensed");
    }

    /// A file someone has hand-edited (or a build carrying the wrong key)
    /// should read as "invalid", not as a licence and not as a silent absence.
    #[test]
    fn a_tampered_cached_token_is_reported_as_invalid() {
        let dir = tmpdir("tampered");
        let mut sig = VECTOR_SIG.to_string();
        sig.replace_range(0..1, if sig.starts_with('a') { "b" } else { "a" });
        write_cache(
            &dir,
            &Cache {
                license_key: "PM-VECTOR-0001".into(),
                token: format!("{VECTOR_PAYLOAD}.{sig}"),
                last_check: 0,
            },
        )
        .unwrap();
        let status = status_in(&dir, "http://127.0.0.1:1", VECTOR_IAT, Some(&vector_key()));
        assert!(!status.licensed);
        assert_eq!(status.state, "invalid");
    }

    #[test]
    fn device_id_is_stable_across_calls_and_survives_deactivation() {
        let dir = tmpdir("device");
        let first = device_id(&dir).unwrap();
        assert_eq!(first.len(), 32, "a plain uuid, no separators");
        assert_eq!(device_id(&dir).unwrap(), first);
        // Deactivation removes the cache, never the device file.
        let _ = std::fs::remove_file(cache_path(&dir));
        assert_eq!(device_id(&dir).unwrap(), first);
    }

    /// Two installs must not share an id -- and it must not be derived from
    /// anything about the machine, which is what makes that true here.
    #[test]
    fn device_ids_differ_between_installs() {
        assert_ne!(
            device_id(&tmpdir("device-a")).unwrap(),
            device_id(&tmpdir("device-b")).unwrap()
        );
    }

    #[test]
    fn refuses_to_send_a_licence_key_over_plain_http() {
        assert!(guard_url("https://api.pixelmarch.io/v1/license/validate").is_ok());
        assert!(guard_url("http://127.0.0.1:8080/v1/license/validate").is_ok());
        assert!(guard_url("http://localhost:8080/v1/license/validate").is_ok());
        assert!(guard_url("http://[::1]:8080/v1/license/validate").is_ok());
        assert!(guard_url("http://api.pixelmarch.io/v1/license/validate").is_err());
        // A name that merely starts like a loopback address resolves off-box.
        assert!(guard_url("http://127.evil.com/v1/license/validate").is_err());
        assert!(guard_url("ftp://api.pixelmarch.io/").is_err());
    }

    /// No build may let the launch environment choose the licence server: that server
    /// receives the licence key and decides whether the app is licensed, so an exported
    /// `PIXELMARCH_LICENSE_URL` would be both credential theft and a licence bypass.
    /// Only the compile-time bake, and otherwise the vendor default, count.
    #[test]
    fn no_build_honours_a_runtime_licence_url_override() {
        // The environment is not a source: `pick_api_base` cannot even receive it, and
        // the real accessor feeds it nothing but the compile-time bake. Asserted by
        // recomputing that, rather than by exporting a value — `set_var` is
        // unsafe-by-contract in a multithreaded process and the test harness is one.
        assert_eq!(api_base(), pick_api_base(option_env!("PIXELMARCH_LICENSE_URL")));

        assert_eq!(pick_api_base(None), DEFAULT_API_BASE);
        assert_eq!(pick_api_base(Some("https://staging.example")), "https://staging.example");
        // Blank is "unset", not "the empty URL".
        assert_eq!(pick_api_base(Some("  ")), DEFAULT_API_BASE);
    }

    #[test]
    fn activation_refuses_a_token_it_cannot_verify() {
        // Nothing is listening, so this fails at the network step -- and the
        // important part is that no cache file is left behind either way.
        let dir = tmpdir("activate-fail");
        assert!(refresh_in(&dir, "http://127.0.0.1:1", "PM-VECTOR-0001", VECTOR_IAT, &vector_key()).is_err());
        assert!(read_cache(&dir).is_none());
    }

    #[test]
    fn status_maps_subscription_states_the_ui_has_to_distinguish() {
        for (status, expect) in [
            ("active", "active"),
            ("trialing", "trialing"),
            ("past_due", "past_due"),
            ("canceled", "canceled"),
            ("cancelled", "canceled"),
        ] {
            let claims = Claims {
                lic: "PM-1".into(),
                plan: "monthly".into(),
                status: status.into(),
                iat: VECTOR_IAT,
                exp: VECTOR_EXP,
                dev: None,
            };
            assert_eq!(state_for(&claims), expect);
        }
    }
}

// ------------------------------------------------------- live e2e harness --
//
// Ignored by default: these drive a *running* licence service, so they need a
// server, a real licence key, and that server's public key. They exist because
// task-5 (docs/testing-purchase.md) has to prove the client half against
// something that actually answers -- activation, cache-survives-restart,
// cancellation, and the past_due grace window cannot be shown with a fixed
// token vector.
//
//   PIXELMARCH_E2E_BASE=http://127.0.0.1:8099 \
//   PIXELMARCH_E2E_KEY=PM-XXXX-XXXX-XXXX \
//   PIXELMARCH_E2E_PUBKEY=$(curl -s $BASE/v1/pubkey | ...) \
//   cargo test --no-default-features live_e2e -- --ignored --nocapture
//
// These `PIXELMARCH_E2E_*` reads are inside `#[cfg(test)]`, so they exist only in the
// test binary and are absent from any shipped exe -- the harness can point itself at a
// server and hand itself a public key without that being an environment knob a user's
// machine can turn.
#[cfg(test)]
mod live_e2e {
    use super::*;

    struct Env {
        base: String,
        key: String,
        pubkey: VerifyingKey,
    }

    /// `None` when the harness variables are absent, so the test skips loudly
    /// instead of failing in a way that looks like a product bug.
    fn env() -> Option<Env> {
        let base = std::env::var("PIXELMARCH_E2E_BASE").ok().filter(|v| !v.is_empty())?;
        let key = std::env::var("PIXELMARCH_E2E_KEY").ok().filter(|v| !v.is_empty())?;
        let raw = std::env::var("PIXELMARCH_E2E_PUBKEY").ok().filter(|v| !v.is_empty())?;
        let bytes: [u8; 32] = B64.decode(raw).expect("pubkey is base64url").try_into().expect("32 bytes");
        Some(Env { base, key, pubkey: VerifyingKey::from_bytes(&bytes).expect("valid key") })
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pixelmarch-e2e-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    #[ignore = "needs a running licence service; see the module comment"]
    fn a_real_key_activates_and_survives_a_restart() {
        let Some(e) = env() else {
            eprintln!("SKIP: PIXELMARCH_E2E_* not set");
            return;
        };
        let d = dir("activate");

        let status = refresh_in(&d, &e.base, &e.key, now(), &e.pubkey).expect("activation");
        assert!(status.licensed, "a live key must grant access: {status:?}");
        assert_eq!(status.license_key.as_deref(), Some(e.key.as_str()));

        // The cache is what makes a restart cheap and offline usable, so assert
        // it is on disk in the profile, not merely in memory.
        assert!(cache_path(&d).exists(), "no cache file was written");

        // "Restart": nothing in memory, no network reachable (a base that
        // refuses connections), read only what is on disk.
        let after = status_in(&d, "http://127.0.0.1:1", now(), Some(&e.pubkey));
        assert!(after.licensed, "cached token must survive a restart: {after:?}");
        assert_eq!(after.license_key.as_deref(), Some(e.key.as_str()));
    }

    #[test]
    #[ignore = "needs a running licence service; see the module comment"]
    fn the_current_server_state_is_what_a_refresh_reports() {
        let Some(e) = env() else {
            eprintln!("SKIP: PIXELMARCH_E2E_* not set");
            return;
        };
        let d = dir("refresh");
        refresh_in(&d, &e.base, &e.key, now(), &e.pubkey).expect("activation");

        // Whatever the subscription is now (active, past_due, canceled), a
        // refresh must report it rather than the state we cached earlier.
        let status = refresh_in(&d, &e.base, &e.key, now(), &e.pubkey).expect("refresh");
        eprintln!(
            "refresh -> state={} licensed={} status={:?} expires_at={:?}",
            status.state, status.licensed, status.status, status.expires_at
        );
    }
}
