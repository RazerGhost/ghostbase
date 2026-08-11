import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

export type PlayRecord = {
	playedAt: string;
	msPlayed: number;
	track: string;
	artist: string;
	album: string | null;
	spotifyUri: string | null;
	platform: string | null;
	shuffle: boolean | null;
	skipped: boolean | null;
};

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS plays (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		played_at TEXT NOT NULL,
		ms_played INTEGER NOT NULL,
		track TEXT NOT NULL,
		artist TEXT NOT NULL,
		album TEXT,
		spotify_uri TEXT,
		platform TEXT,
		shuffle INTEGER,
		skipped INTEGER,
		UNIQUE(played_at, spotify_uri, ms_played)
	);
	CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays(played_at);
`;

let db: Database.Database | null = null;

function openDb(): Database.Database {
	const dbPath = env.SPOTIFY_HISTORY_DB_PATH || path.join(process.cwd(), 'data', 'spotify-history.db');
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const instance = new Database(dbPath);
	instance.pragma('journal_mode = WAL');
	instance.exec(SCHEMA);
	return instance;
}

function getDb(): Database.Database {
	if (!db) db = openDb();
	return db;
}

// Test-only escape hatch, mirrors simkl-cache.ts. Also drops the
// aggregate memo — cached results from a previous test's database would
// otherwise bleed into the next one.
export function __setDbForTests(instance: Database.Database | null): void {
	db = instance;
	aggregateCache.clear();
}

// The plays table only changes on imports and scrobbles (writes measured in
// per-day counts), while the homepage and /listens aggregate over the whole
// table on every view — so aggregate results are memoized here and the whole
// memo dropped on any write. Values are cached per stringified-args key.
const aggregateCache = new Map<string, unknown>();

function invalidateAggregates(): void {
	aggregateCache.clear();
}

function memoized<T>(key: string, compute: () => T): T {
	if (aggregateCache.has(key)) return aggregateCache.get(key) as T;
	const value = compute();
	aggregateCache.set(key, value);
	return value;
}

// UNIQUE(played_at, spotify_uri, ms_played) + INSERT OR IGNORE makes this
// idempotent — re-uploading the same (or an overlapping, re-requested)
// export just skips rows already seen instead of duplicating listening time.
export function insertPlays(records: PlayRecord[]): { inserted: number } {
	const stmt = getDb().prepare(
		`INSERT OR IGNORE INTO plays
			(played_at, ms_played, track, artist, album, spotify_uri, platform, shuffle, skipped)
		 VALUES (@playedAt, @msPlayed, @track, @artist, @album, @spotifyUri, @platform, @shuffle, @skipped)`
	);
	const insertAll = getDb().transaction((rows: PlayRecord[]) => {
		let inserted = 0;
		for (const row of rows) {
			const result = stmt.run({
				...row,
				shuffle: row.shuffle == null ? null : row.shuffle ? 1 : 0,
				skipped: row.skipped == null ? null : row.skipped ? 1 : 0
			});
			if (result.changes > 0) inserted++;
		}
		return inserted;
	});
	const inserted = insertAll(records);
	if (inserted > 0) invalidateAggregates();
	return { inserted };
}

export type ListeningStats = {
	totalPlays: number;
	totalMsPlayed: number;
	firstPlayedAt: string | null;
	lastPlayedAt: string | null;
	peakYear: number | null;
	peakWeekday: number | null; // 0 = Sunday, matches JS Date#getDay
	topArtists: { artist: string; plays: number; msPlayed: number; spotifyUri: string | null }[];
	topTracks: { track: string; artist: string; plays: number; spotifyUri: string | null }[];
};

// ISO played_at strings sort lexicographically, so a year filter can be a
// plain range — unlike strftime('%Y', ...), which SQLite can't answer from
// idx_plays_played_at and turns into a full-table scan per query.
function yearRange(year: number): { yearStart: string; yearEnd: string } {
	return { yearStart: `${year}-01-01`, yearEnd: `${year + 1}-01-01` };
}

export function getListeningStats(opts: { year?: number } = {}): ListeningStats {
	return memoized(`stats:${opts.year ?? 'all'}`, () => computeListeningStats(opts));
}

function computeListeningStats(opts: { year?: number } = {}): ListeningStats {
	const database = getDb();
	const yearFilter = opts.year != null ? `WHERE played_at >= @yearStart AND played_at < @yearEnd` : '';
	const params = opts.year != null ? yearRange(opts.year) : {};

	const totals = database
		.prepare(
			`SELECT COUNT(*) as totalPlays, COALESCE(SUM(ms_played), 0) as totalMsPlayed, MIN(played_at) as firstPlayedAt, MAX(played_at) as lastPlayedAt FROM plays ${yearFilter}`
		)
		.get(params) as { totalPlays: number; totalMsPlayed: number; firstPlayedAt: string | null; lastPlayedAt: string | null };

	// peakYear is always computed across all years, regardless of filter — it's "which year was busiest", not affected by viewing one.
	const peakYearRow = database
		.prepare(
			`SELECT CAST(strftime('%Y', played_at) AS INTEGER) as year, COUNT(*) as plays
			 FROM plays GROUP BY year ORDER BY plays DESC LIMIT 1`
		)
		.get() as { year: number; plays: number } | undefined;

	const peakWeekdayRow = database
		.prepare(
			`SELECT CAST(strftime('%w', played_at) AS INTEGER) as weekday, COUNT(*) as plays
			 FROM plays ${yearFilter} GROUP BY weekday ORDER BY plays DESC LIMIT 1`
		)
		.get(params) as { weekday: number; plays: number } | undefined;

	const topArtists = database
		.prepare(
			`SELECT artist, COUNT(*) as plays, SUM(ms_played) as msPlayed,
			        (SELECT p2.spotify_uri FROM plays p2 WHERE p2.artist = plays.artist AND p2.spotify_uri IS NOT NULL
			         GROUP BY p2.spotify_uri ORDER BY COUNT(*) DESC LIMIT 1) as spotifyUri
			 FROM plays ${yearFilter} GROUP BY artist ORDER BY msPlayed DESC LIMIT 5`
		)
		.all(params) as { artist: string; plays: number; msPlayed: number; spotifyUri: string | null }[];

	const topTracks = database
		.prepare(
			`SELECT track, artist, COUNT(*) as plays, spotify_uri as spotifyUri
			 FROM plays ${yearFilter} GROUP BY track, artist ORDER BY plays DESC LIMIT 5`
		)
		.all(params) as { track: string; artist: string; plays: number; spotifyUri: string | null }[];

	return {
		totalPlays: totals.totalPlays,
		totalMsPlayed: totals.totalMsPlayed,
		firstPlayedAt: totals.firstPlayedAt,
		lastPlayedAt: totals.lastPlayedAt,
		peakYear: peakYearRow?.year ?? null,
		peakWeekday: peakWeekdayRow?.weekday ?? null,
		topArtists,
		topTracks
	};
}

// Years with at least one play, newest first — powers the year filter dropdown.
export function getAvailableYears(): number[] {
	return memoized('years', () => computeAvailableYears());
}

function computeAvailableYears(): number[] {
	const rows = getDb()
		.prepare(
			`SELECT DISTINCT CAST(strftime('%Y', played_at) AS INTEGER) as year
			 FROM plays ORDER BY year DESC`
		)
		.all() as { year: number }[];
	return rows.map((r) => r.year);
}

// One row per day with at least one play in `year` — GitHub-style calendar heatmap.
export function getHeatmap(year: number): { date: string; plays: number }[] {
	return memoized(`heatmap:${year}`, () =>
		getDb()
			.prepare(
				`SELECT date(played_at) as date, COUNT(*) as plays
				 FROM plays WHERE played_at >= @yearStart AND played_at < @yearEnd
				 GROUP BY date ORDER BY date`
			)
			.all(yearRange(year)) as { date: string; plays: number }[]
	);
}

// Daily play counts for the last `days` calendar days (UTC, inclusive of
// today) — sparse like getHeatmap, but a small rolling window rather than a
// full year, for the homepage's recent-activity sparkline.
export function getRecentDailyPlayCounts(days: number): { date: string; plays: number }[] {
	const end = new Date();
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - (days - 1));
	const startDate = start.toISOString().slice(0, 10);
	return memoized(`recentDaily:${days}:${startDate}`, () =>
		getDb()
			.prepare(
				`SELECT date(played_at) as date, COUNT(*) as plays
				 FROM plays WHERE played_at >= @start
				 GROUP BY date ORDER BY date`
			)
			.all({ start: startDate }) as { date: string; plays: number }[]
	);
}

// Play counts by hour-of-day (0-23), across all history — powers a listening-clock chart.
export function getHourlyBreakdown(): { hour: number; plays: number }[] {
	return memoized('hourly', () =>
		getDb()
			.prepare(
				`SELECT CAST(strftime('%H', played_at) AS INTEGER) as hour, COUNT(*) as plays
				 FROM plays GROUP BY hour ORDER BY hour`
			)
			.all() as { hour: number; plays: number }[]
	);
}

// Play counts by (weekday, hour-of-day) — powers a weekly listening-habits
// heatmap. Sparse: combos with zero plays are simply absent from the result.
export function getWeekdayHourBreakdown(opts: { year?: number } = {}): { weekday: number; hour: number; plays: number }[] {
	return memoized(`weekdayHourly:${opts.year ?? 'all'}`, () => {
		const yearFilter = opts.year != null ? `WHERE played_at >= @yearStart AND played_at < @yearEnd` : '';
		const params = opts.year != null ? yearRange(opts.year) : {};
		return getDb()
			.prepare(
				`SELECT CAST(strftime('%w', played_at) AS INTEGER) as weekday,
				        CAST(strftime('%H', played_at) AS INTEGER) as hour, COUNT(*) as plays
				 FROM plays ${yearFilter} GROUP BY weekday, hour`
			)
			.all(params) as { weekday: number; hour: number; plays: number }[];
	});
}

export type TrackHistory = { plays: number; firstPlayedAt: string; lastPlayedAt: string };

// Looks up a track's full play history by Spotify URI — used to cross-reference
// the currently-playing track against the archive ("you've played this 47 times").
export function getTrackHistory(spotifyUri: string): TrackHistory | null {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) as plays, MIN(played_at) as firstPlayedAt, MAX(played_at) as lastPlayedAt
			 FROM plays WHERE spotify_uri = @uri`
		)
		.get({ uri: spotifyUri }) as TrackHistory & { plays: number };
	return row.plays > 0 ? row : null;
}

// Count of rows still awaiting the next export to overwrite them with real
// ms_played data — surfaced on /spotify-import so it's obvious how much of
// the archive is still estimate-only.
export function getLiveScrobbleCount(): number {
	return memoized('liveScrobbleCount', () => {
		const row = getDb()
			.prepare(`SELECT COUNT(*) as count FROM plays WHERE platform = 'live-scrobble'`)
			.get() as { count: number };
		return row.count;
	});
}

// Removes live-scrobbled rows (see scrobble/+server.ts) within [minPlayedAt,
// maxPlayedAt] before importing an export that covers the same range — the
// export has the real ms_played, the scrobble only an estimate (full track
// duration), so the dedup UNIQUE constraint won't catch them as the same
// play and they'd otherwise double-count. Called once per import, right
// before insertPlays.
export function deleteScrobbledRange(minPlayedAt: string, maxPlayedAt: string): number {
	const result = getDb()
		.prepare(
			`DELETE FROM plays WHERE platform = 'live-scrobble' AND played_at BETWEEN @min AND @max`
		)
		.run({ min: minPlayedAt, max: maxPlayedAt });
	if (result.changes > 0) invalidateAggregates();
	return result.changes;
}

// One import = one transaction: clearing superseded live-scrobble rows and
// inserting the export's records either both land or neither does — a crash
// in between would otherwise drop scrobbles without their replacement data.
// (insertPlays' own transaction nests fine — better-sqlite3 turns the inner
// one into a savepoint on the same connection.)
export function importRecords(
	records: PlayRecord[],
	minPlayedAt: string,
	maxPlayedAt: string
): { inserted: number; replacedScrobbles: number } {
	const run = getDb().transaction(() => {
		const replacedScrobbles = deleteScrobbledRange(minPlayedAt, maxPlayedAt);
		const { inserted } = insertPlays(records);
		return { inserted, replacedScrobbles };
	});
	return run();
}

// Top tracks for one artist — powers the Top Artists drill-down expand.
export function getArtistTopTracks(
	artist: string
): { track: string; plays: number; spotifyUri: string | null }[] {
	return getDb()
		.prepare(
			`SELECT track, COUNT(*) as plays, spotify_uri as spotifyUri
			 FROM plays WHERE artist = @artist
			 GROUP BY track ORDER BY plays DESC LIMIT 5`
		)
		.all({ artist }) as { track: string; plays: number; spotifyUri: string | null }[];
}

export type OnThisDayEntry = {
	year: number;
	track: string;
	artist: string;
	spotifyUri: string | null;
	plays: number;
};

// The most-played track on `monthDay` (e.g. "07-18") in each past year —
// "on this day" rediscovery. One row per year, newest first, picking the
// year's top play if there were several different tracks that day.
export function getOnThisDay(monthDay: string, excludeYear: number): OnThisDayEntry[] {
	return memoized(`onThisDay:${monthDay}:${excludeYear}`, () =>
		computeOnThisDay(monthDay, excludeYear)
	);
}

function computeOnThisDay(monthDay: string, excludeYear: number): OnThisDayEntry[] {
	const rows = getDb()
		.prepare(
			`SELECT CAST(strftime('%Y', played_at) AS INTEGER) as year, track, artist,
			        spotify_uri as spotifyUri, COUNT(*) as plays
			 FROM plays
			 WHERE strftime('%m-%d', played_at) = @monthDay
			   AND CAST(strftime('%Y', played_at) AS INTEGER) != @excludeYear
			 GROUP BY year, track, artist
			 ORDER BY year DESC, plays DESC`
		)
		.all({ monthDay, excludeYear }) as OnThisDayEntry[];

	const seenYears = new Set<number>();
	const result: OnThisDayEntry[] = [];
	for (const row of rows) {
		if (seenYears.has(row.year)) continue;
		seenYears.add(row.year);
		result.push(row);
	}
	return result;
}

export type SearchResult = {
	track: string;
	artist: string;
	album: string | null;
	plays: number;
	spotifyUri: string | null;
};

// Simple substring search over track/artist, ranked by play count.
// LIKE wildcards in the user's query are escaped so searching for a literal
// "%" or "_" (e.g. the track "100%") matches text, not everything.
export function searchPlays(query: string): SearchResult[] {
	const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
	return getDb()
		.prepare(
			`SELECT track, artist, album, COUNT(*) as plays, spotify_uri as spotifyUri
			 FROM plays WHERE track LIKE @like ESCAPE '\\' OR artist LIKE @like ESCAPE '\\'
			 GROUP BY track, artist ORDER BY plays DESC LIMIT 20`
		)
		.all({ like }) as SearchResult[];
}

export type TopAlbum = {
	album: string;
	artist: string;
	plays: number;
	msPlayed: number;
	spotifyUri: string | null;
};

// Top 5 albums by total ms played — grouped by (album, artist) so two
// different artists' albums with the same title don't get merged together.
export function getTopAlbums(opts: { year?: number } = {}): TopAlbum[] {
	return memoized(`topAlbums:${opts.year ?? 'all'}`, () => {
		const clauses = ['album IS NOT NULL'];
		if (opts.year != null) clauses.push('played_at >= @yearStart AND played_at < @yearEnd');
		const params = opts.year != null ? yearRange(opts.year) : {};
		return getDb()
			.prepare(
				`SELECT album, artist, COUNT(*) as plays, SUM(ms_played) as msPlayed, MAX(spotify_uri) as spotifyUri
				 FROM plays WHERE ${clauses.join(' AND ')}
				 GROUP BY album, artist ORDER BY msPlayed DESC LIMIT 5`
			)
			.all(params) as TopAlbum[];
	});
}

export type SkipShuffleStats = {
	ratedSkips: number;
	skippedCount: number;
	skipRate: number | null; // 0-100, null if nothing has skip data yet
	ratedShuffle: number;
	shuffledCount: number;
	shuffleRate: number | null; // 0-100, null if nothing has shuffle data yet
};

// skipped/shuffle are only present on export rows (live-scrobble rows always
// write NULL for both, see scrobble/+server.ts) — COUNT(col)/SUM(col) ignore
// NULLs, so the rate stays accurate even with scrobble-only rows in the mix.
export function getSkipShuffleStats(opts: { year?: number } = {}): SkipShuffleStats {
	return memoized(`skipShuffle:${opts.year ?? 'all'}`, () => {
		const yearFilter = opts.year != null ? `WHERE played_at >= @yearStart AND played_at < @yearEnd` : '';
		const params = opts.year != null ? yearRange(opts.year) : {};

		const totals = getDb()
			.prepare(
				`SELECT COUNT(skipped) as ratedSkips, COALESCE(SUM(skipped), 0) as skippedCount,
				        COUNT(shuffle) as ratedShuffle, COALESCE(SUM(shuffle), 0) as shuffledCount
				 FROM plays ${yearFilter}`
			)
			.get(params) as { ratedSkips: number; skippedCount: number; ratedShuffle: number; shuffledCount: number };

		return {
			...totals,
			skipRate: totals.ratedSkips > 0 ? (totals.skippedCount / totals.ratedSkips) * 100 : null,
			shuffleRate: totals.ratedShuffle > 0 ? (totals.shuffledCount / totals.ratedShuffle) * 100 : null
		};
	});
}

export type MonthlyTrendPoint = { month: string; plays: number; msPlayed: number }; // month = "YYYY-MM"

// Play counts/ms grouped by calendar month — like getHourlyBreakdown and
// getAvailableYears, strftime() forces a full scan rather than using
// idx_plays_played_at, but the result is memoized so it's paid once per
// year-selection.
export function getMonthlyTrend(opts: { year?: number } = {}): MonthlyTrendPoint[] {
	return memoized(`monthlyTrend:${opts.year ?? 'all'}`, () => {
		const yearFilter = opts.year != null ? `WHERE played_at >= @yearStart AND played_at < @yearEnd` : '';
		const params = opts.year != null ? yearRange(opts.year) : {};
		return getDb()
			.prepare(
				`SELECT strftime('%Y-%m', played_at) as month, COUNT(*) as plays, SUM(ms_played) as msPlayed
				 FROM plays ${yearFilter} GROUP BY month ORDER BY month`
			)
			.all(params) as MonthlyTrendPoint[];
	});
}

export type Discovery = { artist: string; firstPlayedAt: string; plays: number };

// Artists whose true first-ever play (across all history, not just the
// filtered year) falls within `year` — "discovered this year". Deliberately
// not year-filtered in WHERE: needs every row to compute each artist's real
// MIN(played_at), then filters on that in HAVING.
export function getDiscoveries(year: number, limit = 10): Discovery[] {
	return memoized(`discoveries:${year}:${limit}`, () => {
		const { yearStart, yearEnd } = yearRange(year);
		return getDb()
			.prepare(
				`SELECT artist, MIN(played_at) as firstPlayedAt, COUNT(*) as plays
				 FROM plays GROUP BY artist
				 HAVING firstPlayedAt >= @yearStart AND firstPlayedAt < @yearEnd
				 ORDER BY firstPlayedAt DESC LIMIT @limit`
			)
			.all({ yearStart, yearEnd, limit }) as Discovery[];
	});
}

// Distinct calendar dates with at least one play, all-time — feeds streak
// calculation (listening-streaks.ts). Not year-scoped, like peakYear, since a
// streak spanning a year boundary shouldn't be truncated by the year filter.
export function getActiveDates(): string[] {
	return memoized('activeDates', () =>
		(
			getDb()
				.prepare(`SELECT DISTINCT date(played_at) as date FROM plays ORDER BY date`)
				.all() as { date: string }[]
		).map((r) => r.date)
	);
}
