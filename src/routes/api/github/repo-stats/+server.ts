import { json, error } from '@sveltejs/kit';
import { getRepoStats } from '$lib/server/github';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const repo = url.searchParams.get('repo');
	if (!repo) error(400, 'Missing repo');

	try {
		return json(await getRepoStats(repo));
	} catch {
		error(502, 'GitHub API unavailable');
	}
};
