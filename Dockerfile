# Build stage — installs all deps (incl. devDependencies) and compiles
# the SvelteKit app via adapter-node.
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Prune devDependencies from the already-resolved node_modules, rather than
# doing a fresh `pnpm install --prod` in the runtime stage: some deps here
# (the icon packages) declare `svelte` as a peerDependency, and a from-
# scratch --prod install re-resolves peers via autoInstallPeers, pulling in
# the entire dev toolchain (svelte, vite, typescript, esbuild, rollup...)
# despite --prod. Pruning the existing tree avoids that re-resolution.
#
# `pnpm prune --prod` still leaves the dev toolchain physically installed:
# the icon packages peer-require @sveltejs/kit, which itself peer-requires
# vite (pulling in esbuild/rollup/lightningcss too) — pnpm's autoInstallPeers
# satisfies that whole chain even under --prod, since peerDependencies aren't
# classified as dev. Verified via grep against the compiled build/server
# output that none of these are ever require()'d at runtime (adapter-node's
# build is self-contained), so it's safe to drop them explicitly.
RUN pnpm prune --prod \
	&& rm -rf \
		node_modules/.pnpm/typescript@* \
		node_modules/.pnpm/vite@* \
		node_modules/.pnpm/esbuild@* \
		node_modules/.pnpm/@esbuild+* \
		node_modules/.pnpm/rollup@* \
		node_modules/.pnpm/@rollup+* \
		node_modules/.pnpm/lightningcss* \
		node_modules/.pnpm/@sveltejs+kit@* \
		node_modules/.pnpm/@sveltejs+vite-plugin-svelte@*

# Runtime stage — only the compiled build output, the pruned production
# node_modules, and the markdown content read from disk at request time.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git is needed by src/routes/api/backup — it shells out to clone/commit/push
# the data/ SQLite dumps to a private backup repo. ca-certificates is
# required separately from whatever Node bundles, since git's own HTTPS
# transport uses the system trust store.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# adapter-node's default request body limit is 512kb, which rejects the
# multi-MB JSON uploads at /spotify-import (and 8MB note attachments) with a
# 413. Baked in here so a deploy works without remembering a Coolify env var;
# still overridable via Coolify's environment UI (see .env.example).
ENV BODY_SIZE_LIMIT=200M

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY src/content ./src/content
# Read from disk at request time by src/lib/server/og.ts (satori needs real
# font bytes — it doesn't use system fonts), same disk-read convention as
# src/content above rather than routing font binaries through Vite's asset
# pipeline.
COPY src/lib/server/fonts ./src/lib/server/fonts

EXPOSE 3000

# SQLite state that must survive redeploys: spotify-history.db
# (src/lib/server/spotify-history-db.ts) and simkl-cache.db
# (src/lib/server/simkl-cache.ts), both default to living under here.
# The VOLUME line alone does NOT persist anything across a
# Coolify redeploy — Coolify replaces the container from the image each
# deploy, so an anonymous volume goes with it. A real deploy needs a
# persistent volume mounted at this same path in Coolify's "Storages" tab
# (see the "Persistent data volume" section in CLAUDE.md).
RUN mkdir -p data
VOLUME ["/app/data"]

# node:22-slim has neither curl nor wget, so the check shells out to Node's
# own http client instead of a missing binary.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD node -e "require('http').get('http://localhost:3000/healthz', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "build/index.js"]
