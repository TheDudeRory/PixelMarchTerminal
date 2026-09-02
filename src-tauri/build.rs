//! Build script. Beyond `tauri_build`, it stamps the binary with the commit and
//! build time so a RUNNING exe can say exactly which source it came from.
//!
//! Why this exists: the brain's HTTP contract evolves (cross-project recall,
//! query-string POST fields, `/tasks` filters), but the shipped `pixelmarch.exe`
//! only picks that up after a pack + update + restart. Without a stamp a stale
//! host silently lacks guards its callers assume — see `brain::build_stamp`.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Short commit sha; "unknown" outside a git checkout (release tarball, vendored build).
    let sha = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    // A dirty tree is a build nobody can reproduce from the sha alone — say so.
    let dirty = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    let sha = if dirty { format!("{sha}-dirty") } else { sha };

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    println!("cargo:rustc-env=PIXELMARCH_GIT_SHA={sha}");
    println!("cargo:rustc-env=PIXELMARCH_BUILD_EPOCH={secs}");
    println!("cargo:rustc-env=PIXELMARCH_BUILD_TIME={}", iso_utc(secs));
    // Re-stamp when HEAD moves. HEAD itself only changes on checkout/branch switch;
    // a new commit on the SAME branch writes the ref file (or packed-refs), so watch
    // all three or an incremental rebuild ships a stamp for the previous commit.
    // `--git-path` resolves through a worktree's `.git` file to the real gitdir.
    for p in [git_path("HEAD"), head_ref_path(), git_path("packed-refs")]
        .into_iter()
        .flatten()
    {
        println!("cargo:rerun-if-changed={p}");
    }

    // update.rs reads PIXELMARCH_UPDATE_URL with option_env! at COMPILE time. Without
    // this, cargo's default env tracking does not cover it, so an incremental rebuild
    // after setting it reuses the object files and ships a binary with NO update URL —
    // the last release that machine can ever install. publish-release.sh greps the exe
    // and refuses such a build, which used to mean hand-touching update.rs to force a
    // recompile. Declaring it here makes cargo do that itself.
    // Every other option_env! bake needs the same treatment, and for these the stale
    // value is a security problem rather than an inconvenience: the three
    // PIXELMARCH_ALLOW_* flags would keep an escape hatch alive in a build whose
    // operator has already unset it.
    println!("cargo:rerun-if-env-changed=PIXELMARCH_UPDATE_URL");
    println!("cargo:rerun-if-env-changed=PIXELMARCH_ALLOW_HTTP_UPDATE");
    println!("cargo:rerun-if-env-changed=PIXELMARCH_ALLOW_INSECURE_UPDATE");
    println!("cargo:rerun-if-env-changed=PIXELMARCH_ALLOW_UNVERIFIED_UPDATE");
    // The update-signing trust anchor. A stale value here is the worst of the set:
    // the binary would keep verifying releases against the PREVIOUS key, so a
    // rotation silently fails to take effect and the retired key still installs.
    println!("cargo:rerun-if-env-changed=PIXELMARCH_UPDATE_PUBKEY");

    tauri_build::build()
}

/// Path git would use for `name` inside the gitdir, or `None` if it does not exist
/// (no checkout, or a ref that lives only in `packed-refs`).
fn git_path(name: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-path", name])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty() && std::path::Path::new(&p).exists()).then_some(p)
}

/// Loose ref file HEAD points at (`.git/refs/heads/<branch>`); `None` on a detached
/// HEAD or when the ref is packed.
fn head_ref_path() -> Option<String> {
    let out = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let r = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!r.is_empty()).then(|| git_path(&r))?
}

/// `YYYY-MM-DDTHH:MM:SSZ` from epoch seconds — no chrono, no dependency churn.
/// Civil-from-days (Howard Hinnant's algorithm), valid for every date we care about.
fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
