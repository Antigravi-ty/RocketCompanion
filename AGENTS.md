# Global instructions
Limit the amount of comments you put in the code to a strict minimum. You should almost never add comments, except sometimes on non-trivial code, function definitions if the arguments aren't self-explanatory, and class definitions and their members.

Do not remove existing comments unless they are directly related to what you are changing.

## Referring to code in bugs, reviews and commit messages
- **Reference a name, not a position.** This text outlives the code it describes, so cite a selector, function, class, pref or flag name; name a file without a line, and avoid positional phrasing ("the rule above X").

## Code Style & Naming
- Do not use emoji anywhere in the repository.
- Write all code, UI strings, comments, logs, docs, and commit messages strictly in English.
- Never use `soccer` or `soccar` (or compound variants); always use neutral `ball`, `carball`, or `arena` terminology.
- Use clear, self-explanatory identifiers; avoid single-letter or opaque abbreviations except for standard math and graphics conventions.
- Treat every commit as standalone: keep zero backward-compatibility shims, dead code, or re-export barrel files (`index.ts` facades).

## Architecture & Tooling
- Use `pnpm` exclusively (`pnpm-lock.yaml` only) and run `pnpm run check` (`pnpm run radar && pnpm run typecheck`) before committing.
- Write all modules under `src/` in strict TypeScript (`.ts`/`.tsx`) without boundary `any`. Do not edit auto-generated `src/physics/core.js` or `src/physics/core.wasm`.
- Do not modify markdown files under `src/ui-core` (`RCUIModule` submodule) without asking first.
- Keep static assets in `public/` (`RocketCompanionStatics` submodule); never embed binary assets inline as Base64, Data URIs, or byte arrays.
- Maintain zero circular dependencies and strict unidirectional layers: engine modules must not import from `src/ui-system` or non-config `src/ui-core` (route via `src/game/runtimeUiPort.ts`), and `src/ui-core/stores` may only depend on pure `src/ui-core/config`.
- Decompose large modules into pure data pipelines `(input) => output` or self-contained `SubController` classes; never split via gut-sharing `*Helper.ts` mutators or pass-through getter/setter proxies.

## Security
- Never hardcode real signaling endpoints, broker hostnames, TURN/STUN credentials, topic prefixes, tokens, or keys; use RFC 5737 documentation IPs or `wss://relay.carball.dev` placeholders.
- Keep real relays and credentials in the untracked private profile (`.cache/resolvedProfile.json` or `.rctbnspib`); never track `.cache/`, `*.pem`, `*.key`, `*.rctbnspib`, or `.env*`.
