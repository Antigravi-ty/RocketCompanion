#!/usr/bin/env node
/**
 * Assembles the modular `scripts/*.sh` sections in memory (optionally writing
 * `/work/fix.sh` via `--write-fix` or `--out <path>`) and deploys the
 * multi-module ES + Text Worker to Cloudflare Workers API (`--deploy`).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, "scripts");
const srcDir = path.join(__dirname, "src");

const SCRIPT_MODULE_ORDER = [
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

const JS_MODULE_FILES = ["index.js", "parseQueryArgs.js", "initScript.js"];

export function assembleEnvinitSh() {
  const chunks = ["#!/usr/bin/env bash\nset -euo pipefail"];
  for (const file of SCRIPT_MODULE_ORDER) {
    const fullPath = path.join(scriptsDir, file);
    const content = fs.readFileSync(fullPath, "utf8").trim();
    chunks.push(content);
  }
  return chunks.join("\n\n") + "\n";
}

function deployToCloudflare() {
  const accountId =
    process.env.CF_ACCOUNT_ID || "ed9fbe2769b04c3a5a27021fb8536a79";
  const apiToken = process.env.CF_API_TOKEN || "";
  const scriptName = process.env.CF_SCRIPT_NAME || "envinit";

  if (!apiToken) {
    throw new Error(
      "Missing CF_API_TOKEN environment variable for Cloudflare deployment."
    );
  }

  const metadata = JSON.stringify({
    main_module: "index.js",
    compatibility_date: "2026-11-09",
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
  });

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;
  const curlArgs = [
    "-sS",
    "-X",
    "PUT",
    endpoint,
    "-H",
    `Authorization: Bearer ${apiToken}`,
    "-F",
    `metadata=${metadata};type=application/json`,
  ];

  for (const modName of JS_MODULE_FILES) {
    const filePath = path.join(srcDir, modName);
    curlArgs.push(
      "-F",
      `${modName}=@${filePath};filename=${modName};type=application/javascript+module`
    );
  }

  for (const shName of SCRIPT_MODULE_ORDER) {
    const filePath = path.join(scriptsDir, shName);
    curlArgs.push(
      "-F",
      `${shName}=@${filePath};filename=${shName};type=text/plain`
    );
  }

  const rawOut = execFileSync("curl", curlArgs, { encoding: "utf8" });
  const result = JSON.parse(rawOut);
  if (!result.success) {
    throw new Error(
      `Cloudflare deploy failed: ${JSON.stringify(result.errors || result)}`
    );
  }
  console.log(
    `[envinit-worker] Deployed multi-module Worker "${scriptName}" (${JS_MODULE_FILES.length} JS + ${SCRIPT_MODULE_ORDER.length} Text modules, etag: ${result.result?.etag}).`
  );
}

const assembled = assembleEnvinitSh();
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) {
  const outPath = path.resolve(args[outIdx + 1]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, assembled, { encoding: "utf8", mode: 0o755 });
  console.log(
    `[envinit-worker] Wrote assembled initializer to ${outPath} (${assembled.length}B).`
  );
} else if (args.includes("--write-fix")) {
  const fixPath = "/work/fix.sh";
  fs.mkdirSync("/work", { recursive: true });
  fs.writeFileSync(fixPath, assembled, { encoding: "utf8", mode: 0o755 });
  console.log(
    `[envinit-worker] Updated ${fixPath} (${assembled.length}B, ${SCRIPT_MODULE_ORDER.length} modules).`
  );
} else {
  console.log(
    `[envinit-worker] Verified ${SCRIPT_MODULE_ORDER.length} script modules (${assembled.length}B assembled).`
  );
}

if (args.includes("--deploy")) {
  deployToCloudflare();
}
