import { error, redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, verifySessionToken } from '$lib/server/session';
import { startSimklRefreshLoop } from '$lib/server/simkl-refresh';
import { checkRateLimit } from '$lib/server/rate-limit';

startSimklRefreshLoop();

// Auth is enforced here, not (only) in +layout.server.ts loads: form actions
// run *before* layout load functions, so a layout redirect alone would let an
// unauthenticated POST hit an action's side effects first. The per-endpoint
// locals.user checks in +server.ts files stay as defense in depth.
const PROTECTED_PREFIXES = ['/admin', '/spotify-import', '/newtab'];

function isProtectedPath(pathname: string): boolean {
	return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Auth endpoints get a generous limit since legitimate OAuth redirects can
// bounce through here more than once; secret-gated endpoints are meant to be
// hit by a scheduled job every 15-30 min, so a tight limit doesn't interfere.
const RATE_LIMITED_ROUTES: { prefix: string; limit: number; windowSeconds: number }[] = [
	{ prefix: '/auth/login', limit: 10, windowSeconds: 60 },
	{ prefix: '/auth/callback', limit: 10, windowSeconds: 60 },
	{ prefix: '/api/backup', limit: 5, windowSeconds: 60 },
	{ prefix: '/api/spotify/scrobble', limit: 5, windowSeconds: 60 }
];

export const handle: Handle = ({ event, resolve }) => {
	const rateLimited = RATE_LIMITED_ROUTES.find((r) => event.url.pathname === r.prefix || event.url.pathname.startsWith(`${r.prefix}/`));
	if (rateLimited) {
		const key = `${rateLimited.prefix}:${event.getClientAddress()}`;
		const result = checkRateLimit(key, rateLimited.limit, rateLimited.windowSeconds);
		if (result.limited) {
			return new Response('Too many requests', {
				status: 429,
				headers: { 'Retry-After': String(result.retryAfterSeconds) }
			});
		}
	}

	const session = verifySessionToken(event.cookies.get(SESSION_COOKIE_NAME));
	if (session) {
		event.locals.user = { username: session.sub };
	}

	if (!event.locals.user && isProtectedPath(event.url.pathname)) {
		// Only unauthenticated *page* GETs get bounced to the login flow; API
		// paths and side-effectful methods (form actions, API writes) get a
		// plain 401 — redirecting those into an OAuth dance helps nobody.
		const isPageGet =
			!event.url.pathname.startsWith('/api/') &&
			(event.request.method === 'GET' || event.request.method === 'HEAD');
		if (!isPageGet) error(401, 'Unauthorized');
		redirect(303, `/auth/login?redirectTo=${encodeURIComponent(event.url.pathname)}`);
	}

	return resolve(event);
};
