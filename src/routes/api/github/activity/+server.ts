import { json, error } from '@sveltejs/kit';
import { site } from '$lib/config';
import { getPublicEvents } from '$lib/server/github';
import type { RequestHandler } from './$types';

// Username always comes from our own config, never the query string — this
// widget only ever shows the site owner's activity, so there's no reason to
// let a caller ask for anyone else's.
export const GET: RequestHandler = async ({ url }) => {
	const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 5));

	try {
		const events = await getPublicEvents(site.githubUsername, limit);
		return json(events);
	} catch {
		error(502, 'GitHub API unavailable');
	}
};
