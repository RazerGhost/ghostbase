import { json } from '@sveltejs/kit';
import { getRecentlyPlayed, spotifyConfigured } from '$lib/server/spotify';
import type { RequestHandler } from './$types';

// Degrades to `{ available: false }` instead of erroring when the refresh
// token lacks the recently-played scope, so the widget just hides that
// section. getRecentlyPlayed() caches upstream for 30s so concurrent
// viewers share one Spotify request.
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
