# creator-site, as one container.
#
# Multi-stage: the build stage has the whole toolchain, the runtime stage has Node, the production
# dependencies and the compiled output. Nothing a build needed — no TypeScript, no Vite, no test
# runner, no source — reaches the image that runs on someone's server.
#
# ### Why `npm ci --omit=dev` is run twice rather than copied from the build stage
#
# The build stage installs devDependencies, which is most of `node_modules` and none of what runs.
# A second `--omit=dev` install is how the runtime stage gets only the production tree.
#
# ### Why the runtime install is `--ignore-scripts`
#
# The only production dependency with an install script is `better-sqlite3`, whose script is
# `node-gyp rebuild` — a from-source compile needing python3, make and g++. Installing those cost a
# measured **308 MB**, about half the image, and the compile is unnecessary: version 13 ships
# prebuilt bindings in the tarball, `linuxmusl-x64.node` among them, which is exactly this platform.
#
# So the runtime stage skips install scripts and uses the prebuild. `--ignore-scripts` rather than
# relying on npm's `allowScripts` gate to skip it for us, which it currently does — silently, and
# only as long as that default holds. `src/lib/server/db/index.test.ts` opens a real database, so if
# a future version drops the prebuild for this platform the gate fails rather than production.
#
# If a dependency ever genuinely must compile, add the toolchain as a `--virtual` set *inside the
# same `RUN`* that uses it. A layer is a diff: installing in one layer and `apk del`-ing in the next
# leaves the whole toolchain in the image and only adds a layer that hides it. That mistake is what
# made this image 646 MB.
#
# ### Size, and where the floor is
#
# **255 MB**, down from 646 MB. Measured, so that the next person tempted to optimise this knows
# what is left to win:
#
#   185 MB  `node:26-alpine` — mostly the Node binary. The slimmest official image there is.
#    67 MB  production `node_modules`, of which `better-sqlite3` is 26 MB and `drizzle-orm` 17 MB
#     3 MB  the build output
#
# So roughly three quarters is the base image. Two things were considered and rejected:
#
#   - Pruning the seven unused platform bindings from `better-sqlite3` saves ~21 MB, but has to be
#     keyed to `TARGETARCH` or it silently breaks arm64 builds. Not worth the failure mode.
#   - A non-official or distroless base saves more, at the cost of nobody being able to rely on the
#     security updates that make the official image worth using.

ARG NODE_VERSION=26


# --- build ---------------------------------------------------------------------------------------

FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /app

# The manifests alone first, so the dependency layer is reused whenever only source changed — which
# is almost every build.
COPY package.json package-lock.json ./

# `--ignore-scripts` here for a second reason beyond the one above: a build should not execute
# arbitrary code from the dependency tree, and nothing this build needs is produced by an install
# script. Vite externalises `better-sqlite3` rather than bundling it, so the native binding is never
# loaded while building — only at runtime, in the stage that actually serves requests.
RUN npm ci --ignore-scripts

COPY . .

# The build needs a value to satisfy the environment schema; the real one arrives at runtime. A
# literal rather than a mount, because nothing in a build should be able to read a real credential,
# and a build argument would be visible in the image history.
ENV DATABASE_URL=/data/creator-site.db

RUN npm run build


# --- runtime -------------------------------------------------------------------------------------

FROM node:${NODE_VERSION}-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Where the database, the log and the cache go. A volume, so none of it is inside the image and an
# upgrade is a new image against the same data.
ENV DATA_DIR=/data
ENV DATABASE_URL=/data/creator-site.db

# `node` is a user the base image already provides, with uid 1000. The application never writes
# anywhere but `/data`, so nothing else needs to be writable — and it must not run as root, because
# the one thing a web server should not be able to do is rewrite its own code.
RUN mkdir -p /data && chown node:node /data

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/build ./build

USER node

EXPOSE 3000

# Answered by the application itself rather than by a shell loop: `/api/live` exercises the route
# layer, the environment and the provider seam, and reports `ok` whether or not a provider is
# configured — so an unconfigured install is healthy, which is correct. A 500 or a dead socket is
# not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
