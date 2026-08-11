import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

export type CachedDetail = { genres: string[]; overview: string; runtime: number | null; fetchedAt: string };

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS simkl_details (
		simkl_id INTEGER NOT NULL,
		media_type TEXT NOT NULL,
		genres TEXT NOT NULL,
		overview TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		PRIMARY KEY (simkl_id, media_type)
	);
	CREATE TABLE IF NOT EXISTS simkl_library_snapshot (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		data TEXT NOT NULL,
		fetched_at TEXT NOT NULL
	)
`;

// Minutes per episode/movie, added after the initial schema — migrated in
// separately since existing deployments already have the table without it.
function migrateRuntimeColumn(instance: Database.Database): void {
	const columns = instance.prepare('PRAGMA table_info(simkl_details)').all() as { name: string }[];
	if (!columns.some((col) => col.name === 'runtime')) {
		instance.exec('ALTER TABLE simkl_details ADD COLUMN runtime INTEGER');
	}
}

let db: Database.Database | null = null;

function openDb(): Database.Database {
	const dbPath = env.SIMKL_CACHE_DB_PATH || path.join(process.cwd(), 'data', 'simkl-cache.db');
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const instance = new Database(dbPath);
	instance.pragma('journal_mode = WAL');
	instance.exec(SCHEMA);
	migrateRuntimeColumn(instance);
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

export function cacheKey(simklId: number, mediaType: string): string {
	return `${simklId}:${mediaType}`;
}

export function getCachedDetails(keys: { simklId: number; mediaType: string }[]): Map<string, CachedDetail> {
	const result = new Map<string, CachedDetail>();
	if (keys.length === 0) return result;

	const stmt = getDb().prepare(
		'SELECT genres, overview, runtime, fetched_at FROM simkl_details WHERE simkl_id = ? AND media_type = ?'
	);
	for (const { simklId, mediaType } of keys) {
		const row = stmt.get(simklId, mediaType) as
			| { genres: string; overview: string; runtime: number | null; fetched_at: string }
			| undefined;
		if (row) {
			result.set(cacheKey(simklId, mediaType), {
				genres: JSON.parse(row.genres),
				overview: row.overview,
				runtime: row.runtime,
				fetchedAt: row.fetched_at
			});
		}
	}
	return result;
}

export function upsertDetail(
	simklId: number,
	mediaType: string,
	genres: string[],
	overview: string,
	runtime: number | null
): void {
	getDb()
		.prepare(
			`INSERT INTO simkl_details (simkl_id, media_type, genres, overview, runtime, fetched_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(simkl_id, media_type) DO UPDATE SET
			 	genres = excluded.genres, overview = excluded.overview, runtime = excluded.runtime, fetched_at = excluded.fetched_at`
		)
		.run(simklId, mediaType, JSON.stringify(genres), overview, runtime, new Date().toISOString());
}

// All cached per-title rows, newest-fetched first — powers a private cache
// inspector page rather than any public-facing feature.
export function listAllDetails(): (CachedDetail & { simklId: number; mediaType: string })[] {
	const rows = getDb()
		.prepare(
			'SELECT simkl_id, media_type, genres, overview, runtime, fetched_at FROM simkl_details ORDER BY fetched_at DESC'
		)
		.all() as { simkl_id: number; media_type: string; genres: string; overview: string; runtime: number | null; fetched_at: string }[];
	return rows.map((row) => ({
		simklId: row.simkl_id,
		mediaType: row.media_type,
		genres: JSON.parse(row.genres),
		overview: row.overview,
		runtime: row.runtime,
		fetchedAt: row.fetched_at
	}));
}

// Single-row full-library snapshot — kept separate from simkl_details (which
// only caches per-title genres/overview/runtime, not the watchlist itself).
// Used as a fallback when Simkl's sync endpoint is unreachable; deliberately
// untyped here (kept in simkl.ts, the caller) to avoid this module depending
// on the shape of Library.
export function getLibrarySnapshot<T>(): { data: T; fetchedAt: string } | null {
	const row = getDb().prepare('SELECT data, fetched_at FROM simkl_library_snapshot WHERE id = 1').get() as
		| { data: string; fetched_at: string }
		| undefined;
	if (!row) return null;
	return { data: JSON.parse(row.data) as T, fetchedAt: row.fetched_at };
}

export function saveLibrarySnapshot(data: unknown): void {
	getDb()
		.prepare(
			`INSERT INTO simkl_library_snapshot (id, data, fetched_at)
			 VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`
		)
		.run(JSON.stringify(data), new Date().toISOString());
}
