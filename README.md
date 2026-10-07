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

> **Status: early.** The API surface (`/api/live`, `/api/chat`, `/api/activity`, `/api/events`) and
> the chat page are in. The admin, the database, the links page and the feed are not. Nothing here
> is deployable yet.

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
→ unit tests → browser tests, in that order. One command rather than eight, so nothing can claim to
be "what CI runs" while differing from what runs locally. About 40 seconds.

The order is load-bearing in two places. `svelte-kit sync` is first because it is a prerequisite
rather than a check: without the generated `$app` types, ESLint's type-aware rules see `any`
everywhere and report a wall of unsafe-assignment errors unrelated to the actual code. The build
comes before the type check because Paraglide's messages do not exist in a fresh checkout and
`svelte-check` flags every import of them.

**The browser tests are in the gate, not beside it.** Three defects in the chat page were invisible
to every unit test and to the type checker — a dark background with no text colour, a `Canvas`
background with no `color-scheme`, and a notice label printed twice — because all three are
questions about what a browser computes. They were found by screenshotting the page. A suite that
can answer those questions is only useful if it runs by default, so `test:e2e` installs its own
browser (a fast no-op once cached) and runs with everything else.

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

## Providers: nothing is bound to one vendor

This is software other people install, and **most of them will not have an account with whichever
service this developer uses.** So every capability that reaches a visitor is an interface, and the
service behind it is a deployment's choice.

| capability | implementations that exist or are planned                                |
| ---------- | ------------------------------------------------------------------------ |
| `live`     | **Synchra** · Restream · Twitch Helix · YouTube Data · Kick · Owncast    |
| `chat`     | **Synchra** · Restream · Twitch EventSub · YouTube live chat             |
| `activity` | **Synchra** · StreamElements · Streamlabs · Ko-fi · Patreon · Fourthwall |
| `events`   | **Synchra gateway** · Twitch EventSub · a webhook receiver               |

**One interface per capability, not one per provider.** Owncast can answer "am I live" and nothing
else; Twitch can do live and chat but knows nothing about donations; Ko-fi knows only donations; a
service may be able to push events without being able to answer for a backlog, or the reverse. A
single `Provider` interface would force most of them to stub out most of it, and would make "does
this deployment have chat?" unanswerable without trying it. A provider implements what it can and
declares which in its descriptor.

**A provider never touches HTTP or configuration.** It is handed a `Credential`, returns this
project's own domain types, and throws `ServiceFailure` when it cannot. It does not read the
environment, does not know what a `Response` is, and does not choose status codes — so a provider
contributed later cannot get any of that subtly wrong. `ServiceFailure` lives in its own module
(`src/lib/server/failure.ts`) rather than in `endpoint.ts` for exactly this reason.

**Domain types belong to this project.** `LiveStatus` and `PlatformState` are declared in
`src/lib/live.ts` and nothing is re-exported from a vendor SDK. No field exists because some API
happened to return it.

**One place for auth.** `src/lib/server/providers/credentials.ts` is the only module that resolves a
credential. Today it reads environment variables; when the admin exists it will read encrypted rows
from the database, and **only that file changes**.

**How a provider is chosen** (`registry.ts`): the one configuration names, else the first registered
factory whose credentials are present, else `not_configured`. A named provider that is missing or
unconfigured is a _refusal_, not a fallback — silently using something else than the operator asked
for is impossible to debug from the outside.

There is deliberately **no dynamic loading, container or plugin discovery**. One implementation
exists; machinery for a second one that does not is machinery nobody can check. What the registry
guarantees is the seam: adding Restream means adding a factory to one array, and nothing outside
`src/lib/server/providers/` changes. The selection rules are tested against stand-in providers, so
"prefers the configured one over a merely usable one" is checked even though only Synchra is real.

## Live updates: SSE out, one socket in

The live parts of the page — the chat overlay, the support toasts, the live badge — are pushed, not
polled. `GET /api/events?topics=chat,activity,live` is a Server-Sent Events stream; the event name
is the topic, and the payload is the **same shape the matching REST endpoint returns**, so a client
fetches the backlog from `/api/chat` and then streams with one renderer and one set of field names.

**SSE rather than WebSockets.** The traffic is entirely server→browser; SvelteKit 3 has no WebSocket
support at all (`adapter-node` exposes no upgrade hook), so a socket would mean a second listener and
a second deploy unit; and `EventSource` reconnects and replays `Last-Event-ID` with no client code.
It also stays plain HTTP, so the tunnel, the `/api/` routing and the caching rules apply unchanged.
What would change this is the viewer _typing into_ the site — fan chat, live polls. Not before.

**One socket upstream, held by the server.** The provider's token never reaches a browser, the
upstream sees one client rather than one per visitor, and there is one reconnect implementation
instead of one per tab. It opens in the `init` hook, because the server also has to learn that a
stream went live when nobody has the page open.

**A deployment with no event provider is a normal deployment.** The endpoint still accepts
connections — it heartbeats and stays silent — and the pages poll as they did before any of this
existed. Refusing the connection would make every client branch on something it cannot see.

Two details that are invisible when wrong, so both are tested:

- **The heartbeat.** Without a comment every 20 s, Cloudflare drops an idle stream. With no
  heartbeat everything works locally, works under test, and dies behind a proxy after a minute of
  quiet. The interval is asserted _as passed to the session_, not as a constant — those differ.
- **Deregistration.** `better-sse` learns a client went away from the request's `AbortSignal` and
  from nothing else. SvelteKit wires that to the socket closing, so a real browser does deregister;
  a session that did not would grow the fan-out forever on a public page.

Only one SvelteKit instance is assumed. A second one is what forces a shared bus (Redis, Postgres
`LISTEN`) — a deployment change, not a transport change.

## Libraries over reimplementation

**If a maintained library does the whole job, it does the job.** Four modules ported from the PHP
site were largely reimplementations of things that already exist, and the port deleted far more than
it translated:

| was                                                                           | is now                                              | what went away                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Icons.php` — ~200 lines of pasted SVG path data                              | `lucide` + `simple-icons`                           | **every path**. Brand marks come from the upstream they were copied from; a brand refresh is `npm update`. Kick, Rumble and Bluesky gained real marks instead of a generic ring.                                |
| `Platform.php` — hand-written WCAG luminance, a darken-by-0.85 loop           | `culori` ([`src/lib/color.ts`](src/lib/color.ts))   | the maths, and a latent bug: scaling sRGB channels drifts the hue, and the loop aimed at a luminance threshold as a _proxy_ for a contrast ratio. The ratio is now the condition, and lightness moves in OKLCH. |
| `Config.php` — `.env` parsing, `getenv` fallback, readability checks          | `defineEnvVars` + zod ([`src/env.ts`](src/env.ts))  | all of the parsing. A variable is now declared: validated at startup, typed where used, documented on hover.                                                                                                    |
| `Log.php` — tab-separated format, size rotation, backwards block-walking tail | `pino` + `rotating-file-stream` + `read-last-lines` | the format, the rotation and the tail reader — and "never log a token" stopped being a rule to remember (see below).                                                                                            |

The same rule decided the transport. `better-sse` is the SSE server side — channels, heartbeat,
`Last-Event-ID` replay, spec-compliant framing, no dependencies, and it speaks the Fetch API so a
route returns its `Response` directly. An in-process event bus in front of it would have been a
second registry of the same sessions kept in step by hand, so there is **no bus**: one channel per
topic, and `publish()`/`register()` are the whole interface.

Two choices inside that worth knowing:

- **`rotating-file-stream` over `pino-roll`.** pino transports run in a worker thread resolved by
  name at runtime, which is the thing that breaks once a bundler is involved. An ordinary Writable
  has no such failure mode.
- **`svg()` did not port, deliberately.** It built an element as a string because PHP has no
  component model. The registry is data; a component renders it. That also deleted `forBrowser()`,
  which existed to serialise the registry into `window.PLATFORMS` — the chat imports the module now
  and the bundler tree-shakes it.

### Secrets never reach the log

pino's `redact` censors a configured list of field names before anything is serialised, so a token
passed by accident in a context object cannot reach either destination. This is the one case where
a library replaced a _rule someone had to remember_ with a mechanism, so it is tested directly:
`src/lib/server/log.test.ts` asserts that seven credential-shaped field names, and one nested one
level down, come out as `[redacted]` — and removing a single entry from the list fails the suite.

## Languages

English and German, with more addable in one place. Every user-facing string goes through Paraglide
— `m.nav_home()` rather than `'Home'` — so a message that does not exist is a **compile error**, and
`npm run check` is in the gate.

### Adding a message

1. Add the key to `messages/en.json` and `messages/de.json`, in sorted position.
2. Name it `<namespace>_<name>` in lower snake case: `admin_save`, `error_not_found_title`. The
   namespace is one per module and comes from a closed list in `src/lib/i18n.test.ts`.
3. Use it as `m.admin_save()`.

Adding a **language** is one edit to `project.inlang/settings.json`. `locales` and the `Locale` type
are generated from it, `LOCALE_NAMES` in `src/lib/i18n.ts` becomes a compile error until the new
language has a name, and the catalogue checks pick it up with no registration step. That last part
is the point: the PHP checker this replaces had to be told about each new page by hand, and the two
pages nobody remembered to tell it about went unchecked for months while it reported "Complete".

### Which language a visitor gets

Precedence, highest first (`strategy` in `vite.config.ts`):

|                     |                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`               | `/de/chat` — explicit, shareable, crawlable, and cacheable, because each language is its own URL rather than one URL that varies by header |
| `cookie`            | the visitor picked a language and it should outlive the tab                                                                                |
| `preferredLanguage` | `Accept-Language`, so a first visit already arrives in the right language                                                                  |
| `baseLocale`        | English                                                                                                                                    |

The base language is served **unprefixed**: `/` is English, `/de` is German. That keeps the existing
English URLs, but it breaks `preferredLanguage` on its own — `/` _matches_ the `url` strategy as
English, so the strategies behind it are never consulted and a German browser would silently land on
the English page. `handleBrowserLanguage` in `src/hooks.server.ts` closes that: for a page `GET` with
no language cookie and no language in the URL, it negotiates `Accept-Language` and redirects once.
Those responses carry `Vary: Accept-Language`, without which a cache would serve one visitor's
language to the next.

`/api/**` is excluded from all of it (`routeStrategies`). The API is not a page and has no language
of its own; a client that wants a localized response asks for one.

### What the checks catch, and what they do not

`src/lib/i18n.test.ts` covers the failures a compiler cannot see: a key missing from a translation
(which Paraglide silently serves in English), a German string that still _is_ the English string, a
placeholder lost or invented in translation, an empty value, a misnamed key, an unknown namespace, an
unsorted file. Each one was verified by planting the defect and watching it fail.

Two gaps are **known and still open**, both to be closed when the first UI lands:

- **A hardcoded string that never went through `m.*` at all.** This is the exact failure that shipped
  in the PHP admin — headings and placeholders rendered English in a German page with nothing
  reporting it — and no check here would see it. It needs a scanner over markup literals.
- **Dead keys.** Nothing yet reports a catalogue entry no code refers to. Left out on purpose while
  the catalogue is ahead of the UI, since every key would currently be reported.

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
src/lib/server/              server-only code — the bundler refuses to ship it to the browser
src/lib/server/providers/    one directory per capability seam; add a provider by adding a factory
src/lib/components/          Svelte components
src/lib/                     shared between server and client — domain types live here
src/routes/                  pages and API routes
messages/                    translation catalogues, one file per locale (en, de)
```

Tests sit beside what they test: `*.test.ts` for Vitest, `*.e2e.ts` for Playwright.

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
