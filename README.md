# Marquee

A self-hosted, single-user AMC movie tracker. Watches your Gmail for AMC reservation and Thank You emails, parses them, enriches the films with TMDB metadata, and surfaces everything in a cinematic poster-grid PWA.

## Features

- Reads your AMC emails and logs every movie automatically.
- Pulls posters, runtimes, and director info from TMDB.
- Figures out Screen Unseen / Scream Unseen reveals via r/AMCsAList.
- Cinematic poster-grid PWA, installable on phone and desktop.
- Year-in-Review with cadence chart, top genres/directors/theatres, 5★ picks.
- Search, filter, sort across your whole history.
- Daily Postgres backups, kept for 30 days.

## Prerequisites

You need two third-party credentials before first launch.

### TMDB API key (free)

1. Make an account at https://www.themoviedb.org
2. Settings → API → Request an API key → Developer
3. Fill out the form (any URL works for "application URL", e.g. `http://localhost:3000`). Approval is instant.
4. Copy the v3 API key (32 chars).

### Gmail app password

The email poller logs into Gmail via IMAP and requires an app-specific password (not your account password):

1. Enable 2-Step Verification at https://myaccount.google.com/security
2. Visit https://myaccount.google.com/apppasswords and generate a password (any name; "Marquee" works). Copy the 16-character string.
3. The poller scans `[Gmail]/All Mail` for `from:@amctheatres.com` by default. No Gmail label or filter setup needed.

## Quick start

Pulls a prebuilt image from GitHub Container Registry (`ghcr.io/ijoshi129/marquee`). No local build step.

```bash
git clone https://github.com/ijoshi129/Marquee.git marquee && cd marquee
cp .env.example .env
# Fill in the Required vars listed in the Configuration section below.
docker compose --env-file .env up -d
```

Open `http://localhost:3000`. If port 3000 is taken, set `APP_HOST_PORT` in `.env` first.

## Updating

### Pulling a newer image

```bash
cd marquee
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

`pull_policy: always` is set on the marquee service, so `up -d` alone will also re-check the registry. The Postgres data volume (`marquee_pgdata`) is preserved across updates. New schema migrations apply automatically on container boot.

By default `compose.yaml` tracks `:latest`. To freeze to a known release, edit the `image:` line to e.g. `ghcr.io/ijoshi129/marquee:0.2.0` and re-run `docker compose up -d`.

### Publishing a new image (maintainer)

Image updates aren't automated — when you want to ship code changes, build and push manually from a machine with Docker + buildx + GHCR auth:

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u ijoshi129 --password-stdin

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile \
  -t ghcr.io/ijoshi129/marquee:latest \
  --push .
```

The `$GITHUB_PAT` needs `write:packages` scope. Hosts running `compose.yaml` will pick up the new image on their next `docker compose pull && up -d`.

### After updating to a version that adds new tag extraction

Run the tag backfill once to pick up format tags on your existing rows:

```bash
docker exec marquee node scripts/backfill-tags.js
```

It's idempotent — re-running is a no-op.

## Configuration

Everything is set in `.env` at the repo root. The fields are also marked inline in `.env.example`.

### Required — must set before first launch

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | Strong password for the bundled Postgres. The connection URL is built from this automatically. |
| `TMDB_API_KEY` | Your v3 API key from themoviedb.org. |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail address and app password. Leave both blank to skip auto-ingest and use manual-entry only. |
| `BACKUP_HOST_PATH` | Host directory where daily database backups are written. Point at durable storage so backups survive container deletes. |

### Optional — sensible defaults

| Variable | Default | Purpose |
|---|---|---|
| `APP_HOST_PORT` | `3000` | Host port the app listens on. Change if 3000 is taken. |
| `POSTGRES_HOST_PORT` | `5433` | Host port for the bundled Postgres. Change only if 5433 is taken. |
| `BACKUP_RETENTION_DAYS` | `30` | How many days of backups to keep. Older files are pruned. |
| `ADMIN_API_TOKEN` | unset | Optional bearer token required by the database export/import API. Strongly recommended if the app is reachable beyond localhost. |
| `DATABASE_IMPORT_LIMIT` | `200mb` | Maximum request body size accepted by the database import API. |

To restore from a backup file:

```bash
gunzip < backups/marquee-2026-01-15.sql.gz \
  | docker exec -i marquee-postgres psql -U marqueeadmin marquee
```

You can also use the local API for one-off backups/restores:

```bash
# Export a restorable gzipped SQL dump.
curl -fsS http://127.0.0.1:3000/api/admin/database/export \
  -o marquee-db.sql.gz

# If ADMIN_API_TOKEN is set, add:
#   -H "Authorization: Bearer $ADMIN_API_TOKEN"

# Restore that dump into the live database. This replaces the current DB contents.
curl -fsS -X POST http://127.0.0.1:3000/api/admin/database/import \
  -H 'Content-Type: application/gzip' \
  --data-binary @marquee-db.sql.gz
```

## What to expect on first launch

The first email poll fetches **every** AMC email in your inbox in one pass — with years of history this can take a few minutes. After that, polls run every 5 minutes and only look at new mail. Reservations older than 30 days with no thank-you in your inbox auto-flip to `watched`. Anything 7-30 days old surfaces in the bulletin asking "did you go or miss it?". TMDB enrichment runs per-watch, so posters fade in as matches resolve.

## Troubleshooting

**Empty grid and "Stats failed" error after several minutes**
The server can't reach Postgres. Check `docker logs marquee` for `Postgres connected`. If you see ECONNREFUSED, double-check that `POSTGRES_PASSWORD` in `.env` matches what's in the running Postgres container.

**Email poller logs "imap: 0 messages"**
Either the account has no AMC emails matching `from:@amctheatres.com` in `[Gmail]/All Mail`, or IMAP is blocked. Run `node server/scripts/imap-debug.js` to verify the connection.

**"Invalid credentials" from Gmail**
You're using the regular account password instead of an app-specific one. See the prerequisites section above.

**TMDB matches are wrong or missing**
Open the watch → "Assign movie" → pick the right one. To re-run enrichment in bulk after fixing parsers: `node server/scripts/backfill-tmdb.js`.

**PWA shows blank/white splash on iOS**
iOS caches the splash decision at install time. Long-press the icon → Remove App → Delete from Home Screen, force-quit Safari, open the site fresh, then re-Add to Home Screen.

**Backups not appearing in `BACKUP_HOST_PATH`**
Confirm `BACKUP_DIR` is set in `.env` (default `/backups`). Verify the host path is writable by Docker. Run a one-shot manual backup:
```bash
docker exec marquee node -e "require('./workers/backup').runBackup().then(p => console.log(p))"
```

## API reference

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness check; pings the database. |
| `GET /api/watches` | List watches. Supports `q`, `status`, `sort`, `dir`, `genre`, `min_rating`, `format`, `from`, `to`, `limit`, `offset`. |
| `GET /api/watches/notifications` | Watches needing user attention (no-show, cancelled, identify, confirm). |
| `GET /api/watches/:id` | Single watch. |
| `POST /api/watches` | Create a manual watch (auto-enriches via TMDB). |
| `PATCH /api/watches/:id` | Update rating, notes, theatre, status, tmdb_id, acknowledged. |
| `DELETE /api/watches/:id` | Delete watch. |
| `POST /api/watches/:id/recheck-unseen` | Re-resolve a Screen Unseen against r/AMCsAList. |
| `GET /api/tmdb/search?q=` | TMDB search (used by "Assign movie"). |
| `GET /api/theaters?q=` | Theatre typeahead. |
| `GET /api/search-suggest?q=` | Grouped suggestions: films, directors, theatres, genres. |
| `GET /api/stats?period=all\|year\|month&month=YYYY-MM` | Aggregate stats. Drives the in-app Year-in-Review. |
| `GET /api/export[?download=0]` | Full JSON dump of all watches, theatres, and TMDB cache. Triggers a browser download by default; pass `download=0` to inline. |
| `GET /api/admin/database/export` | Gzipped PostgreSQL SQL dump for full database backup. |
| `POST /api/admin/database/import` | Restore a gzipped/plain SQL dump into the live database. Destructive; replaces current DB contents when using app-created dumps. |

All `/api/*` routes are rate-limited to 600 req/min per IP.

## Database schema

Auto-applied on server boot via `CREATE TABLE IF NOT EXISTS` in `server/db.js` plus any migrations under `server/migrations/`. Tables:

- `theaters` — distinct AMC venues seen so far.
- `watches` — one row per reservation/Thank You. `status` is `pending`, `watched`, `cancelled`, or `no_show`.
- `tmdb_cache` — TMDB API responses, keyed by `tmdb_id`.
- `email_log` — every parsed AMC email, deduped by `gmail_message_id`. Pruned to the last 730 days by the daily maintenance worker.
- `_migrations` — internal table tracking which numbered SQL files have been applied.
