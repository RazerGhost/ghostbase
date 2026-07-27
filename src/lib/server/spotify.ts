import { env } from '$env/dynamic/private';

// In-memory access-token cache (per server process). Refreshed lazily once
// it's within 60s of expiring. Shared by every route that still talks to
// Spotify's own API (recently-played history, live scrobbling) so they don't
// each keep their own cache. Currently-playing no longer lives here — see
// stores/lanyard.svelte.ts.
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

// Single-flight guard: when the cache is cold, concurrent requests (recent +
// scrobble) would otherwise each hit the token endpoint at once — share one
// in-flight refresh instead.
let refreshInFlight: Promise<string> | null = null;

export function spotifyConfigured(): boolean {
	return Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN);
}

async function refreshAccessToken(): Promise<string> {
	const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString(
		'base64'
	);

	const res = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: env.SPOTIFY_REFRESH_TOKEN ?? ''
		}),
		signal: AbortSignal.timeout(10_000)
	});

	if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);

	const data = await res.json();
	if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
		throw new Error('Spotify token refresh: malformed response');
	}

	cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
	return cachedToken.accessToken;
}

export async function getSpotifyAccessToken(): Promise<string> {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
		return cachedToken.accessToken;
	}

	if (!refreshInFlight) {
		refreshInFlight = refreshAccessToken().finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}

export interface RecentlyPlayedItem {
	track: string;
	artist?: string;
	url?: string;
	albumArt?: string;
	playedAt: string;
}

export interface RecentlyPlayed {
	available: boolean;
	items: RecentlyPlayedItem[];
	reason?: 'missing_scope';
}

// SpotifyWidget is mounted on every page and polls this every 60s while
// open — with several visitors' tabs open at once that's still several
// upstream calls a minute against the one shared refresh token. A short
// cache collapses concurrent pollers into a single upstream call, same
// idea as unsplash.ts's photo cache and calendar.ts's ICS cache.
const RECENT_CACHE_MS = 30_000;
let recentCache: { data: RecentlyPlayed; fetchedAt: number } | null = null;
let recentInFlight: Promise<RecentlyPlayed> | null = null;

async function fetchRecentlyPlayed(): Promise<RecentlyPlayed> {
	const accessToken = await getSpotifyAccessToken();
	const res = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=5', {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(10_000)
	});

	// Requires the `user-read-recently-played` scope on top of
	// `user-read-currently-playing` — a refresh token minted before that
	// scope was requested won't have it.
	if (res.status === 403) return { available: false, items: [], reason: 'missing_scope' };
	if (!res.ok) return { available: false, items: [] };

	const data = await res.json();
	const items: RecentlyPlayedItem[] = (data.items ?? []).map(
		(entry: {
			track: {
				name: string;
				artists: { name: string }[];
				external_urls?: { spotify?: string };
				album?: { images?: { url: string }[] };
			};
			played_at: string;
		}) => ({
			track: entry.track.name,
			artist: entry.track.artists?.map((a) => a.name).join(', '),
			url: entry.track.external_urls?.spotify,
			albumArt: entry.track.album?.images?.[2]?.url ?? entry.track.album?.images?.[0]?.url,
			playedAt: entry.played_at
		})
	);

	return { available: true, items };
}

export async function getRecentlyPlayed(): Promise<RecentlyPlayed> {
	const now = Date.now();
	if (recentCache && now - recentCache.fetchedAt < RECENT_CACHE_MS) return recentCache.data;

	if (!recentInFlight) {
		recentInFlight = fetchRecentlyPlayed()
			.then((data) => {
				recentCache = { data, fetchedAt: Date.now() };
				return data;
			})
			.finally(() => {
				recentInFlight = null;
			});
	}
	return recentInFlight;
}
