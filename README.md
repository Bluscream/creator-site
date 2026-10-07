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

> **Status: early.** In: the API surface (`/api/live`, `/api/chat`, `/api/activity`, `/api/events`,
> `/api/posts`), the chat page, the configuration document layer, and the container.
>
> All five post source kinds now read. `twitch` is the one whose reader has never been run against
> the live API — it needs credentials this repository does not have — so treat it as written and
> tested rather than proven.
>
> Not in: the admin, the links page, and the calendar. There is no schema in the database and
> nothing writes to it. Nothing here is deployable as a finished site.

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

### In a container

```bash
cp .env.example .env
docker compose up -d
```

One service, because the database is a file. There is no database container and no bundled reverse
proxy — anyone self-hosting this already has one, and an opinionated nginx in `compose.yaml` would
only be something to fight. The port is published on `127.0.0.1` for that reason; change it in
`compose.yaml` if you really mean to serve plain HTTP to the network.

Everything persistent — the SQLite file, the log, the feed cache — lives in `/data`, a named volume.
An upgrade is a new image against the same volume. The container runs as uid 1000 and nothing
outside `/data` is writable, so the app cannot rewrite its own code.

The image is **255 MB**, and `Dockerfile` records where that number comes from and what was
rejected. Two things in there are load-bearing and look wrong at a glance:

- Production dependencies install with **`--ignore-scripts`**. The only install script in the
  production tree is `better-sqlite3`'s `node-gyp rebuild`, and the package ships a prebuilt
  `linuxmusl-x64` binding. Letting it compile instead means `python3 make g++` in the image — a
  measured 308 MB, over half the original size, for a compile that is not needed.
  `src/lib/server/db/index.test.ts` opens a real database and runs real queries, so if a future
  version stops shipping a usable prebuild, the gate fails rather than someone's server.
- `lucide` and `simple-icons` are **`devDependencies`**, despite `src/lib/icons.ts` importing from
  both. `ssr.noExternal` in `vite.config.ts` makes Vite bundle them, so Rollup tree-shakes 56 MB of
  icon data down to the 21 glyphs actually referenced. `src/dependencies.test.ts` keeps that
  exemption and the Vite config in step, and otherwise fails on any runtime import of a dev
  dependency — which is invisible locally and fatal in production, since the runtime image installs
  `dependencies` only.

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
| `posts`    | **configured sources** (below) · an aggregator such as Phyllo or Juicer  |

### Posts are the exception: a second seam, by source kind

The other capabilities have one answer per deployment — there is a single answer to "am I live".
Posts do not: an installation reads several platforms at once and the point is that a creator mixes
them. So beneath the capability there is a second seam whose unit is a **source kind**, and the
registry maps a kind to the reader for it rather than choosing one
(`src/lib/server/providers/posts-source.ts`).

| kind      | how it is read                                         | needs           | state                   |
| --------- | ------------------------------------------------------ | --------------- | ----------------------- |
| `feed`    | the site's own RSS, Atom, RDF or JSON Feed             | nothing         | **built**, run live     |
| `youtube` | the channel feed YouTube publishes, as Atom            | nothing         | **built**, run live     |
| `bluesky` | the public AppView, unauthenticated                    | nothing         | **built**, run live     |
| `tiktok`  | the page TikTok renders for embedding, server-rendered | nothing         | **built**, run live     |
| `twitch`  | the official Helix API — videos and clips              | two credentials | **built**, not run live |

"Run live" means the reader has been pointed at the real endpoint and its output checked, which is
how three separate bugs in this table's readers were found. `twitch` is the exception: it needs an
application's client id and secret, so its tests mock the credentials and assert against the shapes
Helix documents. The token dance, the one retry on a 401 and the rule that no error body is ever
repeated are all covered; that the live API agrees is not yet established.

There is no single API for "this creator's posts everywhere", and the services that come closest are
paid, per-seat and want OAuth against each platform — a monthly bill and a credential store for
something the platforms already publish openly. Each platform is therefore read the cheapest way it
actually offers.

**Instagram, X and Threads are absent on purpose.** Instagram needs a Business account and app
review; X removed free API reads. For those the route that does not involve a credit card is a
feed-manufacturing bridge such as [RSS-Bridge](https://rss-bridge.org), run separately — and because
a bridge speaks RSS it arrives as an ordinary `feed` source needing no kind of its own. Keeping the
bridge out of this project is deliberate: its adapters break whenever a platform changes its markup,
and at arm's length a broken bridge costs one empty tab rather than a release here.

**TikTok is read rather than asked, and that is its weakness.** There is no public API for an
account's videos — oEmbed describes one video you already have the url of, and the Display API needs
the account holder to go through OAuth. So `tiktok` parses the state TikTok leaves in the HTML of its
own embed page. It is the most fragile reader here: a layout change upstream breaks it, which is why
it fails that one source with a message naming both possible causes rather than failing the feed. It
also derives each date from the id, because the payload carries no timestamp at all — and that is
what re-sorts the pinned videos TikTok lists first and does not mark.

**Twitch needs two credentials, and reports itself unusable without them.** `TWITCH_CLIENT_ID` and
`TWITCH_CLIENT_SECRET`, from an application at [dev.twitch.tv](https://dev.twitch.tv/console/apps).
The client-credentials grant needs no user sign-in, no redirect and no refresh token, which is what
makes a real API cheaper here than a scraper. Adding the source before the credentials is harmless:
it says what to set, and the rest of the feed carries on. This is also the one reader where an error
message could leak a credential — Helix echoes the request on some errors and the request carries
the client id — so a failure reports the status and never the body, and a test asserts it.

**A kind with no reader yet still answers.** It reports a reason naming what will read it, which
appears in that source's entry in `/api/posts`. A missing registry entry would instead make a
configured source contribute nothing — indistinguishable from a platform that has gone quiet. The
registry's two tables are a partition over every kind, asserted by a test, so adding a kind forces
the decision rather than allowing the omission. Every kind has a reader today, so that fallback is
reached by nothing — it is kept, and tested directly, for the next kind rather than deleted along
with its last user.

**Each source is cached separately**, which is the load-bearing decision. YouTube's feed endpoint
throttles by IP and answers **404 rather than 429**, so an identical request returns 200 once and
404 twice twenty seconds later. One cache entry for the merged list would let a refresh caught
mid-throttle replace fifteen good videos with nothing and serve that for the rest of the interval.
Per-source entries mean a briefly-broken platform keeps showing its last good posts — which is why a
source can report `ok: false` with a non-zero `count`, and why `age` is the oldest source's.

That fallback is deliberately unbounded, because a title, a link and a date do not go stale. A
**signed** image url does: TikTok's cover urls carry an `x-expires` about two days out, so a source
failing for longer than that would serve rows whose every picture is a 404. A provider declares how
long its image urls last (`imageTtl`), and past it the orchestrator drops the picture from a stale
post and keeps the rest — the link still works, which is the part a reader wanted. Most platforms
serve plain cdn urls, declare nothing, and keep their pictures indefinitely.

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

## Configuration: a file, and reading it never fails

Two kinds of setting, kept apart on purpose.

**Secrets and deployment facts** are environment variables — see `.env.example`, which documents
every one, and `src/env.ts`, which is the authoritative list and validates them.

**Everything a creator configures** — branding, links, feed sources, chat and calendar settings —
lives in JSON documents under `<DATA_DIR>/config/`, one per area, each validated by a zod schema
(`src/lib/server/document.ts`). A file rather than a database table because it is the thing a
creator edits, diffs and backs up: `git log` on a config file is a history anyone can read, and
restoring one is a copy rather than a migration. The same schema will generate the admin's form, so
a field's bounds, its default and its editor control cannot drift from one another.

**Reading a document never fails.** A missing file, a truncated one, a file somebody is halfway
through hand-editing — each resolves to the schema's defaults for whatever could not be read, and
says so in the log. That is not leniency for its own sake: the alternative is that a typo in a
config file takes the public site down, which is the worst possible coupling, because the person who
can fix it is the one who can no longer load the admin to fix it. Strictness belongs at the write,
where a mistake can still be reported to whoever is making it.

Two layers do it. The schema defaults or `.catch()`es each field, so **one bad entry costs that
entry** and the rest keeps working — a half-filled row is a normal state for a file someone is
editing. Underneath, an unsalvageable document falls back whole.

**The parse is cached on the file's mtime and size**, not on a timer, so an edit takes effect on the
next request rather than after an arbitrary interval. Size is in the stamp because a coarse
filesystem clock can give two writes the same mtime, and the admin's atomic save is a `rename` —
exactly when two writes land close together.

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

Both of the gaps that were open here are **now closed**, in `src/lib/i18n-coverage.ts`, once there
was a UI for them to look at:

- **A hardcoded string that never went through `m.*` at all** — the exact failure that shipped in the
  PHP admin, where headings and placeholders rendered English in a German page and nothing reported
  it. A catalogue check cannot see it: a string that was never a key cannot be a missing
  translation. Every `.svelte` file is parsed with **`svelte/compiler`** and its markup walked for
  visible text. The parser matters — a regex has to decide whether `<!-- Save -->` is a comment,
  whether `class="Save me"` is an attribute, and whether `'Save'` in the `<script>` block is markup,
  and gets at least one wrong. It found four strings in the SvelteKit scaffold's front page, which
  is now a real translated page.
- **Dead keys**, and the reverse: a key referenced in code that the catalogue lacks. Paraglide
  resolves a missing key to _its own name_, so a typo renders `chat_emtpy` on the page rather than
  failing. Ten dead keys were found; six described UI that should exist and now does — an error
  page, a language switcher, a front page — and four belonged to an admin that does not, so they
  were removed and will come back with it.

Each check was verified by planting the defect it exists to catch, including the checker's own
blind spots: that it does not report a comment, an attribute, CSS content or a script literal.

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
src/lib/server/providers/    the capability seams; add a provider by adding a factory
src/lib/server/db/           the SQLite connection and the Drizzle schema
src/lib/components/          Svelte components
src/lib/                     shared between server and client — domain types live here
src/routes/                  pages and API routes
messages/                    translation catalogues, one file per locale (en, de)
<DATA_DIR>/config/           the creator's configuration documents — not in the repository
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
