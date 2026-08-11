import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { site } from '$lib/config';
import { exchangeCodeForToken, fetchGithubUser } from '$lib/server/github-auth';
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '$lib/server/session';
import type { RequestHandler } from './$types';

function denied(reason: string): never {
	redirect(302, `/auth/denied?reason=${reason}`);
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	const rawOauthState = cookies.get('oauth_state');
	cookies.delete('oauth_state', { path: '/' });

	if (!code || !state || !rawOauthState) denied('state');

	let redirectTo = '/admin';
	try {
		const parsed = JSON.parse(rawOauthState);
		if (parsed.state !== state) denied('state');
		if (typeof parsed.redirectTo === 'string') redirectTo = parsed.redirectTo;
	} catch {
		denied('state');
	}

	let login: string;
	let id: number;
	try {
		const accessToken = await exchangeCodeForToken(code, `${url.origin}/auth/callback`);
		({ id, login } = await fetchGithubUser(accessToken));
	} catch {
		denied('error');
	}

	if (id !== site.githubUserId) {
		denied('not-owner');
	}

	cookies.set(SESSION_COOKIE_NAME, createSessionToken(login), {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_SECONDS
	});

	redirect(302, redirectTo);
};
