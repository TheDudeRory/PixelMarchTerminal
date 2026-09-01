//! Detect the shells available on this machine so profiles can offer them.
use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut out: Vec<ShellInfo> = Vec::new();

    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let win_ps = format!("{sysroot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        if Path::new(&win_ps).exists() {
            out.push(ShellInfo { id: "powershell".into(), label: "Windows PowerShell".into(), path: win_ps, args: vec![] });
        }
        if let Some(p) = which("pwsh.exe").or_else(|| first_existing(&["C:\\Program Files\\PowerShell\\7\\pwsh.exe"])) {
            out.push(ShellInfo { id: "pwsh".into(), label: "PowerShell 7".into(), path: p, args: vec![] });
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
        if Path::new(&comspec).exists() {
            out.push(ShellInfo { id: "cmd".into(), label: "Command Prompt".into(), path: comspec, args: vec![] });
        }
        if let Some(p) = first_existing(&["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]).or_else(|| which("bash.exe")) {
            out.push(ShellInfo { id: "gitbash".into(), label: "Git Bash".into(), path: p, args: vec!["-i".into(), "-l".into()] });
        }
        for distro in wsl_distros() {
            out.push(ShellInfo { id: format!("wsl:{distro}"), label: format!("WSL: {distro}"), path: "wsl.exe".into(), args: vec!["-d".into(), distro] });
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            if Path::new(&sh).exists() {
                out.push(ShellInfo { id: "default".into(), label: sh.clone(), path: sh, args: vec![] });
            }
        }
        for (id, p) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh")] {
            if Path::new(p).exists() {
                out.push(ShellInfo { id: id.into(), label: id.into(), path: p.into(), args: vec![] });
            }
        }
    }

    out
}

fn first_existing(paths: &[&str]) -> Option<String> {
    paths.iter().find(|p| Path::new(p).exists()).map(|p| p.to_string())
}

fn which(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|full| full.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    match Command::new("wsl.exe").args(["-l", "-q"]).creation_flags(CREATE_NO_WINDOW).output() {
        Ok(o) if o.status.success() => parse_wsl(&o.stdout),
        _ => vec![],
    }
}

/// `wsl -l -q` prints one distro per line as UTF-16LE (with a trailing BOM/nulls).
pub fn parse_wsl(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim().trim_matches('\u{feff}').trim_matches('\0').trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse_wsl;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn parses_wsl_utf16_output() {
        let raw = utf16le("\u{feff}Ubuntu\r\nDebian\r\n\r\n");
        assert_eq!(parse_wsl(&raw), vec!["Ubuntu".to_string(), "Debian".to_string()]);
    }
}
