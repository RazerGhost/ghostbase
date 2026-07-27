# Small integrations

Widgets that are simpler than the [Watchlist](watchlist.md) / [Listens](listens.md) subsystems — no local database, all live-fetched, all optional/degrade-gracefully.

## Spotify "now playing"

[SpotifyWidget.svelte](../src/lib/components/SpotifyWidget.svelte) (the floating widget) and [ListeningNowCard.svelte](../src/lib/components/ListeningNowCard.svelte) (the homepage card) both get their live currently-playing state from [lanyard.svelte.ts](../src/lib/stores/lanyard.svelte.ts) — Lanyard's Spotify field, not Spotify's own `currently-playing` API. That used to be a real `/api/spotify` route backed by Spotify's API, polled independently by whichever of these components were mounted on a given page — e.g. the homepage and `/newtab` both render `ListeningNowCard` *and* `DiscordPresence` together, and the floating `SpotifyWidget` is mounted globally on top of that — with the currently-playing poll tightening down to every 4s near the end of a track. Since every visitor's poll went through the site's one shared Spotify token, that was enough concurrent traffic to trip Spotify's rate limit and put the account on a cooldown. Lanyard gets its Spotify data from Discord's Rich Presence gateway (pushed, not polled from Spotify), so reading from there instead removes Spotify's API from this path entirely.

**Trade-off**: the widget only shows a track while the account is online in Discord with Spotify activity sharing enabled — Lanyard has nothing to report otherwise. Recently-played history (`/api/spotify/recent`) still needs a real Spotify OAuth scope Lanyard doesn't expose, so that part is unaffected — see below.

`spotify.ts`'s OAuth **refresh-token** flow (not authorization-code-per-request) is still used for that history section and for [Listens](listens.md)'s live-scrobble endpoint. `SPOTIFY_REFRESH_TOKEN` is minted once during setup (see [environment.md](environment.md)) and exchanged for a short-lived access token on demand. `getSpotifyAccessToken()` caches that access token **in-memory, per server process** (module-level variable, not per-request) and only re-fetches once it's within 60s of expiring.

`spotifyConfigured()` gates the recently-played section off entirely when the three env vars aren't all set. That section additionally hides itself if the refresh token was only granted `user-read-currently-playing` without `user-read-recently-played`.

`getRecentlyPlayed()` in [spotify.ts](../src/lib/server/spotify.ts) caches the upstream Spotify call for 30s (with a single-flight guard so concurrent requests during a cache miss share one upstream call rather than each firing their own) — `SpotifyWidget` is mounted globally and polls `/api/spotify/recent` every 60s while open, so without this, several visitors' tabs open at once would still add up against the one shared refresh token.

## Discord presence

[DiscordPresence.svelte](../src/lib/components/DiscordPresence.svelte), and now the Spotify widgets above, all read from the shared [lanyard.svelte.ts](../src/lib/stores/lanyard.svelte.ts) store — a single reference-counted poller so multiple components on the same page (e.g. the homepage's compact Discord card plus the floating Spotify widget) don't each open their own polling loop against [Lanyard](https://github.com/Phineas/lanyard), a free third-party service that surfaces a Discord user's live presence via their public Discord ID (not a secret — Discord IDs are public). Configured via `discordUserId` in [config.ts](../src/lib/config.ts).

No API credentials needed, but Lanyard only has data for accounts that have joined its own Discord server (discord.gg/lanyard) at least once — if presence never shows up, that's the first thing to check, not a code bug.

## GitHub activity + repo stats

[GithubActivity.svelte](../src/lib/components/GithubActivity.svelte) (recent public activity + per-push commit lists) and [GithubRepoStats.svelte](../src/lib/components/GithubRepoStats.svelte) (stars/language/last-pushed on a project page) both go through [github.ts](../src/lib/server/github.ts) and its three routes — `/api/github/activity`, `/api/github/commits`, `/api/github/repo-stats` — instead of calling `api.github.com` directly from the browser like they used to.

Two reasons to proxy this server-side rather than fetch straight from the client:
- **Caching**: each of the three lookups is cached in-memory for 5 minutes (with the same single-flight pattern as the Spotify recently-played cache above), so reloading a page doesn't re-fetch data that hasn't meaningfully changed.
- **Rate limit**: GitHub's REST API caps unauthenticated requests at 60/hour *per visitor IP*. Sending the same `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` already configured for GitHub login (see [environment.md](environment.md)) as Basic Auth on these requests raises that to 5,000/hour per GitHub's docs on OAuth app client credentials for public data — no user token or extra scope needed, since it's still only ever reading public data.

`/api/github/activity` always uses `site.githubUsername` from [config.ts](../src/lib/config.ts) server-side — the `limit` query param (clamped 1–10) is the only thing a caller can vary, so this can't be used to look up an arbitrary GitHub user's activity. `/api/github/repo-stats` and `/api/github/commits` do take a `repo` (`owner/name`) from the caller, validated against a strict pattern before being used to build the GitHub API URL — `GithubRepoStats` needs this since project repos can belong to `site.githubUsername` or a collaborator.
