# Environment variables

One-time setup steps for every variable in [.env.example](../.env.example), grouped into the same sections as that file. That file itself stays a clean list of names — this doc is where the "how do I actually get one of these" detail lives.

Every integration here is optional and degrades gracefully: the site runs fine with an empty `.env`, just with the affected widget/page showing a "not connected" state instead of data.

## Core

### `ORIGIN`

**Required in production.** adapter-node needs this to build absolute URLs and validate incoming request origins when running behind a reverse proxy (Coolify's Traefik) — without it, adapter-node falls back to guessing from request headers, which can misbehave behind a proxy. Set in Coolify's environment variables UI, not in a committed `.env`. Example: `https://razerghost.xyz`.

### `SESSION_SECRET`

Signs the session cookie ([session.ts](../src/lib/server/session.ts)) via HMAC — not a GitHub value. Generate a random secret once:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Rotating this value invalidates all existing sessions.

### `BODY_SIZE_LIMIT`

Extended streaming history exports can be tens of MB across many files. adapter-node's default request body limit (512kb) will reject uploads above that at `/spotify-import` — raise it in Coolify's environment UI if your export is large. Accepts a byte count with an optional K/M/G suffix (e.g. `200M`) — **not** `0`, which SvelteKit treats as a 0-byte limit rather than "unlimited". Use the literal string `Infinity` to fully disable the limit. See [SvelteKit's adapter-node docs](https://svelte.dev/docs/kit/adapter-node#Environment-variables-BODY_SIZE_LIMIT).

## GitHub login gate (`/admin`, `/spotify-import`, `/newtab`)

### `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

Restricted to a single GitHub account — the one matching `site.githubUsername` in [config.ts](../src/lib/config.ts). Any other GitHub account is explicitly rejected at `/auth/callback`; no session is issued.

1. Create an OAuth App at https://github.com/settings/developers
   - Homepage URL: your production URL
   - Authorization callback URL: `<your production URL>/auth/callback`
   - Register a *second* OAuth App for local dev, with callback URL `http://localhost:5173/auth/callback` — GitHub requires an exact match and one OAuth App can't have two callback URLs.
2. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` come from that app.

See [auth.md](auth.md) for the full login flow.

These same two values are also reused (as Basic Auth, not part of the login flow) to raise the GitHub REST API's unauthenticated rate limit from 60/hour to 5,000/hour for the GitHub activity/repo-stats widgets — see [integrations.md](integrations.md). If they're unset, those widgets still work, just capped at the lower unauthenticated limit.

## Spotify "now playing" + listening history

### `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REFRESH_TOKEN`

Powers the recently-played history section of [SpotifyWidget.svelte](../src/lib/components/SpotifyWidget.svelte) and `/listens` live scrobbling — not the live "now playing" track itself, which comes from Lanyard/Discord presence instead (see [integrations.md](integrations.md)). Shows "Spotify not connected" (recently-played section hidden) if unset.

1. Create an app at https://developer.spotify.com/dashboard.
2. `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` come from that app.
3. `SPOTIFY_REFRESH_TOKEN` requires a one-time OAuth authorization-code flow with the `user-read-currently-playing user-read-recently-played` scopes (space-separated in the authorize URL's `scope` param), exchanged for a refresh token — a manual step done once, not part of the app itself. The recently-played history section of the widget silently hides itself if the token only has `user-read-currently-playing`.

See [integrations.md](integrations.md) for how the token is used at runtime.

### `SPOTIFY_HISTORY_DB_PATH` / Listens page

Powers `/listens`, built from Spotify's own "extended streaming history" data export (request it at https://support.spotify.com/us/article/understanding-your-data/, can take up to 30 days to arrive), not the live API. Upload the export's JSON files at `/spotify-import`, gated behind the same GitHub login as `/admin` — no separate credentials needed.

Optional — path to the SQLite file backing this page ([spotify-history-db.ts](../src/lib/server/spotify-history-db.ts)). Defaults to `./data/spotify-history.db` if unset. This file is not trivially rebuildable if lost: the export is a one-time historical dump, so make sure this points inside the same persistent Coolify volume as the other `*_DB_PATH` vars.

See [listens.md](listens.md) for the import/parsing details.

### `SPOTIFY_SCROBBLE_SECRET`

Optional — enables live scrobbling into `spotify-history.db` between manual exports ([+server.ts](../src/routes/api/spotify/scrobble/+server.ts)). Requires the Spotify vars above with the `user-read-recently-played` scope. If set, hit `GET /api/spotify/scrobble` with an `Authorization: Bearer <this value>` header on a schedule (every 15-30 min — Spotify's recently-played endpoint only returns the last 50 plays, so longer gaps lose history) via Coolify's cron or an external scheduler. `?secret=<this value>` also works, but the header is preferred — query strings tend to end up in proxy/access logs. Leave unset to disable the endpoint (it 503s without this).

## Simkl (watching/watchlist)

### `SIMKL_CLIENT_ID` / `SIMKL_ACCESS_TOKEN`

Powers `/watching` ([simkl.ts](../src/lib/server/simkl.ts)). Shows "Simkl not connected" if unset. Simkl's access tokens are long-lived (~5 years) and don't need a refresh flow, unlike Spotify's above.

1. Register an app at https://simkl.com/settings/developer/ to get a `SIMKL_CLIENT_ID` (no client secret needed for the PIN flow below).
2. Get `SIMKL_ACCESS_TOKEN` via Simkl's PIN flow (built for devices without a browser — a good fit for a one-time server-side setup too). Run once:
   ```
   node -e "
     const clientId = 'YOUR_CLIENT_ID';
     (async () => {
       const headers = { 'User-Agent': 'ghostbase/1.0' };
       const params = 'client_id=' + clientId + '&app-name=ghostbase&app-version=1.0';
       const pin = await (await fetch('https://api.simkl.com/oauth/pin?' + params, { headers })).json();
       console.log('Go to', pin.verification_uri, 'and enter code:', pin.user_code);
       const poll = async () => {
         const r = await (await fetch('https://api.simkl.com/oauth/pin/' + pin.user_code + '?' + params, { headers })).json();
         if (r.result === 'OK' && r.access_token) { console.log('SIMKL_ACCESS_TOKEN=' + r.access_token); return; }
         setTimeout(poll, (pin.interval || 5) * 1000);
       };
       poll();
     })();
   "
   ```

See [watchlist.md](watchlist.md) for caching/enrichment details.

### `SIMKL_CACHE_DB_PATH`

Optional — path to the SQLite cache backing the Watching page's genre/synopsis enrichment ([simkl-cache.ts](../src/lib/server/simkl-cache.ts)). Defaults to `./data/simkl-cache.db` if unset. Losing this file isn't destructive — it just goes cold and re-warms itself over the next several page loads — but pointing it at the same Coolify persistent volume as the other `*_DB_PATH` vars (i.e. leaving them all unset, so they share `./data`) avoids that cold start on every redeploy.

## Media library

### `MEDIA_DIR`

Optional, directory holding images uploaded through the `/admin/media` library ([media.ts](../src/lib/server/media.ts)), used for devlog/project cover images, galleries, and post bodies. Defaults to `./data/media` if unset. Files here are served publicly (no login required) since they appear on public devlog/project pages — only uploading and deleting are admin-gated. Point this at the same persistent Coolify volume as the other `data/*` paths — losing it breaks any published post/project referencing an uploaded image.

## Homepage "Right now" card

### `STATUS_DB_PATH`

Optional — path to the SQLite file backing the homepage's "Right now" status card, edited at `/admin/status` ([status-db.ts](../src/lib/server/status-db.ts)). Defaults to `./data/status.db` if unset. Losing this is non-destructive — it just reverts to the hardcoded fallback in `status-db.ts`.

## `/newtab` background photo

The search query is configurable entirely from the settings (gear icon) panel on `/newtab` itself, persisted to `NEWTAB_SETTINGS_DB_PATH` below — no env var or redeploy needed to change it. The only env var here is the API connection itself.

### `UNSPLASH_ACCESS_KEY`

Optional — background photo for the personal `/newtab` dashboard ([unsplash.ts](../src/lib/server/unsplash.ts)). Falls back to a procedural gradient background if unset.

1. Register an app at https://unsplash.com/oauth/applications (requires accepting the [Unsplash API Terms](https://unsplash.com/documentation), including its attribution and download-tracking requirements — both are already handled by `unsplash.ts` and the `/newtab` page, so no extra work needed on redeploy).
2. `UNSPLASH_ACCESS_KEY` is that app's Access Key. Only the Access Key is needed — the Secret Key/OAuth flow is only for acting on behalf of an Unsplash *user* (login, uploads, likes), which this integration doesn't do.

The photo is cached in-memory per server process for an hour (same pattern as the Spotify access token) to stay well under the demo tier's 50 requests/hour rate limit — every page view within that hour reuses the same photo rather than triggering a new API call. Changing the search query via the settings panel invalidates that cache immediately rather than waiting out the hour. Before the panel has ever been used, the query defaults to `minimal dark abstract`.

### `NEWTAB_SETTINGS_DB_PATH`

Optional — path to the SQLite file backing the `/newtab` settings panel ([newtab-settings.ts](../src/lib/server/newtab-settings.ts)). Defaults to `./data/newtab-settings.db` if unset. Losing this is non-destructive — it just reverts to the hardcoded default query.

## Backups

### `BACKUP_SECRET` / `BACKUP_GIT_REMOTE` / `BACKUP_GIT_BRANCH` / `BACKUP_GIT_USER_NAME` / `BACKUP_GIT_USER_EMAIL`

Backs up the SQLite DBs to a private git repo. See [backups.md](backups.md) for full one-time setup (creating the backup repo, minting a scoped PAT, scheduling the endpoint) — that doc covers this in more depth than fits here.
