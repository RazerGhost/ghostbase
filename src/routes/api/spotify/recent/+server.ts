import { json } from '@sveltejs/kit';
import { getRecentlyPlayed, spotifyConfigured } from '$lib/server/spotify';
import type { RequestHandler } from './$types';

// Rather than error when the refresh token lacks the recently-played scope,
// this degrades to `{ available: false }` so the widget just hides the
// history section. getRecentlyPlayed() caches the upstream call for 30s so
// concurrent pollers (every visitor with the widget open) share one Spotify
// API request instead of each making their own.
export const GET: RequestHandler = async () => {
	if (!spotifyConfigured()) {
		return json({ available: false, items: [] });
	}

	try {
		return json(await getRecentlyPlayed());
	} catch {
		return json({ available: false, items: [] });
	}
};
