# Marquee

A self-hosted AMC movie tracker. Marquee watches your Gmail for AMC reservation and
"Thank You" emails, parses them, enriches each film with TMDB metadata, and surfaces
your whole moviegoing history in a cinematic poster-grid PWA — plus an optional
federated **Friends** layer that lets you pair with other Marquee instances and share
what you're watching.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/overview.png" width="190"><br><sub><b>Year-in-Review</b></sub></td>
    <td align="center"><img src="docs/screenshots/poster-grid.png" width="190"><br><sub><b>Poster grid</b></sub></td>
    <td align="center"><img src="docs/screenshots/film-detail.png" width="190"><br><sub><b>Film detail</b></sub></td>
    <td align="center"><img src="docs/screenshots/watchlist.png" width="190"><br><sub><b>Watchlist</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/friends-feed.png" width="190"><br><sub><b>Friends feed</b></sub></td>
    <td align="center"><img src="docs/screenshots/friend-profile.png" width="190"><br><sub><b>Friend profile</b></sub></td>
    <td align="center"><img src="docs/screenshots/notifications.png" width="190"><br><sub><b>Notifications</b></sub></td>
    <td></td>
  </tr>
</table>

## Features

**Your diary**
- **Automatic logging** — reads your AMC emails and records every movie, no manual entry.
- **Rich metadata** — pulls posters, runtimes, genres, and directors from TMDB.
- **Screen Unseen reveals** — resolves AMC Screen/Scream Unseen mysteries via r/AMCsAList, keeping the title hidden until the showing lets out.
- **Showtimes on posters** — upcoming films show their release date; booked reservations show the showtime.
- **Year-in-Review** — cadence chart, top genres/directors/theatres, 5★ picks, and a per-month/per-year A-List savings breakdown. Every stat is tappable for a plain-English detail sheet.
- **Search & filter** — across your entire history by title, director, genre, rating, or format.
- **Installable PWA** — works on phone and desktop, offline-friendly.

**Friends (federation)**
- **Pair instances directly** — no central server; two Marquee instances exchange a one-time invite code and sync over token-gated HTTP.
- **Activity feed** — see what friends have logged and what's coming up.
- **Seeing together** — matching upcoming reservations merge into one card with a shared comment thread.
- **Recommend films** — push a film to a friend's watchlist with a "Recommended by you" badge.
- **Taste-match** — % agreement and films-in-common on each friend's profile.
- **Notifications** — in-app bell plus iOS Web Push for recommendations, comments, and seeing-together alerts.

**Operations**
- **Daily backups** — automatic Postgres dumps, retained for 30 days.
- **Owner lock** — an optional passcode gates your diary so only the friend-facing API is reachable when you share the instance.

## Setup

Marquee runs as a single Docker stack (app + Postgres). You need Docker and two free
third-party credentials.

### 1. Get a TMDB API key (required)

1. Create an account at <https://www.themoviedb.org>.
2. Go to **Settings → API → Request an API key → Developer**.
3. Fill out the form (any URL works, e.g. `http://localhost:3000`). Approval is instant.
4. Copy the **v3 API key** (32 characters).

### 2. Get a Gmail app password (required for auto-ingest)

The poller signs into Gmail over IMAP and needs an app-specific password — not your
normal account password.

1. Enable **2-Step Verification** at <https://myaccount.google.com/security>.
2. Generate a password at <https://myaccount.google.com/apppasswords> (any name).
   Copy the **16-character** string.
3. Nothing else to configure — Marquee scans `[Gmail]/All Mail` for
   `from:@amctheatres.com` automatically.

> Skip this step to run in manual-entry-only mode: leave `GMAIL_USER` and
> `GMAIL_APP_PASSWORD` blank.

### 3. Launch

```bash
git clone https://github.com/ijoshi129/Marquee.git marquee && cd marquee
cp .env.example .env
# Edit .env and fill in the Required variables (see Configuration below).
docker compose up -d --build
```

Open **<http://localhost:3000>**. If port 3000 is taken, set `APP_HOST_PORT` in
`.env` before launching.

### What to expect on first launch

The first poll fetches **every** AMC email in your inbox in one pass — with years of
history this can take a few minutes. After that, polls run every 5 minutes and only
look at new mail. Posters fade in as TMDB matches resolve. Reservations older than 30
days with no thank-you auto-flip to `watched`; anything 7–30 days old appears in the
bulletin asking "did you go or miss it?".

## Friends (federation) — optional

Pair your instance with a friend's so you can see each other's activity. Both
instances must be reachable at a URL the other can hit (a LAN address,
Tailscale MagicDNS, or a public domain).

### 1. Make your instance reachable & locked

In `.env`, set:

```ini
FEDERATION_ENABLED=1
FEDERATION_BASE_URL=https://your-instance.example.com   # how friends reach you
INSTANCE_NAME=Your Name                                 # shown to friends
OWNER_PASSCODE=<long random string>                     # protects your diary
```

`OWNER_PASSCODE` gates **every** screen except the friend-facing federation API, so
sharing the instance never exposes your diary. You unlock once per device. Recreate the
stack after editing `.env` (`docker compose up -d --build`).

### 2. Pair

1. Open the **Friends** tab → **Add a friend** → generate an invite code.
2. Send the code to your friend out-of-band.
3. They paste it into their **Add a friend → paste an invite**.

Once paired, each side syncs the other every few minutes (and within ~2–3s on changes).
Pairing is mutual and revocable from **Manage friends**. Control what you expose under
**What friends see**.

### 3. (Optional) iOS Web Push

To receive push notifications on an installed iOS PWA, generate VAPID keys and add them
to `.env`:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

```ini
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Push requires HTTPS, an installed (Add to Home Screen) PWA, and iOS 16.4+. Without VAPID
keys the in-app notification bell still works.

## Updating

```bash
cd marquee
git pull
docker compose up -d --build
```

Your data volume (`marquee_pgdata`) is preserved across updates and new schema
migrations apply automatically on boot.

## Configuration

All settings live in `.env` at the repo root (every field is documented inline in
`.env.example`).

### Required

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | Password for the bundled Postgres. The connection URL is built from this automatically. |
| `TMDB_API_KEY` | Your v3 API key from themoviedb.org. |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail address and app password. Leave both blank for manual-entry-only. |
| `BACKUP_HOST_PATH` | Host directory for daily backups. Point at durable storage so dumps survive container deletes. |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `APP_HOST_PORT` | `3000` | Host port the app listens on. |
| `POSTGRES_HOST_PORT` | `5433` | Host port for the bundled Postgres. |
| `BACKUP_RETENTION_DAYS` | `30` | How many days of backups to keep. |
| `ADMIN_API_TOKEN` | unset | Bearer token for the database export/import API. Strongly recommended if reachable beyond localhost. |
| `DATABASE_IMPORT_LIMIT` | `200mb` | Max request body size for the database import API. |
| `OWNER_PASSCODE` | unset | Passcode gating everything except the federation API. **Required before sharing your instance.** |
| `FEDERATION_ENABLED` | unset | Set to `1` to enable the Friends layer. |
| `FEDERATION_BASE_URL` | unset | This instance's externally-reachable URL; required to invite/accept friends. |
| `INSTANCE_NAME` | `Marquee` | The name friends see for your instance. |
| `FEDERATION_SYNC_INTERVAL_MIN` | `15` | How often to poll friends (change pushes are near-instant regardless). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | unset | Web Push (iOS) credentials. |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` / `TRAKT_REDIRECT_URI` | unset | Trakt app credentials (see below). |
| `TRAKT_ACCESS_TOKEN` / `TRAKT_REFRESH_TOKEN` | unset | Trakt user tokens, generated by the auth script. |

## Backups & restore

Daily gzipped dumps are written to `BACKUP_HOST_PATH`. To restore one:

```bash
gunzip < backups/marquee-2026-01-15.sql.gz \
  | docker exec -i marquee-postgres psql -U marqueeadmin marquee
```

You can also export/restore over the local API:

```bash
# Export a restorable gzipped SQL dump
curl -fsS http://127.0.0.1:3000/api/admin/database/export -o marquee-db.sql.gz
#   add -H "Authorization: Bearer $ADMIN_API_TOKEN" if that token is set

# Restore (replaces current DB contents)
curl -fsS -X POST http://127.0.0.1:3000/api/admin/database/import \
  -H 'Content-Type: application/gzip' --data-binary @marquee-db.sql.gz
```

## Trakt sync (optional)

To mirror watches to Trakt, create an app at
<https://trakt.tv/oauth/applications>. Add every URL where you access Marquee to the
app's **Redirect URI** and **JavaScript origin** fields (e.g. `http://localhost:3000`
locally, plus any public URL behind a reverse proxy). Put the client ID, secret, and
chosen redirect URI in `.env`, then authorize:

```bash
node server/scripts/trakt-device-auth.js   # approve in a browser; tokens saved to .env
node server/scripts/trakt-backfill.js      # queue previously-logged movies (optional)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Empty grid + "Stats failed" after a few minutes | Server can't reach Postgres. Check `docker logs marquee` for `Postgres connected`. On `ECONNREFUSED`, confirm `POSTGRES_PASSWORD` matches the running container. |
| Poller logs `imap: 0 messages` | No matching AMC emails, or IMAP is blocked. Run `node server/scripts/imap-debug.js` to verify the connection. |
| `Invalid credentials` from Gmail | You're using your account password, not an app-specific one — see step 2. |
| TMDB matches wrong/missing | Open the watch → **Assign movie** → pick the right film. Bulk re-run: `node server/scripts/backfill-tmdb.js`. |
| Friend won't pair / shows offline | Confirm both sides have `FEDERATION_ENABLED=1` and a `FEDERATION_BASE_URL` each can reach. A `401` means the connection was revoked — re-invite. |
| iOS push silent or missing | Needs HTTPS, an installed PWA, iOS 16.4+, and VAPID keys set. Remove and re-add the home-screen icon to refresh the service worker. |
| Blank/white splash on iOS | iOS caches the splash at install. Remove the home-screen icon, force-quit Safari, reopen the site, re-Add to Home Screen. |
| Backups missing from `BACKUP_HOST_PATH` | Confirm `BACKUP_DIR` is set (default `/backups`) and the host path is writable. Manual run: `docker exec marquee node -e "require('./workers/backup').runBackup().then(p => console.log(p))"`. |

## Reference

<details>
<summary><b>API routes</b></summary>

**Diary**

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness check; pings the database. |
| `GET /api/watches` | List watches. Supports `q`, `status`, `sort`, `dir`, `genre`, `min_rating`, `format`, `from`, `to`, `limit`, `offset`. |
| `GET /api/watches/notifications` | Watches needing attention (no-show, cancelled, identify, confirm). |
| `GET /api/watches/:id` · `POST /api/watches` · `PATCH /api/watches/:id` · `DELETE /api/watches/:id` | Read/create/update/delete a watch. |
| `POST /api/watches/:id/recheck-unseen` | Re-resolve a Screen Unseen against r/AMCsAList. |
| `GET /api/tmdb/search?q=` · `GET /api/theaters?q=` · `GET /api/search-suggest?q=` | Search helpers. |
| `GET /api/stats?period=all\|year\|month&month=YYYY-MM` | Aggregate stats; drives Year-in-Review. |
| `GET /api/export[?download=0]` | Full JSON dump of watches, theatres, and TMDB cache. |
| `GET /api/admin/database/export` · `POST /api/admin/database/import` | Full DB backup / restore (import is destructive). |

**Friends & social**

| Route | Purpose |
|---|---|
| `GET /api/friends` · `DELETE /api/friends/:id` | List / remove friends. |
| `POST /api/friends/invite` · `POST /api/friends/accept` | Create / redeem an invite code. |
| `GET /api/friends/feed` | Combined activity feed. |
| `GET /api/friends/:id/watches` · `GET /api/friends/:id/profile` · `GET /api/friends/:id/common` | A friend's cached diary, profile, and films-in-common. |
| `POST /api/friends/:id/comment` · `POST /api/friends/:id/recommend` | Comment on / recommend a film. |
| `GET\|PUT /api/friends/settings` | What you share. |
| `GET\|POST\|DELETE /api/notifications` | In-app notifications (list, mark read, dismiss/clear). |
| `/api/federation/*` | Friend-facing, token-gated. Fails closed unless `FEDERATION_ENABLED=1`. |

All `/api/*` routes are rate-limited to 600 req/min per IP. With `OWNER_PASSCODE` set,
every route except `/api/federation`, `/api/auth`, and `/api/health` requires the
unlock header.

</details>

<details>
<summary><b>Database schema</b></summary>

Auto-applied on boot via `CREATE TABLE IF NOT EXISTS` in `server/db.js` plus numbered
migrations under `server/migrations/`.

- `theaters` — distinct AMC venues seen so far.
- `watches` — one row per reservation/Thank You. `status` is `pending`, `watched`, `cancelled`, or `no_show`.
- `tmdb_cache` — TMDB API responses, keyed by `tmdb_id`.
- `email_log` — every parsed AMC email, deduped by `gmail_message_id`; pruned to the last 730 days.
- `friends` / `friend_watches` / `friend_profiles` — paired instances and their cached diaries.
- `social_events` / `notifications` — comments, recommendations, and the notification feed.
- `_migrations` — tracks which numbered SQL files have been applied.

</details>

## Stack

React 18 + Vite (plain JS/CSS) · Node 20 + Express · Postgres 16 · `imapflow` +
`cheerio` for email ingest · `web-push` for iOS notifications · single multi-stage
Docker image bundled with Postgres via `compose.yaml`.
