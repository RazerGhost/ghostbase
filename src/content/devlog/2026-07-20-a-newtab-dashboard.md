---
title: Turning /newtab into an actual dashboard
date: 2026-07-20
tags: [newtab, sqlite, unsplash]
excerpt: A browser new-tab page needs to survive being reopened fifty times a day — that constraint shaped everything from the background photo cache to the layout system more than any feature idea did.
---

[/newtab](/newtab) started as a simple pitch: replace the browser's blank
new-tab page with something that's actually mine — a clock, a search box, the
same Now Playing / Discord / GitHub widgets already living on the homepage,
and a nice background photo. Login-gated behind the same GitHub OAuth as
`/notes` and `/admin`, since none of this needs to be public.

## The constraint that mattered most

A new-tab page isn't a page you visit — it's a page that reopens itself
constantly, often dozens of times an hour, and it needs to feel instant every
single time. That ruled out anything that leans on a slow first paint or an
env-var-gated config that needs a redeploy to change. Two decisions fell out
of it directly:

- The Unsplash background query is a **setting stored in `newtab-settings.db`**,
  editable from an in-page settings panel, not an environment variable.
  Wanting a different photo theme shouldn't mean touching Coolify's env UI
  and redeploying.
- The fetched photo itself is **persisted to the same DB** as a durable
  fallback, not just held in an in-memory cache.

## Why the photo needed a durable cache

The first pass cached the fetched Unsplash photo in memory, keyed by search
query. That worked until it didn't: every server restart — every redeploy,
and in dev, every file save that bounces the Vite server — wiped the cache
and forced an immediate re-fetch on the next load. Unsplash's demo tier caps
out at 50 requests/hour, and a page that gets reopened as often as a new-tab
page burns through that fast when every restart resets the counter to zero.

Persisting the last-fetched photo (URL, blur hash, credit) to
`newtab-settings.db` fixed that: a restart still loses the in-memory cache,
but the DB fallback means the very next request serves the last-known photo
instead of triggering a fresh fetch. The actual re-fetch only happens once
the cache's own TTL expires, restart or not.

The same commit also switched from Unsplash's `urls.regular` (capped at
1080px) to `urls.raw` with explicit width/quality params — the difference is
obvious at anything wider than a laptop screen, and it was worth the
one-line change once the caching was solid enough that fetching a bigger
image wasn't also fetching it *more often*.

## Everything a dashboard accumulates

Once the shell existed, `/newtab` grew the way these things do — one useful
thing at a time, each cheap to add because the persistence layer was already
there:

- **Quick links** and **search history**, both trivial once there's
  somewhere to put them — quick links later grew into its own small
  feature, below.
- A **favoritable, cyclable background photo history** instead of a single
  cached photo — click through past backgrounds, star the ones worth
  keeping.
- A **pomodoro-style focus timer** with daily stats, because a new-tab page
  is exactly where you'd glance to start one.
- A small **watchlist widget** pulling from the same Simkl-backed data as
  `/watchlist`.
- **Client-side persisted drag/dock layout** for the widgets — where you put
  things stays where you put them, stored in `localStorage` rather than the
  server since it's purely a per-browser display preference.

None of these needed new infrastructure. `newtab-settings.db` already held
one blob of durable state; everything after the background-photo cache was
just more columns and more UI on top of a page that was already fast.

## Quick links outgrew their popover

"Quick links" started as exactly what it sounds like — add a label and a
URL, remove one you don't want anymore. That was fine for five links; it
stopped being fine once reordering, editing, and picking something better
than a bare text label all turned out to matter too. Rather than keep
wedging features into the small popover it lived in, the management UI moved
out into a dedicated `QuickLinksModal` component with actual room:
click-count-based sort (so frequently used links can float to the top
without dragging anything), up/down reordering without a drag-and-drop
library, inline editing, per-link keyboard shortcuts, and a curated
[Lucide icon picker](src/lib/components/quick-link-icons.ts) — a hand-picked
subset (dev tools, media, finance, productivity, social/web, misc) rather
than the full icon set, stored as the same kebab-case name Lucide ships it
under so the value is portable and self-describing rather than an opaque
index into some list.

The one thing that had to be handled carefully: links added before the icon
picker existed had emoji stored in what's now the `icon` column. Rather than
a migration script to convert them, the icon component just falls back to
rendering the raw stored value as text if it isn't a recognized Lucide icon
name — an old emoji renders exactly as it always did, no data touched.
