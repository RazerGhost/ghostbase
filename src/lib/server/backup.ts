import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';

const run = promisify(execFile);

const DBS: { name: string; envVar: string; defaultFile: string }[] = [
	{ name: 'simkl-cache', envVar: 'SIMKL_CACHE_DB_PATH', defaultFile: 'simkl-cache.db' },
	{ name: 'spotify-history', envVar: 'SPOTIFY_HISTORY_DB_PATH', defaultFile: 'spotify-history.db' },
	{ name: 'status', envVar: 'STATUS_DB_PATH', defaultFile: 'status.db' }
];

function dbPath(envVar: string, defaultFile: string): string {
	return env[envVar] || path.join(process.cwd(), 'data', defaultFile);
}

async function git(args: string[], cwd: string) {
	return run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

export type BackupResult =
	| { committed: true; dbs: string[]; timestamp: string }
	| { committed: false; dbs: string[]; message: string };

// Backs up the persistent-volume state (the SQLite DBs listed in DBS below, dumped as text
// so they diff cleanly in git — see dumpDatabaseToSql below — plus the media
// library) to a private git repo. Called from the schedule-gated /api/backup
// endpoint and from the admin "run backup now" button.
export async function runBackup(): Promise<BackupResult> {
	const remote = env.BACKUP_GIT_REMOTE;
	if (!remote) throw new Error('BACKUP_GIT_REMOTE not configured');
	const branch = env.BACKUP_GIT_BRANCH || 'main';
	const userName = env.BACKUP_GIT_USER_NAME || 'ghostbase backup';
	const userEmail = env.BACKUP_GIT_USER_EMAIL || 'backup@localhost';

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbase-backup-'));

	try {
		try {
			await git(['clone', '--quiet', '--depth', '1', '--branch', branch, remote, workDir], os.tmpdir());
		} catch {
			// Branch doesn't exist yet (first-ever run against an empty repo).
			await git(['clone', '--quiet', remote, workDir], os.tmpdir());
			await git(['checkout', '--orphan', branch], workDir);
			await git(['rm', '--quiet', '-rf', '--ignore-unmatch', '.'], workDir);
		}

		const dumped: string[] = [];
		for (const { name, envVar, defaultFile } of DBS) {
			const sql = dumpDatabaseToSql(dbPath(envVar, defaultFile));
			if (sql === null) continue;
			fs.writeFileSync(path.join(workDir, `${name}.sql`), sql);
			dumped.push(name);
		}

		const mediaSrc = env.MEDIA_DIR || path.join(process.cwd(), 'data', 'media');
		const mediaDest = path.join(workDir, 'media');
		fs.rmSync(mediaDest, { recursive: true, force: true });
		if (fs.existsSync(mediaSrc)) {
			fs.cpSync(mediaSrc, mediaDest, { recursive: true });
		}

		await git(['add', '-A'], workDir);
		const { stdout: status } = await git(['status', '--porcelain'], workDir);
		if (status.trim() === '') {
			return { committed: false, dbs: dumped, message: 'No changes since last backup' };
		}

		await git(
			['-c', `user.name=${userName}`, '-c', `user.email=${userEmail}`, 'commit', '--quiet', '-m', `backup: ${new Date().toISOString()}`],
			workDir
		);
		await git(['push', '--quiet', 'origin', `HEAD:${branch}`], workDir);

		return { committed: true, dbs: dumped, timestamp: new Date().toISOString() };
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

// Whether the backup pipeline has enough config to run at all — used to
// gate the admin UI without requiring BACKUP_SECRET (that only guards the
// scheduled HTTP endpoint, not same-origin admin actions).
export function backupConfigured(): boolean {
	return Boolean(env.BACKUP_GIT_REMOTE);
}

// Reads the last commit on the backup branch (a shallow clone, since that's
// the cheapest way to ask a remote "when did you last change" over plain
// git) to show a "last backup" timestamp in the admin UI without needing
// any new persistent state of our own.
export async function getLastBackupInfo(): Promise<{ timestamp: string; message: string } | null> {
	const remote = env.BACKUP_GIT_REMOTE;
	if (!remote) return null;
	const branch = env.BACKUP_GIT_BRANCH || 'main';

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbase-backup-check-'));
	try {
		await git(['clone', '--quiet', '--depth', '1', '--branch', branch, remote, workDir], os.tmpdir());
		const { stdout } = await git(['log', '-1', '--format=%cI%x1f%s'], workDir);
		const [timestamp, message] = stdout.trim().split('\x1f');
		if (!timestamp) return null;
		return { timestamp, message: message ?? '' };
	} catch {
		return null;
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

// Dumps a SQLite file to plain-text SQL (schema + INSERT statements), the
// same shape `sqlite3 <file> .dump` produces. Used for git-based backups:
// text diffs cleanly and compresses well across snapshots, unlike committing
// the raw binary .db file where a single row change can shuffle bytes across
// the whole file. Returns null if the file doesn't exist yet (e.g. a DB that
// hasn't been touched, like status.db before /admin/status is first used).
export function dumpDatabaseToSql(dbPath: string): string | null {
	if (!fs.existsSync(dbPath)) return null;

	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const lines: string[] = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];

		// pragma_table_list distinguishes real tables from FTS5's internal
		// "shadow" tables — those are reserved names SQLite refuses to
		// CREATE/INSERT into directly, and they're recreated automatically
		// alongside their parent virtual table, so they must be skipped
		// entirely rather than dumped as rows.
		const tableTypes = new Map(
			(
				db.prepare(`SELECT name, type FROM pragma_table_list()`).all() as {
					name: string;
					type: string;
				}[]
			).map((t) => [t.name, t.type])
		);

		const objects = db
			.prepare(
				`SELECT type, name, sql FROM sqlite_master
				 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
				 ORDER BY (type = 'table') DESC, name`
			)
			.all() as { type: string; name: string; sql: string }[];

		for (const obj of objects) {
			if (tableTypes.get(obj.name) === 'shadow') continue;

			lines.push(`${obj.sql};`);

			// Virtual tables (e.g. an external-content FTS5 index) hold no data
			// of their own to dump — the app rebuilds/backfills them from the
			// real table they index on next startup.
			if (obj.type === 'table' && tableTypes.get(obj.name) !== 'virtual') {
				const rows = db.prepare(`SELECT * FROM "${obj.name}"`).all() as Record<string, unknown>[];
				const columns = rows.length > 0 ? Object.keys(rows[0]) : getTableColumns(db, obj.name);
				for (const row of rows) {
					const values = columns.map((col) => sqlQuoteValue(row[col]));
					lines.push(
						`INSERT INTO "${obj.name}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${values.join(',')});`
					);
				}
			}
		}

		lines.push('COMMIT;');
		return lines.join('\n') + '\n';
	} finally {
		db.close();
	}
}

function getTableColumns(db: Database.Database, table: string): string[] {
	const info = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
	return info.map((c) => c.name);
}

function sqlQuoteValue(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
	// TEXT and anything else stringifiable — escape single quotes by doubling.
	return `'${String(value).replace(/'/g, "''")}'`;
}
