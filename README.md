# creator-site

A self-hosted website for content creators. One application, one container, one database:

- **Links** — the public page, driven entirely by configuration
- **Chat** — multi-platform live chat, as a page and as an OBS browser source
- **Feed** — posts from every platform the creator is on, merged into one timeline
- **Calendar** — events the admin edits and viewers subscribe to over `webcal://`
- **Admin** — runs all of the above without touching files
- **Integrations** — Synchra, Discord, Cloudflare, and a plugin system for the rest

Every feature is optional and off until it is turned on. The install should be usable before it is
configured.

> **Status: early.** The scaffold and the first ported modules are in. Nothing here is deployable
> yet.

## Running it

```bash
npm install
npm run dev
```

|                     |                                                              |
| ------------------- | ------------------------------------------------------------ |
| **`npm run gate`**  | **the whole gate — run this before claiming anything works** |
| `npm run dev`       | development server with HMR                                  |
| `npm run build`     | production build (`@sveltejs/adapter-node`)                  |
| `npm run preview`   | serve the production build locally                           |
| `npm run check`     | `svelte-check` over the whole project                        |
| `npm run lint`      | Prettier check and ESLint                                    |
| `npm run format`    | rewrite with Prettier                                        |
| `npm run test:unit` | Vitest                                                       |
| `npm run test:e2e`  | Playwright                                                   |
| `npm run db:push`   | apply the Drizzle schema to the database                     |
| `npm run db:studio` | browse the database                                          |

Node **26** or newer (`.nvmrc` pins it; the deployment container runs the same major).

## The gate

`npm run gate` is `svelte-kit sync` → format check → strict lint → `npm audit` → build → type check
→ tests, in that order, and it is what CI runs. One command rather than seven, so CI cannot drift
from what runs locally.

The order is load-bearing in two places. `svelte-kit sync` is first because it is a prerequisite
rather than a check: without the generated `$app` types, ESLint's type-aware rules see `any`
everywhere and report a wall of unsafe-assignment errors unrelated to the actual code. The build
comes before the type check because Paraglide's messages do not exist in a fresh checkout and
`svelte-check` flags every import of them.

**Strictness is the starting point, not something to migrate toward.**

- `tsconfig.json` runs `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`,
  `isolatedModules`, `noImplicitReturns` and `verbatimModuleSyntax`. The type check passes with
  **zero errors and zero warnings** or the gate fails.
- ESLint runs `strictTypeChecked` and `stylisticTypeChecked` — the type-aware tiers, not
  `recommended` — over every file, plus `no-floating-promises`, `no-misused-promises`, `no-console`
  (bar `console.error`), `ban-ts-comment`, and a ban on `enum` and `namespace`.
- **Size limits are enforced mechanically**, not by eye: `max-lines` 1000, `max-lines-per-function`
  100, `max-params` 5, `max-depth` 3. Tests are exempt from the line counts, because a `describe`
  block is one unit of meaning and splitting it to satisfy a counter makes a suite harder to read.
- Config files are type-checked too — `eslint.config.js` and `prettier.config.js` are in
  `tsconfig.json`'s `include`, because a lint config that silently fails to apply a rule is worse
  than not having one.

### Dependency overrides

`package.json` pins `esbuild` to `^0.28` through `overrides`. `drizzle-kit` pulls in the deprecated
`@esbuild-kit/esm-loader`, which depends on esbuild 0.18 and carries GHSA-67mh-4wv8-2f99. The
advisory only affects esbuild's dev server, which nothing here runs, and `npm audit fix --force`
would have downgraded `drizzle-kit` thirteen minor versions — so the transitive dependency is
forced forward instead. `npm audit` is part of the gate, so this stops being invisible if it ever
breaks.

### Suppressions

There is exactly **one** in the project, and it should stay that way. `src/app.d.ts` disables
`no-restricted-syntax` for a single line, because SvelteKit's ambient types are keyed on a global
`App` **namespace** and there is no module form of that declaration. It names the rule, covers one
line, and carries its reason above it. Any other suppression should be argued for in review.

## Checks before a commit exists

**The git hooks are the only automatic enforcement this repository has.** Actions do not run under
the account it lives on (see [Continuous integration](#continuous-integration)), so nothing
server-side inspects a push. Everything therefore happens locally, and the hooks are installed by
`npm install` via husky's `prepare` script — there is no separate setup step to forget.

`pre-commit`, ordered loudest-first:

| Stage | What runs                       | Why it is first/at all                                                                                      |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1     | `scripts/scan-secrets.js`       | A leaked credential is the one mistake a later commit cannot undo. Rewriting history does not unpublish it. |
| 2     | `scripts/check-staged-files.js` | `.env` files, private keys, `.npmrc`, databases, and anything over 2 MB.                                    |
| 3     | `lint-staged`                   | Prettier and `eslint --fix --max-warnings 0` on the staged files only, so committing stays fast.            |
| 4     | `npm run check`                 | Types. The one slow step kept here, because a type error is cheap now and expensive later.                  |

`commit-msg` runs commitlint against `@commitlint/config-conventional`. `pre-push` runs the full
`npm run gate` — tests and `npm audit` included — because that is the last point before something
leaves the machine.

### The secret scan

Two scanners, on purpose:

- **secretlint** is an npm dependency, so it exists for anyone who ran `npm install`. It is the
  floor and never optional.
- **gitleaks** has a much broader rule set and reads the staged _diff_ rather than whole files. It
  is a separate binary (`brew install gitleaks`), so it can be absent.

When gitleaks is missing the scan prints `gitleaks: NOT INSTALLED` instead of staying quiet. A hook
that prints nothing when a tool is not installed teaches you to read "no output" as "clean", which
is the exact failure the hook exists to prevent.

Both locks are tested rather than assumed. A staged file carrying a Slack token is refused by both
scanners; a force-added `.env` holding nothing secret-shaped passes _both_ scanners and is refused
by stage 2 — which is why stage 2 exists and why it checks the staged path list directly instead of
trusting the `.gitignore` that was supposed to prevent it.

Run the scan by hand with `npm run scan:secrets`. `--no-verify` is not a workflow: if a check is
wrong, fix the check and say so in the commit.

## Toolchain notes

Everything is on its latest release except two, both held back by the ecosystem rather than by
choice:

- **TypeScript is pinned to 6.x.** TypeScript 7 breaks SvelteKit's `write_tsconfig` (it reaches for
  `ts.sys.readFile`) and ESLint's module loading. Revisit once both support it.
- **Vitest is pinned to 4.x**, because `vitest-browser-svelte` still peers on `vitest@^4`.

## Layout

```
src/lib/server/    server-only code — SvelteKit's bundler refuses to ship it to the browser
src/lib/           shared between server and client
src/routes/        pages and API routes
messages/          translation catalogues, one file per locale (en, de)
```

`src/lib/server/` is load-bearing rather than a convention: anything touching the filesystem, a
lock or a credential goes there, so an accidental client import is a build error rather than a leak.

## Continuous integration

The workflow in `.github/workflows/` is **`workflow_dispatch` only**. The automatic triggers are
present but commented out, because they do not run under the account this repository lives on — a
live `push:` trigger would queue forever and silently block anything waiting on it. Fork this
repository under an account with Actions enabled and uncomment them.

## Licence

[AGPL-3.0-or-later](LICENSE). This is self-hosted software that somebody could otherwise run as a
closed service; the AGPL means a hosted, modified version has to publish its changes.
