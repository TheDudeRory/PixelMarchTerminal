// Wrapper around the tauri CLI. On Windows, keep cargo's target/ churn off the
// slow Z: network share by redirecting it to a local disk. Every other OS uses
// cargo's default target dir — no per-machine config edits needed.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
if (process.platform === "win32" && !env.CARGO_TARGET_DIR) {
  env.CARGO_TARGET_DIR = "C:/builds/pixelmarch-target";
}

const r = spawnSync("tauri", process.argv.slice(2), { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 1);
