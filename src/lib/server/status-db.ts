import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

export type Status = { updated: string; items: string[] };

// Single-row table, same "just enough SQLite" shape as simkl-cache.ts's
// snapshot row — lets /status be edited from /admin/status and persist
// across redeploys via the same data/ volume as notes.db, instead of
// requiring a code change + redeploy to post an update.
const SCHEMA = `
	CREATE TABLE IF NOT EXISTS status (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		updated TEXT NOT NULL,
		items TEXT NOT NULL
	)
`;

const DEFAULT_STATUS: Status = {
	updated: 'July 16, 2026',
	items: [
		'Rebuilding razerghost.xyz as a link hub + devlog (this site).',
		"Poking at whatever random project comes up next — check the devlog for specifics."
	]
};

let db: Database.Database | null = null;

function openDb(): Database.Database {
	const dbPath = env.STATUS_DB_PATH || path.join(process.cwd(), 'data', 'status.db');
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

// Test-only escape hatch, mirrors simkl-cache.ts.
export function __setDbForTests(instance: Database.Database | null): void {
	db = instance;
}

export function getStatus(): Status {
	const row = getDb().prepare('SELECT updated, items FROM status WHERE id = 1').get() as
		| { updated: string; items: string }
		| undefined;
	if (!row) return DEFAULT_STATUS;
	return { updated: row.updated, items: JSON.parse(row.items) };
}

export function setStatus(updated: string, items: string[]): void {
	getDb()
		.prepare(
			`INSERT INTO status (id, updated, items) VALUES (1, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, items = excluded.items`
		)
		.run(updated, JSON.stringify(items));
}
