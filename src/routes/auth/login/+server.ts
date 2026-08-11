import { randomBytes } from 'node:crypto';
import { error, redirect } from '@sveltejs/kit';
import { site } from '$lib/config';
import { buildAuthorizeUrl, githubAuthConfigured } from '$lib/server/github-auth';
import type { RequestHandler } from './$types';

// Open-redirect guard: only allow same-origin, path-relative targets — a
// leading "//" would be interpreted as protocol-relative and escape the site.
function safeRedirectTarget(value: string | null): string {
	if (value && value.startsWith('/') && !value.startsWith('//')) return value;
	return '/admin';
}

export const GET: RequestHandler = ({ url, cookies }) => {
	if (!githubAuthConfigured()) {
		error(500, `${site.name} auth isn't configured (missing GITHUB_CLIENT_ID/SECRET or SESSION_SECRET).`);
	}

	const state = randomBytes(16).toString('base64url');
	const redirectTo = safeRedirectTarget(url.searchParams.get('redirectTo'));

	cookies.set('oauth_state', JSON.stringify({ state, redirectTo }), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 300
	});

	redirect(302, buildAuthorizeUrl(state, `${url.origin}/auth/callback`));
};
