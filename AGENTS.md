# RocketCompanion Workspace

- Run `pnpm run format` and `pnpm run check` before committing.
- Use `pnpm run radar:audit` (`--audit` or `--audit=<path>`) to inspect structural coupling, host penetration, and pass-through proxies.
- Do not edit generated `src/physics/core.js` or `src/physics/core.wasm`.
- Do not modify `src/ui-core` (`RCUIModule` submodule) markdown files without asking first.
- Keep real signaling endpoints and credentials in untracked `.cache/resolvedProfile.json` or `.rctbnspib`.
