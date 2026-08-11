# Deployment

Deployed as a Docker image (SvelteKit `adapter-node`), run behind Coolify + Traefik as the reverse proxy.

## Docker build ([Dockerfile](../Dockerfile))

Multi-stage build:

1. **`build` stage** — `node:22-slim`, installs pnpm via corepack, installs **all** deps (including devDependencies) with a frozen lockfile, then `pnpm run build`.
2. **Dev-dependency pruning** — rather than doing a fresh `pnpm install --prod` in the runtime stage, the build stage runs `pnpm prune --prod` against the *already-resolved* `node_modules` tree, then explicitly `rm -rf`s a specific list of dev-toolchain packages (`typescript`, `vite`, `esbuild`, `rollup`, `lightningcss`, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`).

   This exists because a from-scratch `--prod` install would re-resolve peer dependencies via pnpm's `autoInstallPeers` — the icon packages (`@lucide/svelte`, `@icons-pack/svelte-simple-icons`) declare `svelte` as a peerDependency, which transitively peer-requires `@sveltejs/kit`, which peer-requires `vite` (pulling in `esbuild`/`rollup`/`lightningcss` too). pnpm treats peerDependencies as always-installed regardless of `--prod`, so a plain prod install would silently drag the entire dev toolchain back in. Pruning the existing tree avoids that re-resolution. This was verified safe by grepping the compiled `build/server` output to confirm none of the pruned packages are ever `require()`'d at runtime — adapter-node's build output is self-contained.
3. **`runtime` stage** — fresh `node:22-slim`, copies over: the compiled `build/` output, the pruned `node_modules`, `package.json`, `src/content` (markdown, read from disk per request — see [content-pipeline.md](content-pipeline.md)), and `src/lib/server/fonts` (OG image generation needs real font bytes, not system fonts).

## Health check

`node:22-slim` has neither `curl` nor `wget`, so the Dockerfile's `HEALTHCHECK` shells out to Node's own `http` client to hit `GET /healthz` ([+server.ts](../src/routes/healthz/+server.ts)) instead.

## Required environment variables

`ORIGIN` **must** be set in production — adapter-node needs it to build absolute URLs and validate incoming request origins when running behind a reverse proxy (Traefik). Set it in Coolify's environment variables UI, **never in a committed `.env`** — this is deliberately excluded from version control. See the top-level README's env var table for everything else, all of which is optional.

`BODY_SIZE_LIMIT` matters if you plan to use `/spotify-import` for large exports (extended streaming history can be tens of MB across many files) — adapter-node's default (512kb) will reject them. Use a byte count with a `K`/`M`/`G` suffix, or the literal string `Infinity` — **not** `0`, which SvelteKit treats as a 0-byte limit rather than "unlimited".

## Persistent data volume

See the top-level README's [Persistent data](../README.md#persistent-data) section for the SQLite files and upload directories under `data/`. The critical thing the Dockerfile's `VOLUME ["/app/data"]` line does **not** do: persist anything across a Coolify redeploy. Coolify replaces the container from the image on every deploy, so an anonymous Docker volume is discarded along with it.

**Before the first real deploy**, go to the app's **Storages** tab in Coolify and add a persistent volume mounted at `/app/data` (any volume name works). Skipping this step means `spotify-history.db` — irreplaceable, real user content — gets wiped on the very next redeploy.

A persistent volume only protects against redeploys, not against the server disappearing entirely — see [backups.md](backups.md) for off-box backups.
