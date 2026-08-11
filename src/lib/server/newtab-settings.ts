import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

export type NewtabSettings = { unsplashQuery: string | null; icsUrl: string | null };

export type QuickLink = {
	id: number;
	label: string;
	url: string;
	position: number;
	clicks: number;
	icon: string | null;
	shortcut: string | null;
};

export type CachedPhoto = {
	url: string;
	photographerName: string;
	photographerProfileUrl: string;
	photoPageUrl: string;
};

export type PhotoCacheEntry = { query: string; fetchedAt: number; photo: CachedPhoto };

export type PhotoHistoryEntry = CachedPhoto & { id: number; favorited: boolean; fetchedAt: number };

export type FocusStats = { sessionsToday: number; focusMinutesToday: number };

export type TodoItem = { id: number; body: string; done: boolean; position: number; createdAt: string };

export type FocusDailyStat = { date: string; minutes: number };
export type FocusWeeklyStats = { days: FocusDailyStat[]; streak: number };

// Single-row table, same shape as status-db.ts — lets the /newtab background
// query be changed from the page's own settings panel instead of requiring
// an env var edit + redeploy. photo_cache persists the last fetched photo
// alongside the in-memory cache in unsplash.ts, so a server restart (which
// happens on every redeploy, and often during local dev) doesn't force an
// immediate re-fetch and eat into Unsplash's 50-requests/hour demo quota.
const SCHEMA = `
	CREATE TABLE IF NOT EXISTS newtab_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		unsplash_query TEXT,
		photo_cache TEXT,
		quick_links TEXT
	);

	CREATE TABLE IF NOT EXISTS quick_links (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		label TEXT NOT NULL,
		url TEXT NOT NULL,
		position INTEGER NOT NULL,
		clicks INTEGER NOT NULL DEFAULT 0,
		icon TEXT,
		shortcut TEXT
	);

	-- One row per fetched background photo, capped/pruned in addPhotoHistory
	-- so cycling through past photos (see cyclePhoto in +page.server.ts)
	-- doesn't require a fresh Unsplash call and doesn't touch the hourly quota.
	CREATE TABLE IF NOT EXISTS photo_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		query TEXT NOT NULL,
		url TEXT NOT NULL,
		photographer_name TEXT NOT NULL,
		photographer_profile_url TEXT NOT NULL,
		photo_page_url TEXT NOT NULL,
		favorited INTEGER NOT NULL DEFAULT 0,
		fetched_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS focus_sessions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		completed INTEGER NOT NULL,
		started_at TEXT NOT NULL,
		ended_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS search_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		query TEXT NOT NULL,
		searched_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS todo_items (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		body TEXT NOT NULL,
		done INTEGER NOT NULL DEFAULT 0,
		position INTEGER NOT NULL,
		created_at TEXT NOT NULL
	);
`;

// quick_links used to live as a single JSON blob in newtab_settings.quick_links
// (pre-table version). Migrate any leftover blob into real rows once, then
// leave the column alone (harmless dead column, simpler than a DROP COLUMN
// migration on better-sqlite3).
function migrateLegacyQuickLinksBlob(instance: Database.Database): void {
	const row = instance.prepare('SELECT quick_links FROM newtab_settings WHERE id = 1').get() as
		| { quick_links: string | null }
		| undefined;
	if (!row?.quick_links) return;

	const alreadyMigrated = instance.prepare('SELECT COUNT(*) AS n FROM quick_links').get() as { n: number };
	if (alreadyMigrated.n > 0) return;

	try {
		const legacy = JSON.parse(row.quick_links) as { label: string; url: string }[];
		const insert = instance.prepare(
			'INSERT INTO quick_links (label, url, position, clicks) VALUES (?, ?, ?, 0)'
		);
		instance.transaction(() => {
			legacy.forEach((link, i) => insert.run(link.label, link.url, i));
		})();
	} catch {
		// Malformed legacy blob — nothing worth recovering.
	}

	instance.prepare('UPDATE newtab_settings SET quick_links = NULL WHERE id = 1').run();
}

function migrateColumns(instance: Database.Database): void {
	const columns = instance.prepare('PRAGMA table_info(newtab_settings)').all() as { name: string }[];
	if (!columns.some((col) => col.name === 'photo_cache')) {
		instance.exec('ALTER TABLE newtab_settings ADD COLUMN photo_cache TEXT');
	}
	if (!columns.some((col) => col.name === 'quick_links')) {
		instance.exec('ALTER TABLE newtab_settings ADD COLUMN quick_links TEXT');
	}
	if (!columns.some((col) => col.name === 'ics_url')) {
		instance.exec('ALTER TABLE newtab_settings ADD COLUMN ics_url TEXT');
	}

	const quickLinkColumns = instance.prepare('PRAGMA table_info(quick_links)').all() as { name: string }[];
	if (!quickLinkColumns.some((col) => col.name === 'icon')) {
		instance.exec('ALTER TABLE quick_links ADD COLUMN icon TEXT');
	}
	if (!quickLinkColumns.some((col) => col.name === 'shortcut')) {
		instance.exec('ALTER TABLE quick_links ADD COLUMN shortcut TEXT');
	}
}

let db: Database.Database | null = null;

function openDb(): Database.Database {
	const dbPath = env.NEWTAB_SETTINGS_DB_PATH || path.join(process.cwd(), 'data', 'newtab-settings.db');
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const instance = new Database(dbPath);
	instance.pragma('journal_mode = WAL');
	instance.exec(SCHEMA);
	migrateColumns(instance);
	migrateLegacyQuickLinksBlob(instance);
	return instance;
}

function getDb(): Database.Database {
	if (!db) db = openDb();
	return db;
}

// Test-only escape hatch, mirrors status-db.ts.
export function __setDbForTests(instance: Database.Database | null): void {
	db = instance;
}

export function getNewtabSettings(): NewtabSettings {
	const row = getDb().prepare('SELECT unsplash_query, ics_url FROM newtab_settings WHERE id = 1').get() as
		| { unsplash_query: string | null; ics_url: string | null }
		| undefined;
	return { unsplashQuery: row?.unsplash_query || null, icsUrl: row?.ics_url || null };
}

export function setNewtabIcsUrl(url: string | null): void {
	getDb()
		.prepare(
			`INSERT INTO newtab_settings (id, ics_url) VALUES (1, ?)
			 ON CONFLICT(id) DO UPDATE SET ics_url = excluded.ics_url`
		)
		.run(url);
}

export function setNewtabUnsplashQuery(query: string | null): void {
	getDb()
		.prepare(
			`INSERT INTO newtab_settings (id, unsplash_query) VALUES (1, ?)
			 ON CONFLICT(id) DO UPDATE SET unsplash_query = excluded.unsplash_query`
		)
		.run(query);
}

// --- Quick links -----------------------------------------------------------

export function getQuickLinks(): QuickLink[] {
	const rows = getDb()
		.prepare('SELECT id, label, url, position, clicks, icon, shortcut FROM quick_links ORDER BY position ASC, id ASC')
		.all() as QuickLink[];
	return rows;
}

export function addQuickLink(label: string, url: string, icon: string | null = null, shortcut: string | null = null): QuickLink {
	const db = getDb();
	const maxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM quick_links').get() as {
		max: number;
	};
	const result = db
		.prepare('INSERT INTO quick_links (label, url, position, clicks, icon, shortcut) VALUES (?, ?, ?, 0, ?, ?)')
		.run(label, url, maxPosition.max + 1, icon, shortcut);
	return {
		id: Number(result.lastInsertRowid),
		label,
		url,
		position: maxPosition.max + 1,
		clicks: 0,
		icon,
		shortcut
	};
}

export function updateQuickLink(
	id: number,
	updates: { label: string; url: string; icon: string | null; shortcut: string | null }
): void {
	getDb()
		.prepare('UPDATE quick_links SET label = ?, url = ?, icon = ?, shortcut = ? WHERE id = ?')
		.run(updates.label, updates.url, updates.icon, updates.shortcut, id);
}

export function removeQuickLink(id: number): void {
	getDb().prepare('DELETE FROM quick_links WHERE id = ?').run(id);
}

export function incrementQuickLinkClicks(id: number): void {
	getDb().prepare('UPDATE quick_links SET clicks = clicks + 1 WHERE id = ?').run(id);
}

// Swaps position with the adjacent link in the given direction — simpler and
// safer than reassigning every row's position, since it only ever touches
// the two rows actually changing places.
export function moveQuickLink(id: number, direction: 'up' | 'down'): void {
	const db = getDb();
	const links = getQuickLinks();
	const index = links.findIndex((l) => l.id === id);
	if (index === -1) return;
	const targetIndex = direction === 'up' ? index - 1 : index + 1;
	if (targetIndex < 0 || targetIndex >= links.length) return;

	const current = links[index];
	const target = links[targetIndex];
	const swap = db.transaction(() => {
		db.prepare('UPDATE quick_links SET position = ? WHERE id = ?').run(target.position, current.id);
		db.prepare('UPDATE quick_links SET position = ? WHERE id = ?').run(current.position, target.id);
	});
	swap();
}

// --- Photo history -----------------------------------------------------------

const PHOTO_HISTORY_LIMIT = 12;

export function addPhotoHistory(query: string, photo: CachedPhoto): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO photo_history (query, url, photographer_name, photographer_profile_url, photo_page_url, favorited, fetched_at)
		 VALUES (?, ?, ?, ?, ?, 0, ?)`
	).run(query, photo.url, photo.photographerName, photo.photographerProfileUrl, photo.photoPageUrl, Date.now());

	// Prune down to the cap, oldest first, but never delete favorited photos —
	// those are the whole point of letting someone pin one.
	const overflow = db
		.prepare(
			`SELECT id FROM photo_history WHERE favorited = 0
			 ORDER BY fetched_at DESC LIMIT -1 OFFSET ?`
		)
		.all(PHOTO_HISTORY_LIMIT) as { id: number }[];
	if (overflow.length) {
		const del = db.prepare('DELETE FROM photo_history WHERE id = ?');
		db.transaction(() => overflow.forEach((row) => del.run(row.id)))();
	}
}

type PhotoHistoryRow = Omit<PhotoHistoryEntry, 'favorited'> & { favorited: number };

export function listPhotoHistory(): PhotoHistoryEntry[] {
	const rows = getDb()
		.prepare(
			`SELECT id, query, url, photographer_name AS photographerName, photographer_profile_url AS photographerProfileUrl,
			        photo_page_url AS photoPageUrl, favorited, fetched_at AS fetchedAt
			 FROM photo_history ORDER BY fetched_at DESC`
		)
		.all() as PhotoHistoryRow[];
	return rows.map((row) => ({ ...row, favorited: Boolean(row.favorited) }));
}

export function toggleFavoritePhoto(id: number): void {
	getDb().prepare('UPDATE photo_history SET favorited = NOT favorited WHERE id = ?').run(id);
}

export function getPhotoHistoryEntry(id: number): PhotoHistoryEntry | null {
	return listPhotoHistory().find((p) => p.id === id) ?? null;
}

// Picks a different cached photo at random — used by the "cycle" button so
// browsing past backgrounds never counts against the Unsplash API quota.
export function pickRandomPhotoHistory(excludeUrl?: string): PhotoHistoryEntry | null {
	const rows = listPhotoHistory().filter((p) => p.url !== excludeUrl);
	if (!rows.length) return null;
	return rows[Math.floor(Math.random() * rows.length)];
}

export function getPhotoCache(): PhotoCacheEntry | null {
	const row = getDb().prepare('SELECT photo_cache FROM newtab_settings WHERE id = 1').get() as
		| { photo_cache: string | null }
		| undefined;
	if (!row?.photo_cache) return null;
	try {
		return JSON.parse(row.photo_cache) as PhotoCacheEntry;
	} catch {
		return null;
	}
}

export function setPhotoCache(entry: PhotoCacheEntry): void {
	getDb()
		.prepare(
			`INSERT INTO newtab_settings (id, photo_cache) VALUES (1, ?)
			 ON CONFLICT(id) DO UPDATE SET photo_cache = excluded.photo_cache`
		)
		.run(JSON.stringify(entry));
	addPhotoHistory(entry.query, entry.photo);
}

// --- Focus sessions -----------------------------------------------------------

export function logFocusSession(kind: 'focus' | 'break', completed: boolean, startedAt: string, endedAt: string): void {
	getDb()
		.prepare('INSERT INTO focus_sessions (kind, completed, started_at, ended_at) VALUES (?, ?, ?, ?)')
		.run(kind, completed ? 1 : 0, startedAt, endedAt);
}

export function getFocusStats(): FocusStats {
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const rows = getDb()
		.prepare(
			`SELECT started_at AS startedAt, ended_at AS endedAt FROM focus_sessions
			 WHERE kind = 'focus' AND completed = 1 AND started_at >= ?`
		)
		.all(todayStart.toISOString()) as { startedAt: string; endedAt: string }[];

	const focusMinutesToday = rows.reduce((sum, row) => {
		const ms = new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime();
		return sum + Math.max(0, Math.round(ms / 60000));
	}, 0);

	return { sessionsToday: rows.length, focusMinutesToday };
}

function localDateKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Per-day completed-focus-minutes for the trailing `days` days (default a
// week), plus the current streak — consecutive days (ending today) with at
// least one completed focus session. Used by the weekly digest sparkline on
// the focus widget; getFocusStats above only ever needed "today."
export function getFocusWeeklyStats(days = 7): FocusWeeklyStats {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const since = new Date(today);
	since.setDate(since.getDate() - (days - 1));

	const rows = getDb()
		.prepare(
			`SELECT started_at AS startedAt, ended_at AS endedAt FROM focus_sessions
			 WHERE kind = 'focus' AND completed = 1 AND started_at >= ?`
		)
		.all(since.toISOString()) as { startedAt: string; endedAt: string }[];

	const minutesByDate = new Map<string, number>();
	for (const row of rows) {
		const key = localDateKey(new Date(row.startedAt));
		const minutes = Math.max(0, Math.round((new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()) / 60000));
		minutesByDate.set(key, (minutesByDate.get(key) ?? 0) + minutes);
	}

	const dailyStats: FocusDailyStat[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		const key = localDateKey(d);
		dailyStats.push({ date: key, minutes: minutesByDate.get(key) ?? 0 });
	}

	let streak = 0;
	for (let i = dailyStats.length - 1; i >= 0; i--) {
		if (dailyStats[i].minutes > 0) streak++;
		else break;
	}

	return { days: dailyStats, streak };
}

// --- Search history -----------------------------------------------------------

const SEARCH_HISTORY_LIMIT = 8;

export function logSearch(query: string): void {
	const trimmed = query.trim();
	if (!trimmed) return;
	const db = getDb();
	db.prepare('DELETE FROM search_history WHERE query = ?').run(trimmed);
	db.prepare('INSERT INTO search_history (query, searched_at) VALUES (?, ?)').run(trimmed, new Date().toISOString());

	const overflow = db
		.prepare('SELECT id FROM search_history ORDER BY searched_at DESC LIMIT -1 OFFSET ?')
		.all(SEARCH_HISTORY_LIMIT) as { id: number }[];
	if (overflow.length) {
		const del = db.prepare('DELETE FROM search_history WHERE id = ?');
		db.transaction(() => overflow.forEach((row) => del.run(row.id)))();
	}
}

export function getRecentSearches(limit = 5): string[] {
	const rows = getDb()
		.prepare('SELECT query FROM search_history ORDER BY searched_at DESC LIMIT ?')
		.all(limit) as { query: string }[];
	return rows.map((r) => r.query);
}

// Also removes deletion for the search-history "x" button on the /newtab
// suggestions dropdown — a search entry someone doesn't want resurfacing
// shouldn't have to wait to fall off the LIMIT-8 cap above.
export function removeSearch(query: string): void {
	getDb().prepare('DELETE FROM search_history WHERE query = ?').run(query);
}

// --- To-do items -----------------------------------------------------------

type TodoRow = { id: number; body: string; done: number; position: number; created_at: string };

function mapTodoRow(row: TodoRow): TodoItem {
	return { id: row.id, body: row.body, done: Boolean(row.done), position: row.position, createdAt: row.created_at };
}

export function getTodoItems(): TodoItem[] {
	const rows = getDb()
		.prepare('SELECT id, body, done, position, created_at FROM todo_items ORDER BY position ASC, id ASC')
		.all() as TodoRow[];
	return rows.map(mapTodoRow);
}

export function addTodoItem(body: string): TodoItem {
	const db = getDb();
	const maxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM todo_items').get() as {
		max: number;
	};
	const position = maxPosition.max + 1;
	const createdAt = new Date().toISOString();
	const result = db
		.prepare('INSERT INTO todo_items (body, done, position, created_at) VALUES (?, 0, ?, ?)')
		.run(body, position, createdAt);
	return { id: Number(result.lastInsertRowid), body, done: false, position, createdAt };
}

export function toggleTodoItem(id: number): void {
	getDb().prepare('UPDATE todo_items SET done = NOT done WHERE id = ?').run(id);
}

export function removeTodoItem(id: number): void {
	getDb().prepare('DELETE FROM todo_items WHERE id = ?').run(id);
}
