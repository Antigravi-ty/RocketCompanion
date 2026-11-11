/**
 * Cloudflare Worker Entry Point: Universal OverlayFS + tmpfs Sandbox Initializer
 *
 * Modularized across `envinit-worker/src/`:
 *   - `index.js`: HTTP routing (`/`, `/help`, `/--help`, `/?help=1`, `/health`)
 *   - `parseQueryArgs.js`: Query parameter extraction, shell-quoting, and CLI preset injection
 *   - `helpText.js`: Plain-text usage & architecture documentation
 *   - `initScript.js`: Standalone Bash initializer payload (`envinit.sh`)
 */

import { HELP_TEXT } from "./helpText.js";
import { INIT_SCRIPT } from "./initScript.js";
import { injectPresetArgs, parseQueryPresetArgs } from "./parseQueryArgs.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
};

const SCRIPT_HEADERS = {
  "content-type": "text/x-shellscript; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "envinit-worker",
          version: "2.5.0",
          architecture: "decoupled-esm",
        }),
        { status: 200, headers: JSON_HEADERS }
      );
    }

    if (
      url.pathname === "/help" ||
      url.pathname === "/--help" ||
      url.searchParams.has("help")
    ) {
      return new Response(HELP_TEXT, {
        status: 200,
        headers: TEXT_HEADERS,
      });
    }

    const presetArgs = parseQueryPresetArgs(url.searchParams);
    const body = injectPresetArgs(INIT_SCRIPT, presetArgs);

    return new Response(body, {
      status: 200,
      headers: SCRIPT_HEADERS,
    });
  },
};
