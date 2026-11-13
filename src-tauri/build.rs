use std::path::Path;
use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn emit_git_rerun_hints() {
    if let Some(git_dir) = git_output(&["rev-parse", "--git-dir"]) {
        let base = Path::new(&git_dir);
        for rel in ["HEAD", "packed-refs"] {
            let candidate = base.join(rel);
            if candidate.exists() {
                println!("cargo:rerun-if-changed={}", candidate.display());
            }
        }
        let heads_dir = base.join("refs").join("heads");
        if heads_dir.exists() {
            println!("cargo:rerun-if-changed={}", heads_dir.display());
        }
    }
}

fn main() {
    emit_git_rerun_hints();

    let short_sha = git_output(&["rev-parse", "--short=7", "HEAD"])
        .or_else(|| {
            std::env::var("GITHUB_SHA")
                .ok()
                .map(|s| s.chars().take(7).collect())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "dev".to_string());

    let full_sha = git_output(&["rev-parse", "HEAD"])
        .or_else(|| std::env::var("GITHUB_SHA").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| short_sha.clone());

    println!("cargo:rustc-env=RC_GIT_COMMIT_SHORT={}", short_sha);
    println!("cargo:rustc-env=RC_GIT_COMMIT_FULL={}", full_sha);

    tauri_build::build()
}
