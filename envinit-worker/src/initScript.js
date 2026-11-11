import helpBanner from "./helpBanner.sh";
import cliAndRepoState from "./cliAndRepoState.sh";
import gitAuthAndWrapper from "./gitAuthAndWrapper.sh";
import pnpmTmpfsWrapper from "./pnpmTmpfsWrapper.sh";
import rustTmpfsWrapper from "./rustTmpfsWrapper.sh";
import gitRefCheckout from "./gitRefCheckout.sh";
import gitSubmoduleHooks from "./gitSubmoduleHooks.sh";
import submoduleSync from "./submoduleSync.sh";
import workspaceLinksAndMain from "./workspaceLinksAndMain.sh";

export const SCRIPT_MODULE_ORDER = [
  "helpBanner.sh",
  "cliAndRepoState.sh",
  "gitAuthAndWrapper.sh",
  "pnpmTmpfsWrapper.sh",
  "rustTmpfsWrapper.sh",
  "gitRefCheckout.sh",
  "gitSubmoduleHooks.sh",
  "submoduleSync.sh",
  "workspaceLinksAndMain.sh",
];

const SCRIPT_SECTIONS = [
  "#!/usr/bin/env bash\nset -euo pipefail",
  helpBanner.trim(),
  cliAndRepoState.trim(),
  gitAuthAndWrapper.trim(),
  pnpmTmpfsWrapper.trim(),
  rustTmpfsWrapper.trim(),
  gitRefCheckout.trim(),
  gitSubmoduleHooks.trim(),
  submoduleSync.trim(),
  workspaceLinksAndMain.trim(),
];

export const INIT_SCRIPT = SCRIPT_SECTIONS.join("\n\n") + "\n";

function extractHelpTextFromBanner(bannerText) {
  const match = bannerText.match(
    /cat << 'HELP_EOF'\r?\n([\s\S]*?)\r?\nHELP_EOF/
  );
  return match && match[1] ? match[1] + "\n" : bannerText;
}

export const HELP_TEXT = extractHelpTextFromBanner(helpBanner);
