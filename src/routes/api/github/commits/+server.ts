import { json, error } from '@sveltejs/kit';
import { getCommitCompare } from '$lib/server/github';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const repo = url.searchParams.get('repo');
	const base = url.searchParams.get('base');
	const head = url.searchParams.get('head');
	if (!repo || !base || !head) error(400, 'Missing repo/base/head');

	try {
		return json(await getCommitCompare(repo, base, head));
	} catch {
		error(502, 'GitHub API unavailable');
	}
};
