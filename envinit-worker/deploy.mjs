#!/usr/bin/env node
/**
 * Syncs `src/helpText.js` and `src/initScript.js` from `envinit.sh` (single source of truth),
 * and optionally deploys the multi-module ES Worker to Cloudflare Workers API (`--deploy`).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(__dirname, "scripts");
const shPath = path.join(__dirname, "envinit.sh");
const srcDir = path.join(__dirname, "src");

function assembleEnvinitSh() {
  if (!fs.existsSync(scriptsDir)) {
    return fs.readFileSync(shPath, "utf8");
  }
  const files = fs
    .readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".sh"))
    .sort();
  if (files.length === 0) {
    return fs.readFileSync(shPath, "utf8");
  }
  const chunks = ["#!/usr/bin/env bash\nset -euo pipefail\n"];
  for (const file of files) {
    const content = fs
      .readFileSync(path.join(scriptsDir, file), "utf8")
      .trim();
    chunks.push(content + "\n");
  }
  const assembled = chunks.join("\n");
  fs.writeFileSync(shPath, assembled, { encoding: "utf8", mode: 0o755 });
  return assembled;
}

function extractHelpText(shContent) {
  const match = shContent.match(
    /cat << 'HELP_EOF'\r?\n([\s\S]*?)\r?\nHELP_EOF/
  );
  if (!match || !match[1]) {
    throw new Error("Could not find HELP_EOF block in envinit.sh");
  }
  return match[1] + "\n";
}

function syncGeneratedModules() {
  const shContent = assembleEnvinitSh();
  const helpText = extractHelpText(shContent);

  fs.mkdirSync(srcDir, { recursive: true });

  const helpModuleContent =
    "// Auto-generated from envinit.sh HELP_EOF block. Do not edit manually.\n" +
    `export const HELP_TEXT = ${JSON.stringify(helpText)};\n`;

  const scriptModuleContent =
    "// Auto-generated from envinit.sh. Do not edit manually.\n" +
    `export const INIT_SCRIPT = ${JSON.stringify(shContent)};\n`;

  fs.writeFileSync(path.join(srcDir, "helpText.js"), helpModuleContent, "utf8");
  fs.writeFileSync(
    path.join(srcDir, "initScript.js"),
    scriptModuleContent,
    "utf8"
  );
  console.log(
    `[envinit-worker] Assembled envinit.sh (${shContent.length}B) and synced src/helpText.js (${helpText.length}B) & src/initScript.js.`
  );
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

  const moduleFiles = [
    "index.js",
    "parseQueryArgs.js",
    "helpText.js",
    "initScript.js",
  ];
  for (const modName of moduleFiles) {
    const filePath = path.join(srcDir, modName);
    curlArgs.push(
      "-F",
      `${modName}=@${filePath};filename=${modName};type=application/javascript+module`
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
    `[envinit-worker] Deployed multi-module Worker "${scriptName}" (etag: ${result.result?.etag}).`
  );
}

syncGeneratedModules();
if (process.argv.includes("--deploy")) {
  deployToCloudflare();
}
