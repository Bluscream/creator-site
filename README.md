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

|                     |                                             |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | development server with HMR                 |
| `npm run build`     | production build (`@sveltejs/adapter-node`) |
| `npm run preview`   | serve the production build locally          |
| `npm run check`     | `svelte-check` over the whole project       |
| `npm run lint`      | Prettier check and ESLint                   |
| `npm run format`    | rewrite with Prettier                       |
| `npm run test:unit` | Vitest                                      |
| `npm run test:e2e`  | Playwright                                  |
| `npm run db:push`   | apply the Drizzle schema to the database    |
| `npm run db:studio` | browse the database                         |

Node **26** or newer (`.nvmrc` pins it; the deployment container runs the same major).

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
