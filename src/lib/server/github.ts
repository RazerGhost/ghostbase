import { env } from '$env/dynamic/private';

// GithubActivity/GithubRepoStats used to fetch api.github.com directly from
// the browser: unauthenticated, capped at 60 requests/hour per visitor IP,
// with no caching, so a handful of reloads could burn through that budget.
// Proxying through here does two things: a short in-memory cache collapses
// repeat requests for the same data, and sending the same GITHUB_CLIENT_ID/
// SECRET already configured for GitHub login as Basic Auth raises the
// ceiling to 5,000 requests/hour per GitHub's docs on OAuth app client
// credentials for public data — no user token needed.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
	data: T;
	fetchedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function authHeaders(): HeadersInit {
	const headers: HeadersInit = { Accept: 'application/vnd.github+json' };
	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
		const basic = Buffer.from(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`).toString('base64');
		headers.Authorization = `Basic ${basic}`;
	}
	return headers;
}

async function cachedGet<T>(key: string, url: string): Promise<T> {
	const hit = cache.get(key);
	const now = Date.now();
	if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.data as T;

	const existing = inFlight.get(key);
	if (existing) return existing as Promise<T>;

	const promise = (async () => {
		const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
		const data = (await res.json()) as T;
		cache.set(key, { data, fetchedAt: now });
		return data;
	})().finally(() => {
		inFlight.delete(key);
	});

	inFlight.set(key, promise);
	return promise;
}

// Matches "owner/repo" only — used to build the GitHub API URL, so this also
// guards against a malformed href producing a request to an unintended path.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export interface GithubEvent {
	id: string;
	type: string;
	repo: { name: string };
	created_at: string;
	payload?: { ref_type?: string; action?: string; before?: string; head?: string; size?: number };
}

export async function getPublicEvents(username: string, limit: number): Promise<GithubEvent[]> {
	const data = await cachedGet<GithubEvent[]>(
		`events:${username}`,
		`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=10`
	);
	return data.slice(0, limit);
}

export interface CommitSummary {
	sha: string;
	message: string;
}

export async function getCommitCompare(repo: string, base: string, head: string): Promise<CommitSummary[]> {
	if (!REPO_PATTERN.test(repo)) throw new Error('Invalid repo');

	const data = await cachedGet<{ commits: { sha: string; commit: { message: string } }[] }>(
		`compare:${repo}:${base}...${head}`,
		`https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
	);
	return (data.commits ?? [])
		.map((c) => ({ sha: c.sha, message: c.commit.message.split('\n')[0] }))
		.reverse();
}

export interface RepoStats {
	stars: number;
	language: string | null;
	pushedAt: string;
}

export async function getRepoStats(repo: string): Promise<RepoStats> {
	if (!REPO_PATTERN.test(repo)) throw new Error('Invalid repo');

	const data = await cachedGet<{ stargazers_count: number; language: string | null; pushed_at: string }>(
		`repo:${repo}`,
		`https://api.github.com/repos/${repo}`
	);
	return { stars: data.stargazers_count, language: data.language, pushedAt: data.pushed_at };
}
