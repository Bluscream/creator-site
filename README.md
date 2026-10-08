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
> `/api/posts`), the published feeds (`/feed.atom`, `/feed.json`), the chat page, the configuration
> document layer, and the container.
>
> All five post source kinds now read. `twitch` is the one whose reader has never been run against
> the live API — it needs credentials this repository does not have — so treat it as written and
> tested rather than proven.
>
> Signing in works, end to end: accounts and revocable sessions in the database, migrations that
> apply themselves on startup, Discord as the first sign-in provider behind a seam, and an admin
> shell behind a role guard.
>
> Not in: the pages the admin shell will hold — links, feed sources, the calendar — and the public
> links page. Nothing here is deployable as a finished site.

## Running it

```bash
npm install
npm run dev
```

|                       |                                                              |
| --------------------- | ------------------------------------------------------------ |
| **`npm run gate`**    | **the whole gate — run this before claiming anything works** |
| `npm run dev`         | development server with HMR                                  |
| `npm run build`       | production build (`@sveltejs/adapter-node`)                  |
| `npm run preview`     | serve the production build locally                           |
| `npm run check`       | `svelte-check` over the whole project                        |
| `npm run lint`        | Prettier check and ESLint                                    |
| `npm run format`      | rewrite with Prettier                                        |
| `npm run test:unit`   | Vitest                                                       |
| `npm run test:e2e`    | Playwright                                                   |
| `npm run db:generate` | generate a migration from a schema change                    |
| `npm run db:studio`   | browse the database                                          |

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

| kind      | how it is read                                                                               | needs           | state                   |
| --------- | -------------------------------------------------------------------------------------------- | --------------- | ----------------------- |
| `feed`    | the site's own RSS, Atom, RDF or JSON Feed                                                   | nothing         | **built**, run live     |
| `youtube` | the channel feed YouTube publishes, as Atom                                                  | nothing         | **built**, run live     |
| `bluesky` | the public AppView, unauthenticated                                                          | nothing         | **built**, run live     |
| `tiktok`  | the page TikTok renders for embedding, server-rendered                                       | nothing         | **built**, run live     |
| `twitch`  | the official Helix API — videos and clips                                                    | two credentials | **built**, not run live |
| `kick`    | Kick's own maintained GrayJay plugin, sandboxed                                              | nothing         | **built**, run live     |
| `grayjay` | the same route for Dailymotion, Odysee, SoundCloud, Nebula, Bitchute, PeerTube, media.ccc.de | nothing         | **built**, run live     |

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

**Kick borrows a maintained reader instead of writing one.** Kick documents no public API for a
channel's past broadcasts, and the endpoint its own client calls sits behind Cloudflare, which
answers a plain request with a challenge page. The route that works is the one the
[GrayJay](https://grayjay.app) app uses — so `kick` loads the official Kick plugin and asks it,
rather than growing a scraper here that would break quietly and need watching.

The plugin is third-party JavaScript, so it runs in a WebAssembly sandbox with no Node globals and
no network except through this project's own `context.fetch`:
[`grayjay-plugin-host`](https://github.com/Bluscream/grayjay-plugin-host), a library extracted from
this project's research and published separately because it is useful to anyone on Node. What it
costs is a sandbox and two extra fetches per read, which is measured against the refresh interval
rather than against a page view. The plugin is fetched from Kick's published url at run time and
never vendored, which is also what keeps it current — and the trade is deliberate: the
Kick-specific knowledge is maintained by people who watch Kick change.

Its live tests are opt-in behind `RUN_LIVE=1`, because they reach both Kick and the plugin's own
host. That is where the one bug this reader has had so far was found: the host was filling GrayJay's
value classes from the wrong argument shape, so every post arrived with a corrupt id, author and
thumbnail while its name and url looked perfectly fine.

**`grayjay` is the same route generalised.** Once the host library could parse HTML and resolve
URLs, the number of plugins that load and return real content went from two to forty-five — at which
point a reader per platform would have meant forty-three near-identical files. So Kick keeps only
its own part (a handle like `xqc` is what somebody has to hand for Kick, not a url) and everything
else is shared.

The supported platforms are a **fixed table**, not a manifest url an admin can set. A plugin url in
a config document would let an admin point the server at any JavaScript on the internet, and "it is
sandboxed" is not a good enough answer to that. Every entry in the table is loaded and read from in
a live test, which is what keeps it from claiming a platform it cannot deliver. Rumble is absent
because its plugin needs TLS impersonation Node cannot do, and Niconico because it loaded but
returned nothing for the channel tried.

PeerTube was excluded for that second reason and should not have been: it was failing for two
reasons at once — a host-library bug that refused every request a wildcard plugin made, and a
channel that genuinely had no videos. It is federated, so it is matched on its channel path rather
than a host list, which also means this will fetch from whatever instance an admin names. The
library refusing private addresses is what keeps that from being dangerous.

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

**The merged posts are published as a feed, too.** `/feed.atom` and `/feed.json` carry the same
list — every platform, newest first — so somebody can subscribe to a creator once instead of five
times. Both are generated by one module from one list, so they cannot drift apart, and a reader
polling them costs nothing upstream: they go through the same per-source cache as the page.

Three decisions worth knowing:

- **An entry's id is the post id, not its url.** A reader keys read/unread state on the id, so a
  platform changing the shape of its urls would otherwise mark every old post unread again.
- **`updated` is the newest post's date, not the time of generation.** A feed whose `updated` moved
  on every fetch would defeat every conditional request a reader makes.
- **The feed's own url comes from the request**, not from configuration, so one installation serves
  a correct feed on every hostname pointed at it — a domain, a Tailscale name, a tunnel — with no
  setting that can disagree with reality. Behind a reverse proxy that requires
  **`PROTOCOL_HEADER=x-forwarded-proto` and `HOST_HEADER=x-forwarded-host`**, which `compose.yaml`
  sets; without them the app sees `127.0.0.1:3000` and the feeds advertise urls nobody can reach.
  `ORIGIN` is not the knob for this — it does not change what the app sees as its own url, which
  was checked against a running build rather than assumed. Delete the two headers if you expose the
  container directly, since a client could otherwise set `X-Forwarded-Host` itself.

The feed's title comes from `title` in the feed document, falling back to the request's host — a
feed must have a title to be valid, and an installation nobody has named should still publish a
valid one. That field moves to the site document once there is one.

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

**Writing is the opposite of reading in every way.** `write()` validates first and refuses rather
than throwing, so the admin can show which field is wrong; takes a lock, so the version check and
the write are one step; copies the current document into `<DATA_DIR>/backups/<name>/` keeping the
last 20, because the point of configuration-as-a-file is that a mistake is recoverable; and replaces
by `rename`, so a reader never sees half a document. It writes the _parsed_ value, defaults filled
in, so the file on disk is the whole document rather than only what someone changed.

A save is optimistic: `version()` hands the editor a token and `write(value, { expect })` refuses
with `conflict` if the file has changed since, so two admins with the editor open are told rather
than the second silently winning. The token is a **content hash**, not a timestamp — two saves
inside the same coarse tick share an mtime, so a timestamp token would let the second look like it
had seen the first.

Two details in there were bugs first and comments second. The backups are named with a **sequence
number** ahead of the timestamp: named by timestamp with a content hash to break ties, two saves in
the same millisecond sort by _content_, and pruning by name then deletes the newer one — a test that
writes 25 documents in a loop caught it keeping a version older than the window. And the write drops
the read cache explicitly, because a `rename` inside one tick can change neither mtime nor size, so
the next read would otherwise serve what was just replaced.

## Accounts: a person, their identities, and revocable sessions

Three tables (`src/lib/server/db/schema.ts`), and four decisions worth stating.

**A person is not a Discord account.** `users` holds who somebody is and what they may do;
`identities` holds each way they sign in, unique on `(provider, provider_user_id)`. Somebody who
signs in with Discord today and adds another provider tomorrow is one account, and the thing that
owns their role is neither provider. The uniqueness is a database index rather than a
check-then-insert, because two sign-ins arriving together would both pass the check.

**The session token is never stored.** The cookie carries 32 random bytes; the row's primary key is
their SHA-256. A database that leaks therefore leaks nothing usable — an attacker holding every row
cannot build a cookie, because the hash does not reverse. Resolving a session is hashing the cookie
and selecting by primary key, the same single-row lookup storing it plainly would have been, so the
property costs one hash. What rows buy over a signed cookie is revocation: signing out on a shared
machine has to invalidate the session rather than ask whoever holds it to stop presenting it.

Sessions last 30 days and slide — renewed when more than halfway through, so a creator who posts
weekly is never signed out while an abandoned browser still expires. Renewing on every request
would make every page view a write.

**The first account on an unclaimed install becomes the owner**, and registration is otherwise off
until someone turns it on. That is how first-run setup works without a password printed in a log or
baked into an environment variable. It is a real exposure window on a fresh install reachable from
the internet, and naming it is better than pretending otherwise: whoever signs in first owns the
site. The window closes at the first sign-in.

**A stored role is checked, not trusted.** The column is a typed string, not a constraint, so a row
holding something that is not a role — a hand edit, a downgrade from a version that added one —
resolves to the narrowest role and says so in the log. Failing closed is the only safe direction for
a value that decides what somebody may do.

### Migrations apply themselves

`drizzle/` holds generated migrations, committed, and `src/lib/server/db/migrate.ts` applies them
when the connection opens. Not `drizzle-kit push`, which recomputes a diff each time and turns a
column rename into a drop and an add on somebody else's data; and not a deploy step, because a deploy
step is a thing a self-hoster has to know about and the failure mode of not knowing is a 500 on every
page. `docker compose up` on a new version is the whole upgrade.

Two instances starting at once would both try; SQLite serialises them and the second finds the
journal already says those migrations are applied. This product is one SQLite file on one disk, and
if that ever stops being true, this is one of the places that has to change.

`src/lib/server/db/migrate.test.ts` applies the committed migrations to an empty database and
compares every column, type, null-ness, default and index against the test fixture's own DDL — which
is how a forgotten `npm run db:generate` fails the gate instead of failing an upgrade.

## Signing in: a seam, one flow, one guard

Four files under `src/lib/server/auth/`, and the split between them is the design.

**A provider knows two things and nothing else**: where to send somebody, and how to turn the code
that comes back into an identity (`sign-in-provider.ts`). Discord is the one implemented
(`discord-sign-in.ts`), and it is implemented _behind the interface_ for the same reason the chat
and post providers are — this is a product other people install, and a creator who does not use
Discord should not be unable to run their own site. Adding Google is adding a file and an array
entry.

**The flow is written once, for every provider** (`flow.ts`). The parts that are easy to get subtly
wrong should not exist once per vendor: the constant-time `state` comparison, the allow-list on
where a visitor may be sent afterwards, the cookie flags, and clearing a pending flow whether or not
it succeeded. `arctic` supplies the provider plumbing — about 200 lines of hand-rolled authorize-URL
building and token exchange deleted from the PHP original, per provider.

**The guard is a layout, not a page check** (`guard.ts` and `src/routes/admin/+layout.server.ts`). A
per-page check is a check a new page can be written without, so the default under `/admin` is
"protected" and a page opts out by not living there. `src/routes/admin/page.svelte.e2e.ts` asserts
that over HTTP, because the unit tests cannot tell whether the guard is _wired to the route_.

Decisions worth stating:

- **`identify` and nothing else.** Not `guilds`, not `email`. The site needs to know who signed in
  and nothing more. The access token is used exactly once, to read the account, and then dropped —
  never stored, so there is no refresh flow and nothing to leak later.
- **No failure message carries the provider's own words.** The token exchange request contains the
  client secret and a rejected request can be echoed back in the response, so a message built from
  an error body is a credential on a visitor's screen. There are tests that assert exactly that.
- **The pending flow is a cookie, not a row.** A server-side one would need sweeping, would not
  survive a restart mid-flow, and would make a sign-in _attempt_ a database write available to
  anyone who can reach the login route. Ten minutes, `HttpOnly`, `Secure`.
- **`SameSite=Lax`, not `Strict`.** The callback arrives as a top-level navigation from the
  provider, and `Strict` withholds the cookie on exactly that request — so the visitor would land
  signed out and try forever. `Lax` still withholds it from cross-site `POST`s.
- **Signing out is a `POST`.** On a `GET` it can be fired by an `<img>` on another site, a link
  preview or a prefetcher, and the creator is signed out repeatedly with no way to tell why. The
  session _row_ is deleted, not just the cookie.
- **What the `state` check does not protect.** It stops a third party who can make the victim's
  browser issue the callback, because they cannot read or set that cookie. It does not stop somebody
  who can already write cookies for this site — who can do worse things than force a sign-in. The
  destination is allow-listed regardless of where it came from, so even a planted cookie can only
  send the visitor to a path on this site.

### Who administers an install

`ADMIN_ACCOUNTS` names them, as `provider:id` pairs — the provider's own id, never a username, which
its owner can change and somebody else can then register. An account it names is an `admin` as soon
as it exists and is _raised_ back to `admin` if it ended up lower. It never demotes anybody: an owner
named there stays the owner.

That is the escape hatch which makes the rest of the role system safe to use, and it narrows the one
uncomfortable property of the account store. The first account on an unclaimed install becomes its
owner — which is how first-run setup works without a password printed in a log — and with
`ADMIN_ACCOUNTS` set, a stranger who got there first would own an install whose real administrator
can still sign in and demote them. With it unset, nothing stops them. **Set it before putting a fresh
install on the internet**; the sign-in page says so out loud while it is unset, because hiding it
would not make it less true.

`ALLOW_REGISTRATION` is off by default. Signing in to an account that already exists is unaffected,
and so is claiming an empty install.

### The pragmas are not optional

SQLite defaults foreign keys **off**, per connection. Without `PRAGMA foreign_keys = ON` the
`onDelete: 'cascade'` the schema relies on does nothing at all, and nothing reports it: deleting a
user would leave their sessions behind, resolvable until they expired. `journal_mode = WAL` because a
request that renews a session is a writer and would otherwise block concurrent readers, and
`busy_timeout` so a second writer waits rather than throwing. All three are asserted in
`src/lib/server/db/index.test.ts`, including that the cascade actually fires — a pragma SQLite does
not understand is ignored silently.

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

## Backup and restore: one file, and nothing half-applied

One password-protected archive holds the database and every configuration document:
`tar` → `gzip -9` → AES-256-GCM with a scrypt-derived key, all from `node:crypto` and `node:zlib`
plus `tar-stream`, so restoring needs nothing installed on a machine that is probably already
broken. `src/lib/server/backup/archive.ts` is the container and knows nothing about this project;
`src/lib/server/backup/index.ts` decides what goes in one.

Four decisions are worth stating, because each one is a way this goes wrong quietly:

- **The database cannot be copied as a file.** A live SQLite database has committed data in its
  write-ahead log that is not in the `.db` file yet, so `tar`ing the file produces an archive that
  restores cleanly in a test and silently loses the most recent writes months later. It goes
  through `VACUUM INTO`, from a **read-only** connection, so taking a backup can never be the thing
  that corrupts one. A test leaves a writer open with an uncheckpointed WAL and asserts the row
  comes back.
- **Compatibility is the migration list, not a version string.** `package.json` says `0.0.0` and
  would keep saying it. What decides whether this build can use a database is which migrations it
  has, and Drizzle records that in the database. A backup carrying a migration this build does not
  ship is refused by name; one carrying fewer is rolled forward on the next open, which is the
  direction a restore is usually for.
- **Nothing is replaced until everything is checked.** A restore unpacks to a staging directory,
  verifies every digest, opens the staged database and asks SQLite whether it is intact, and only
  then renames things into place — and what was there before is moved aside, not deleted. Every
  refusal test also asserts the install was left alone, because "it refused" and "it changed
  nothing" are different claims.
- **The archive is treated as hostile.** It is, by definition: a restore reads a file somebody was
  sent. Traversing names, symlinks, hard links and decompression bombs are all refused, and the
  whole header is the AES-GCM additional data so the key-derivation parameters written into it
  cannot be weakened by an attacker.

Uploads, themes and the plugin list belong in here too and are not written yet, because none of
them exist. They are more entries under their own prefixes; the restore's allow-list is the one
place that needs extending.

## Layout

```
src/lib/server/              server-only code — the bundler refuses to ship it to the browser
src/lib/server/providers/    the capability seams; add a provider by adding a factory
src/lib/server/auth/         the sign-in seam, the OAuth flow, the role guard
src/lib/server/backup/       the backup container, and what an install puts in one
src/lib/server/db/           the SQLite connection, the Drizzle schema and the migrator
drizzle/                     generated migrations — committed, and applied on startup
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
