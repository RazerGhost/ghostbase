import { env } from '$env/dynamic/private';
import { getCachedDetails, upsertDetail, cacheKey, getLibrarySnapshot, saveLibrarySnapshot } from './simkl-cache';

const APP_NAME = 'ghostbase';
const APP_VERSION = '1.0';

export type LibraryItem = {
	title: string;
	posterUrl: string | null;
	href: string;
	watchedEpisodes: number;
	totalEpisodes: number | null;
	// 0-10, unset until the user rates the title on Simkl.
	rating: number | null;
	lastWatchedAt: string | null;
	// e.g. "S03E01" — the next unwatched episode, if any.
	nextToWatch: string | null;
	addedAt: string;
	simklId: number;
	mediaType: SimklType;
	// Filled in by enrichLibrary() from the per-title detail endpoint + a
	// local cache — empty/null until that's run (or if it hasn't been able
	// to fetch this particular title yet, see enrichLibrary's comment).
	genres: string[];
	overview: string | null;
	// Minutes per episode (or per movie) — same enrichment path/cache as genres.
	runtime: number | null;
};

export type Library = {
	watching: LibraryItem[];
	completed: LibraryItem[];
	planToWatch: LibraryItem[];
	onHold: LibraryItem[];
	dropped: LibraryItem[];
};

export function simklConfigured(): boolean {
	return Boolean(env.SIMKL_CLIENT_ID && env.SIMKL_ACCESS_TOKEN);
}

// Composes a full poster image URL from the path fragment the API returns
// (e.g. "16/16913426086fc13") — see https://api.simkl.org/conventions/images.
// "_c" (170x250) matches a compact card in a grid.
function posterUrl(path: string | null | undefined): string | null {
	if (!path) return null;
	return `https://wsrv.nl/?url=https://simkl.in/posters/${path}_c.webp&q=90`;
}

const SIMKL_PATH = { shows: 'tv', anime: 'anime', movies: 'movies' } as const;
export type SimklType = keyof typeof SIMKL_PATH;

type AllItemsEntry = {
	status: string;
	watched_episodes_count: number;
	total_episodes_count: number;
	user_rating: number | null;
	last_watched_at: string | null;
	next_to_watch?: string;
	added_to_watchlist_at: string;
	// Mutually exclusive: shows/anime nest under `show`, movies under `movie`.
	show?: { title: string; poster?: string | null; ids: { slug: string; simkl: number } };
	movie?: { title: string; poster?: string | null; ids: { slug: string; simkl: number } };
};

async function fetchAll(type: SimklType): Promise<{ status: string; item: LibraryItem }[]> {
	const params = new URLSearchParams({
		client_id: env.SIMKL_CLIENT_ID ?? '',
		'app-name': APP_NAME,
		'app-version': APP_VERSION
	});

	// status=all returns every bucket (watching/completed/plantowatch/hold/dropped)
	// in one call — cheaper than one request per bucket we care about.
	const res = await fetch(`https://api.simkl.com/sync/all-items/${type}/all?${params}`, {
		headers: {
			Authorization: `Bearer ${env.SIMKL_ACCESS_TOKEN}`,
			'User-Agent': `${APP_NAME}/${APP_VERSION}`
		},
		signal: AbortSignal.timeout(10_000)
	});

	if (!res.ok) throw new Error(`Simkl ${type} fetch failed: ${res.status}`);

	const data = await res.json();
	const entries: AllItemsEntry[] = data[type] ?? [];

	// One malformed entry (missing both show and movie) shouldn't sink the
	// whole library fetch — skip it and keep the rest.
	return entries.flatMap((entry) => {
		const media = entry.show ?? entry.movie;
		if (!media) return [];
		return {
			status: entry.status,
			item: {
				title: media.title,
				posterUrl: posterUrl(media.poster),
				// Simkl's URLs require the numeric id, not just the slug —
				// "/tv/<slug>" alone 404s into the generic discover page.
				href: `https://simkl.com/${SIMKL_PATH[type]}/${media.ids.simkl}/${media.ids.slug}`,
				watchedEpisodes: entry.watched_episodes_count,
				// 0 on movies (not a meaningful episode count) — treat as absent.
				totalEpisodes: entry.total_episodes_count || null,
				rating: entry.user_rating ?? null,
				lastWatchedAt: entry.last_watched_at,
				nextToWatch: entry.next_to_watch ?? null,
				addedAt: entry.added_to_watchlist_at,
				simklId: media.ids.simkl,
				mediaType: type,
				genres: [],
				overview: null,
				runtime: null
			}
		};
	});
}

// Korean dramas and movies mostly live under "shows"/"movies" on Simkl (see
// simkl.com/tv/korean-drama), not "anime" — but querying all three buckets
// means the page still works if any title happens to be filed as anime.
export async function getLibrary(): Promise<Library> {
	const results = await Promise.all([fetchAll('shows'), fetchAll('anime'), fetchAll('movies')]);
	const all = results.flat();

	const byStatus = (status: string) => all.filter((e) => e.status === status).map((e) => e.item);

	return {
		watching: byStatus('watching'),
		completed: byStatus('completed'),
		planToWatch: byStatus('plantowatch'),
		onHold: byStatus('hold'),
		dropped: byStatus('dropped')
	};
}

// Genres/overview aren't in the bulk sync-all-items response above — only
// available from a per-title detail call. Fetching one per title on every
// page load (~250 titles) would be both slow and a lot of load on Simkl's
// public endpoint, so results are cached in SQLite (simkl-cache.ts) and this
// only ever tops up a small, bounded batch of missing/stale entries per
// request. A library this size fully warms over a handful of page loads;
// titles beyond the batch just render without genres/overview until their
// turn comes up, same "degrade gracefully" approach as the rest of the page.
const DETAIL_BATCH_SIZE = 15;
const STALE_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // 60 days — genres/overview rarely change

async function fetchDetail(
	simklId: number,
	type: SimklType
): Promise<{ genres: string[]; overview: string; runtime: number | null } | null> {
	const params = new URLSearchParams({ client_id: env.SIMKL_CLIENT_ID ?? '', extended: 'full' });
	const res = await fetch(`https://api.simkl.com/${SIMKL_PATH[type]}/${simklId}?${params}`, {
		headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` },
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) return null;

	const data = await res.json();
	return {
		genres: Array.isArray(data.genres) ? data.genres : [],
		overview: typeof data.overview === 'string' ? data.overview : '',
		runtime: typeof data.runtime === 'number' ? data.runtime : null
	};
}

// Re-fetches and re-caches a single title on demand — used by the private
// cache inspector page's "force refresh" action, bypassing the normal
// 60-day staleness window.
export async function refreshCachedDetail(simklId: number, type: SimklType): Promise<boolean> {
	const detail = await fetchDetail(simklId, type);
	if (!detail) return false;
	upsertDetail(simklId, type, detail.genres, detail.overview, detail.runtime);
	return true;
}

// Title lookup keyed the same way as the cache, sourced from the last saved
// library snapshot — the simkl_details cache itself has no title column.
export function getLibraryTitleMap(): Map<string, string> {
	const snapshot = getLibrarySnapshot<Library>();
	const map = new Map<string, string>();
	if (!snapshot) return map;
	const all = [
		...snapshot.data.watching,
		...snapshot.data.completed,
		...snapshot.data.planToWatch,
		...snapshot.data.onHold,
		...snapshot.data.dropped
	];
	for (const item of all) map.set(cacheKey(item.simklId, item.mediaType), item.title);
	return map;
}

export async function enrichLibrary(library: Library): Promise<Library> {
	const buckets = [...library.watching, ...library.completed, ...library.planToWatch, ...library.onHold, ...library.dropped];
	if (buckets.length === 0) return library;

	const keys = buckets.map((item) => ({ simklId: item.simklId, mediaType: item.mediaType }));
	const cached = getCachedDetails(keys);
	const now = Date.now();

	const stale = buckets
		.filter((item) => {
			const hit = cached.get(cacheKey(item.simklId, item.mediaType));
			// Also refetch entries cached before `runtime` was added — otherwise
			// they'd wait out the full 60-day staleness window before backfilling.
			return !hit || hit.runtime == null || now - new Date(hit.fetchedAt).getTime() > STALE_AFTER_MS;
		})
		// Recently-watched titles jump the queue so a fresh watch's runtime
		// backfills within a page load or two instead of sitting behind
		// older stale entries and silently undercounting watch time.
		.sort((a, b) => {
			const aTime = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0;
			const bTime = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0;
			return bTime - aTime;
		});

	const toFetch = stale.slice(0, DETAIL_BATCH_SIZE);
	// One flaky detail request shouldn't sink the whole page — the library
	// itself already loaded successfully by this point, enrichment is a bonus.
	await Promise.allSettled(
		toFetch.map(async (item) => {
			const detail = await fetchDetail(item.simklId, item.mediaType);
			if (detail) upsertDetail(item.simklId, item.mediaType, detail.genres, detail.overview, detail.runtime);
		})
	);

	const merged = toFetch.length > 0 ? getCachedDetails(keys) : cached;
	const applyDetails = (items: LibraryItem[]): LibraryItem[] =>
		items.map((item) => {
			const hit = merged.get(cacheKey(item.simklId, item.mediaType));
			return hit ? { ...item, genres: hit.genres, overview: hit.overview || null, runtime: hit.runtime } : item;
		});

	return {
		watching: applyDetails(library.watching),
		completed: applyDetails(library.completed),
		planToWatch: applyDetails(library.planToWatch),
		onHold: applyDetails(library.onHold),
		dropped: applyDetails(library.dropped)
	};
}

// Fetches + enriches the live library, then persists it as a fallback
// snapshot — see getLibraryWithFallback below. Also called on a timer (see
// simkl-refresh.ts) to keep the snapshot warm independent of page traffic.
export async function refreshLibrarySnapshot(): Promise<Library> {
	const library = await enrichLibrary(await getLibrary());
	saveLibrarySnapshot(library);
	return library;
}

export type LibraryResult = { library: Library; stale: boolean; staleSince: string | null };

// How long a snapshot counts as "fresh enough to serve without asking Simkl".
// Page loads inside this window never wait on Simkl at all; the 24h
// background loop (simkl-refresh.ts) plus post-window page loads keep it
// current. Watchlist changes show up within this window at worst.
const SNAPSHOT_FRESH_MS = 15 * 60 * 1000;

// Simkl's rules explicitly encourage local caching of user data
// (https://api.simkl.org/api-rules), so a full-library snapshot is kept in
// SQLite and served here. Serving order:
//   1. a fresh-enough snapshot — no network at all, so homepage/watchlist
//      latency is never coupled to Simkl's,
//   2. a live refresh (which re-saves the snapshot),
//   3. a stale snapshot if the live call fails — better than an empty page
//      during a Simkl outage.
// Rethrows only if there's no snapshot at all (first run before anything's
// ever succeeded).
export async function getLibraryWithFallback(): Promise<LibraryResult> {
	const snapshot = getLibrarySnapshot<Library>();
	if (snapshot && Date.now() - new Date(snapshot.fetchedAt).getTime() < SNAPSHOT_FRESH_MS) {
		return { library: snapshot.data, stale: false, staleSince: null };
	}

	try {
		const library = await refreshLibrarySnapshot();
		return { library, stale: false, staleSince: null };
	} catch (err) {
		if (snapshot) return { library: snapshot.data, stale: true, staleSince: snapshot.fetchedAt };
		throw err;
	}
}
