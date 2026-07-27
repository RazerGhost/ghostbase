# ghostbase

Personal link hub + devlog for [razerghost.xyz](https://razerghost.xyz), built with SvelteKit (Svelte 5), Tailwind CSS 4, and mdsvex. Deployed via Docker (adapter-node) behind Coolify/Traefik. Built with [Claude Code](https://claude.com/claude-code) — the devlog covers a bunch of what that looked like in practice.

> Looking for guidance aimed at Claude Code / an AI assistant working in this repo? See [CLAUDE.md](CLAUDE.md). This README is the human-facing version — more setup detail, less "how to modify this codebase."
>
> For implementation-level detail on any one subsystem, see [docs/](docs/README.md).

## License

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE). In short: fork it, modify it, self-host your own copy — for free, for yourself or to share — but you may not sell it, resell it, or run it as a paid/commercial hosted service.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Link hub / landing page |
| `/projects` | Project showcase, content-driven (see below) |
| `/devlog` | Blog posts written in markdown |
| `/gear` | Hardware/software gear list, from [config.ts](src/lib/config.ts) |
| `/watchlist` | Currently-watching + full library, pulled from Simkl |
| `/watching` | Legacy route, redirects to `/watchlist` |
| `/listens` | Spotify listening history stats, built from an imported data export |
| `/notes` | Private notes area, gated behind GitHub OAuth login (owner-only) |
| `/spotify-import` | Upload UI for Spotify history exports (same GitHub gate as `/notes`) |
| `/admin` | Private dashboard (same GitHub gate) linking to every editing tool: devlog/projects editors, status editor, watchlist cache inspector, media library, and backup status |

## Getting started

```bash
pnpm install
cp .env.example .env   # fill in what you need — see below
pnpm dev
```

- `pnpm dev` — Vite dev server
- `pnpm build` — production build (adapter-node, outputs to `build/`)
- `pnpm preview` — preview the production build
- `pnpm check` — type-checking via `svelte-kit sync` + `svelte-check`
- `pnpm test` — Vitest suite (`src/**/*.test.ts`)
- `node build/index.js` — run the built server directly (what the Docker image's `CMD` does)

Package manager is pnpm (`packageManager: pnpm@11.3.0` — use corepack).

### Environment variables

Every integration below is optional and degrades gracefully — the site runs fine with an empty `.env`, just with those widgets/pages showing a "not connected" state instead of data. Full setup instructions (including one-time OAuth flows) live in [docs/environment.md](docs/environment.md); summary:

| Variable(s) | Powers | Notes |
| --- | --- | --- |
| `ORIGIN` | adapter-node absolute URLs | **Required in production** behind a reverse proxy. Set in Coolify's UI, not a committed `.env`. |
| `SPOTIFY_CLIENT_ID/SECRET`, `SPOTIFY_REFRESH_TOKEN` | Recently-played history + `/listens` live scrobbling | One-time OAuth authorization-code flow to mint the refresh token. The "now playing" widget itself gets live track data from Lanyard/Discord presence, not this. |
| `SIMKL_CLIENT_ID`, `SIMKL_ACCESS_TOKEN` | `/watchlist` | Simkl's PIN device flow; token is long-lived (~5yr), no refresh needed. |
| `GITHUB_CLIENT_ID/SECRET`, `SESSION_SECRET` | `/notes`, `/spotify-import` login gate | GitHub OAuth App restricted to a single allow-listed username (`site.githubUsername`). |
| `NOTES_DB_PATH`, `NOTES_ATTACHMENTS_DIR` | `/notes` storage | Default to `./data/*`; must live on a persistent volume in production. |
| `MEDIA_DIR` | `/admin/media`, devlog/project cover/gallery/body images | Default to `./data/media`; must live on a persistent volume in production. Served publicly (no login), unlike `NOTES_ATTACHMENTS_DIR`. |
| `SIMKL_CACHE_DB_PATH` | Simkl lookup cache | Losing this is non-destructive — it just re-warms. |
| `STATUS_DB_PATH` | `/notes/status`, homepage "Right now" card | Default to `./data/status.db`. Losing this just reverts to the hardcoded fallback in `status-db.ts`. |
| `SPOTIFY_HISTORY_DB_PATH` | `/listens` storage | Populated by uploading a Spotify "extended streaming history" export at `/spotify-import`. **Not trivially rebuildable if lost** — the export is a one-time historical dump. |
| `SPOTIFY_SCROBBLE_SECRET` | `/api/spotify/scrobble` | Optional live-scrobbling endpoint to fill the gap between manual exports; intended to be hit on a schedule. |
| `BACKUP_SECRET`, `BACKUP_GIT_REMOTE` | `/api/backup` | Optional git-based backup of `data/` to a private repo; intended to be hit on a schedule. See below. |
| `BODY_SIZE_LIMIT` | Upload size cap | Extended streaming history exports can be tens of MB; raise this from adapter-node's 512kb default. |

## Architecture

**Content pipeline (devlog + projects)**: Both are markdown files with frontmatter — devlog posts in `src/content/devlog/*.md` (named `YYYY-MM-DD-slug.md`), project entries in `src/content/projects/*.md`. [devlog.ts](src/lib/server/devlog.ts) / [projects.ts](src/lib/server/projects.ts) read them off disk at request time with `gray-matter` (frontmatter) + `marked` (render). Content is copied into the Docker runtime image separately from the compiled app (see [Dockerfile](Dockerfile)) since it's read from disk, not bundled by Vite.

**Devlog embeds**: Markdown posts can embed interactive Svelte components via `<div data-embed="Name"></div>` — things like a live terminal replay, a before/after slider, or a Mermaid diagram. Available components are registered by name in [registry.ts](src/lib/components/devlog-embeds/registry.ts); [mount-embeds.ts](src/lib/actions/mount-embeds.ts) is a Svelte action that scans rendered post HTML and mounts the matching component into each placeholder.

**External integrations** (all optional, all degrade gracefully):
- **Spotify "now playing"** ([SpotifyWidget.svelte](src/lib/components/SpotifyWidget.svelte)) — live track data comes from [Lanyard](https://github.com/Phineas/lanyard)/Discord presence ([lanyard.svelte.ts](src/lib/stores/lanyard.svelte.ts), shared with the Discord widget below), not Spotify's own API — polling that directly, from every visitor, was enough to trip Spotify's rate limit. Recently-played history and `/listens` live scrobbling still use the refresh-token OAuth flow ([spotify.ts](src/lib/server/spotify.ts), access token cached in-memory per server process, plus a 30s cache on the recently-played call itself), since Lanyard doesn't expose history.
- **Discord presence** ([DiscordPresence.svelte](src/lib/components/DiscordPresence.svelte)) — via [Lanyard](https://github.com/Phineas/lanyard), keyed off a public Discord user ID in `config.ts`. No secret needed, but the account must have joined Lanyard's Discord server at least once, and Spotify status only shows while actively online in Discord with Spotify activity sharing enabled.
- **GitHub activity + repo stats** ([GithubActivity.svelte](src/lib/components/GithubActivity.svelte), [GithubRepoStats.svelte](src/lib/components/GithubRepoStats.svelte)) — proxied through [github.ts](src/lib/server/github.ts) rather than calling `api.github.com` from the browser, so requests are cached for 5 minutes and (via the same `GITHUB_CLIENT_ID`/`SECRET` used for login, sent as Basic Auth) get GitHub's 5,000/hour authenticated rate limit instead of 60/hour unauthenticated.
- **Simkl** ([simkl.ts](src/lib/server/simkl.ts)) — powers `/watchlist`; results cached to survive Simkl API outages (falls back to a full-library snapshot).

**`/listens`**: built from Spotify's own "extended streaming history" export, not the live API alone (which only exposes the last ~50 plays, not historical totals). Export JSON files are uploaded at `/spotify-import` (GitHub-gated), parsed and deduplicated into `spotify-history.db` by [spotify-history.ts](src/lib/server/spotify-history.ts) / [spotify-history-db.ts](src/lib/server/spotify-history-db.ts) — inserts are idempotent on `(played_at, spotify_uri, ms_played)`, so re-uploading overlapping exports is safe. A separate live-scrobbling endpoint polls Spotify's recently-played API to fill the gap between manual exports; re-importing an export clears out any live-scrobbled rows it now covers, since scrobbled `ms_played` is only an estimate.

**Auth**: a single GitHub OAuth flow ([github-auth.ts](src/lib/server/github-auth.ts), `src/routes/auth/*`) gates both `/notes` and `/spotify-import`. Only the GitHub username configured as `site.githubUsername` in [config.ts](src/lib/config.ts) is allowed to complete login; anyone else is rejected at the callback with no session issued. Sessions are HMAC-signed cookies ([session.ts](src/lib/server/session.ts)).

**Site-wide config**: [config.ts](src/lib/config.ts) centralizes site metadata, social links, nav links, and the gear list — check here before hardcoding any of that elsewhere.

**Styling**: Tailwind CSS 4 via `@tailwindcss/vite` (no separate Tailwind config file — v4 style). Design tokens live in [tokens.css](src/lib/styles/tokens.css). Both light and dark mode are supported via [ThemeToggle.svelte](src/lib/components/ThemeToggle.svelte).

**Icons**: `@lucide/svelte` (general icons) and `@icons-pack/svelte-simple-icons` (brand icons). Both ship raw `.svelte` source, so they're added to `ssr.noExternal` in `vite.config.ts`.

## Persistent data

Four SQLite files, plus two upload directories, live under `data/` at the repo/container root:

- **`notes.db`** — private notes ([notes.ts](src/lib/server/notes.ts)). Losing this loses real content.
- **`spotify-history.db`** — imported Spotify listening history ([spotify-history-db.ts](src/lib/server/spotify-history-db.ts)). Losing this loses real content that can only be rebuilt by re-requesting and re-importing the Spotify export (can take up to 30 days to arrive) — not something that "just re-warms".
- **`simkl-cache.db`** — cached Simkl genre/synopsis/runtime lookups plus a full-library fallback snapshot ([simkl-cache.ts](src/lib/server/simkl-cache.ts)). Losing this is non-destructive — `/watchlist`'s enrichment data just goes cold and re-warms itself over the next several page loads.
- **`status.db`** — the homepage's "Right now" status items ([status-db.ts](src/lib/server/status-db.ts)), edited at `/admin/status`. Losing this just reverts to the hardcoded fallback.
- **`note-attachments/`** — images pasted/uploaded into private note bodies, served under auth. See [docs/notes.md](docs/notes.md#attachments).
- **`media/`** — images uploaded through `/admin/media` for devlog/project covers, galleries, and post bodies, served publicly (no login). See [docs/environment.md](docs/environment.md).

All default to `./data/*` (overridable via `NOTES_DB_PATH` / `SIMKL_CACHE_DB_PATH` / `SPOTIFY_HISTORY_DB_PATH` / `STATUS_DB_PATH` / `NOTES_ATTACHMENTS_DIR` / `MEDIA_DIR`). The Dockerfile declares `/app/data` as a `VOLUME`, but **that alone does not persist anything across a Coolify redeploy** — Coolify replaces the container from the image each deploy, so an anonymous volume goes with it. In Coolify, under the app's **Storages** tab, add a persistent volume mounted at `/app/data` *before* the first real deploy.

### Backups

A persistent volume protects against redeploys, not against the server itself being renewed or deleted. `GET /api/backup` ([+server.ts](src/routes/api/backup/+server.ts)) dumps the four DBs above to plain-text SQL — schema + `INSERT` statements via [backup.ts](src/lib/server/backup.ts), not the raw binary files, so changes diff cleanly in git instead of bloating the repo — plus `note-attachments/` and `media/`, and commits + pushes them to a private git repo. The same logic (`runBackup()`) can also be triggered manually from `/admin/backups`, which shows when the last backup ran. See [docs/backups.md](docs/backups.md) for the full setup.

Setup:

1. Create a private repo (e.g. `ghostbase-backups`) and a fine-grained GitHub PAT scoped to just that repo's **Contents: Read & write**.
2. Set `BACKUP_SECRET` (any random string) and `BACKUP_GIT_REMOTE=https://x-access-token:<PAT>@github.com/you/ghostbase-backups.git` in Coolify's environment UI.
3. Add a Coolify Scheduled Task (or external cron) that hits `GET /api/backup` with `Authorization: Bearer <BACKUP_SECRET>` — nightly is plenty, since this only backs up state that changes slowly (notes, watch history, listens).

Restoring: `sqlite3 new.db < notes.sql` (etc.) rebuilds each `.db` from its dump.

## Deployment

Multi-stage [Dockerfile](Dockerfile): builds with full devDependencies, then prunes dev-only packages from the already-resolved `node_modules` tree rather than doing a fresh `pnpm install --prod` (a from-scratch prod install would re-resolve peer dependencies and re-pull the entire dev toolchain — see comments in the Dockerfile). Runtime image copies over the compiled build, pruned `node_modules`, and the markdown content / font files read from disk at request time.

`ORIGIN` must be set in production for adapter-node to build absolute URLs and validate request origins behind Traefik — set it in Coolify's environment UI, never in a committed `.env`.
