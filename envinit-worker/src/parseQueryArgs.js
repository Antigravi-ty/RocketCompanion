/**
 * Query Parameter Parser & Shell-Safe Preset Argument Injector
 */

export function shellQuote(val) {
  return "'" + String(val).replace(/'/g, "'\\''") + "'";
}

export function parseQueryPresetArgs(searchParams) {
  const presetArgs = [];

  const repo = searchParams.get("repo");
  const targetRef =
    searchParams.get("ref") ||
    searchParams.get("branch") ||
    searchParams.get("commit");
  const newBranch =
    searchParams.get("new_branch") || searchParams.get("new-branch");
  const name = searchParams.get("name");
  const root = searchParams.get("root");
  const workDir = searchParams.get("work_dir") || searchParams.get("work-dir");
  const tmpDir = searchParams.get("tmp_dir") || searchParams.get("tmp-dir");
  const subGlobs =
    searchParams.get("tmpfs_submodules") ||
    searchParams.get("tmpfs-submodules");
  const gitName =
    searchParams.get("git_name") || searchParams.get("git-name");
  const gitEmail =
    searchParams.get("git_email") || searchParams.get("git-email");
  const withRust =
    searchParams.get("with_rust") || searchParams.get("with-rust");
  const noCheck = searchParams.get("no_check") || searchParams.get("no-check");
  const radarArgs =
    searchParams.get("radar_args") || searchParams.get("radar-args");
  const checkCmd =
    searchParams.get("check_cmd") || searchParams.get("check-cmd");
  const auth =
    searchParams.get("auth") ||
    searchParams.get("token") ||
    searchParams.get("request_id") ||
    searchParams.get("request-id");
  const authUrl =
    searchParams.get("auth_url") || searchParams.get("auth-url");

  if (repo) presetArgs.push("--repo", shellQuote(repo));
  if (targetRef) presetArgs.push("--ref", shellQuote(targetRef));
  if (newBranch) presetArgs.push("--new-branch", shellQuote(newBranch));
  if (auth) presetArgs.push("--auth", shellQuote(auth));
  if (authUrl) presetArgs.push("--auth-url", shellQuote(authUrl));
  if (name) presetArgs.push("--name", shellQuote(name));
  if (root) presetArgs.push("--root", shellQuote(root));
  if (workDir) presetArgs.push("--work-dir", shellQuote(workDir));
  if (tmpDir) presetArgs.push("--tmp-dir", shellQuote(tmpDir));
  if (subGlobs) presetArgs.push("--tmpfs-submodules", shellQuote(subGlobs));
  if (gitName) presetArgs.push("--git-name", shellQuote(gitName));
  if (gitEmail) presetArgs.push("--git-email", shellQuote(gitEmail));
  if (withRust === "1" || withRust === "true") presetArgs.push("--with-rust");
  if (noCheck === "1" || noCheck === "true") presetArgs.push("--no-check");
  if (radarArgs) presetArgs.push("--radar-args", shellQuote(radarArgs));
  if (checkCmd) presetArgs.push("--check-cmd", shellQuote(checkCmd));

  return presetArgs;
}

export function injectPresetArgs(scriptText, presetArgs) {
  if (!presetArgs || presetArgs.length === 0) {
    return scriptText;
  }
  const callLine = "main " + presetArgs.join(" ") + ' "$@"\n';
  return scriptText.replace(/main "\$@"\s*$/, callLine);
}
