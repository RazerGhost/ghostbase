# Backups

A Coolify persistent volume ([deployment.md](deployment.md)) protects `data/` across redeploys, but not against the server itself being renewed, rebuilt, or deleted — that requires state living somewhere outside the box entirely. `GET /api/backup` ([+server.ts](../src/routes/api/backup/+server.ts)) does that: it dumps the `data/` SQLite DBs plus the media library (`media/`) and pushes them to a private git repo, on the same "secret-gated endpoint hit by a scheduler" pattern as the Spotify scrobble endpoint ([listens.md](listens.md)).

The actual clone/dump/mirror/commit/push logic lives in `runBackup()` in [backup.ts](../src/lib/server/backup.ts), not the endpoint itself — `+server.ts` is just a secret check that calls it. `runBackup()` is also called by the "Run backup now" button on `/admin/backups` (gated by the ordinary `/admin` login, not `BACKUP_SECRET`), which additionally reads `getLastBackupInfo()` (a shallow clone of the backup remote to read its last commit) to show when the last backup ran, and `backupConfigured()` to hide the page's controls entirely when `BACKUP_GIT_REMOTE` isn't set.

## Why text dumps, not the raw `.db` files

Committing a `.db` file directly would work, but SQLite's on-disk format is a B-tree — a single row change can rewrite pages scattered across the whole file, so git would store a near-full binary copy on every backup with no useful delta compression, and diffs would be unreadable.

Instead, [backup.ts](../src/lib/server/backup.ts) dumps each DB to plain-text SQL — schema (`CREATE TABLE`/`INDEX`/`TRIGGER`) followed by one `INSERT` statement per row, the same shape `sqlite3 <file> .dump` produces. Text diffs cleanly (an edited row shows up as one changed `INSERT` line) and git's delta compression handles the repetition across snapshots well.

To restore a table from a dump: `sqlite3 new.db < status.sql`.

### FTS5 shadow tables are deliberately skipped

`backup.ts` queries `pragma_table_list()` to tell real tables apart from `shadow` and `virtual` ones, and skips dumping row data for both — shadow tables because SQLite refuses direct `INSERT`s into these reserved names (`object name reserved for internal use`), and virtual tables because they hold no independent data of their own. This matters for any DB that adds an FTS5 (or other virtual-table) index in the future: its shadow tables are recreated automatically as a side effect of `CREATE VIRTUAL TABLE`, so skipping them in the dump is safe as long as the app re-backfills the index from its source table on startup.

## Endpoint behavior ([+server.ts](../src/routes/api/backup/+server.ts))

On `GET /api/backup` with a valid secret:

1. Shallow-clones `BACKUP_GIT_REMOTE` (branch `BACKUP_GIT_BRANCH`, default `main`) into a temp directory. If the branch doesn't exist yet (first run against a freshly created empty repo), falls back to cloning the repo and creating an orphan branch.
2. Dumps each DB (skipping any that don't exist yet, e.g. `status.db` before `/admin/status` has ever been used) to `<name>.sql` in the checkout.
3. Mirrors the media library (`MEDIA_DIR`, default `data/media`) into the checkout (deletes and re-copies it, so deleted files drop out of the backup too).
4. `git add -A`; if nothing changed since the last run, returns early without committing.
5. Otherwise commits (author identity from `BACKUP_GIT_USER_NAME`/`BACKUP_GIT_USER_EMAIL`, both optional) and pushes.
6. Deletes the temp directory in a `finally` block regardless of outcome.

Gated the same way as the scrobble endpoint: prefer `Authorization: Bearer <BACKUP_SECRET>` over `?secret=`, since query strings tend to end up in proxy/access logs. Returns `503` if `BACKUP_SECRET` or `BACKUP_GIT_REMOTE` is unset.

## One-time setup

1. **Create a private repo** to hold the backups (e.g. `ghostbase-backups`) — separate from this app's own repo, since it'll accumulate a commit per backup run indefinitely.
2. **Mint a GitHub PAT** scoped as narrowly as possible: a *fine-grained* token, restricted to just that one repo, with **Contents: Read and write** permission only. A classic PAT or a token with broader scope also works but is unnecessary risk.
   1. Go to https://github.com/settings/personal-access-tokens and click **Generate new token**.
   2. Set **Resource owner** to your account.
   3. Under **Repository access**, choose **Only select repositories** and pick just `ghostbase-backups` — not "All repositories".
   4. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. Leave every other permission at "No access".
   5. Generate it and copy the token (`github_pat_...`) immediately — GitHub only shows it once.
3. **Set env vars** in Coolify's environment UI (never in a committed `.env`):
   - `BACKUP_SECRET` — any random string, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `BACKUP_GIT_REMOTE` — `https://x-access-token:<PAT>@github.com/you/ghostbase-backups.git`
   - Optionally `BACKUP_GIT_BRANCH`, `BACKUP_GIT_USER_NAME`, `BACKUP_GIT_USER_EMAIL` (all have sane defaults — see [.env.example](../.env.example))
4. **Schedule it**: Coolify's **Scheduled Tasks** (or an external cron / GitHub Actions cron hitting the deployed URL) running something like:
   ```
   curl -fsS -H "Authorization: Bearer $BACKUP_SECRET" https://razerghost.xyz/api/backup
   ```
   Nightly is plenty — everything backed up here changes slowly (watch history, listening stats), unlike the scrobble endpoint which needs a tight interval to avoid losing Spotify history.

## Credential exposure notes

The PAT lives in `BACKUP_GIT_REMOTE`, which is:
- Present in the container's environment for the life of the process (same exposure as every other secret in `.env.example`).
- Briefly written to `.git/config` inside the temp checkout during a backup run, then deleted along with the rest of the temp directory in the endpoint's `finally` block.

It is **not** persisted anywhere in the app's own repo or the running container's filesystem outside that temp directory's lifetime. Keeping the PAT's scope to a single private repo's contents means a leak of this value can't reach anything else in the GitHub account.
