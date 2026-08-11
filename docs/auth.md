# Auth

Gates `/admin` and `/spotify-import` behind a single owner's GitHub account. There is no multi-user support — this is an allow-list-of-one, not a real auth system.

## Flow

1. `GET /auth/login` ([+server.ts](../src/routes/auth/login/+server.ts)) builds a GitHub OAuth authorize URL ([github-auth.ts](../src/lib/server/github-auth.ts):`buildAuthorizeUrl`) with scope `read:user`, generates a random `state`, and stashes `{ state, redirectTo }` in a short-lived `oauth_state` cookie before redirecting to GitHub.
2. GitHub redirects back to `GET /auth/callback` ([+server.ts](../src/routes/auth/callback/+server.ts)) with `code` + `state`.
3. The callback verifies `state` matches the cookie (CSRF protection), exchanges `code` for an access token, then calls `fetchGithubLogin` to get the authenticated user's GitHub login.
4. The login is compared case-insensitively against `site.githubUsername` in [config.ts](../src/lib/config.ts). Any mismatch redirects to `/auth/denied?reason=not-owner` — **no session is issued for anyone else**, full stop.
5. On match, a signed session token is minted ([session.ts](../src/lib/server/session.ts)) and set as an `httpOnly`, `sameSite=lax` cookie (`rg_session`, 30-day max age), then redirects to `redirectTo` (defaults to `/admin`).

## Sessions

Sessions are a self-contained signed token, not a server-side session store:

```
base64url(json({ sub: login, exp: timestamp })) + "." + HMAC-SHA256(payload, SESSION_SECRET)
```

`verifySessionToken` re-derives the signature and does a `timingSafeEqual` comparison before trusting the payload, then checks expiry. There's no revocation list — rotating `SESSION_SECRET` is the only way to invalidate all sessions at once (see [environment.md](environment.md) for how to generate one).

## Local dev

GitHub OAuth Apps require an exact callback URL match, so you need a **second OAuth App** for local dev with callback `http://localhost:5173/auth/callback` — you can't reuse the production app's registration with two callback URLs.

## Gaps to be aware of

- No CSRF token on state beyond the `oauth_state` cookie round-trip; acceptable for a single-owner login but worth knowing if this ever needs to support more than one user.
- `/auth/login` and `/auth/callback` are rate limited to 10 requests/minute/IP (in-memory, per-process — see `checkRateLimit` in [src/hooks.server.ts](../src/hooks.server.ts)).
