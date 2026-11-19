# Marquee

A self-hosted AMC movie tracker. Marquee watches your Gmail for AMC reservation and
"Thank You" emails, parses them, enriches each film with TMDB metadata, and surfaces
your whole moviegoing history in a cinematic poster-grid PWA, plus an optional
federated **Friends** layer that lets you connect with other Marquee instances and
share what you're watching.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/overview.png" width="250"><br><sub><b>Year-in-Review</b></sub></td>
    <td align="center"><img src="docs/screenshots/poster-grid.png" width="250"><br><sub><b>Poster grid</b></sub></td>
    <td align="center"><img src="docs/screenshots/film-detail.png" width="250"><br><sub><b>Film detail</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/now-playing.png" width="250"><br><sub><b>Now Playing</b></sub></td>
    <td align="center"><img src="docs/screenshots/friends-feed.png" width="250"><br><sub><b>Friends feed</b></sub></td>
    <td align="center"><img src="docs/screenshots/friend-profile.png" width="250"><br><sub><b>Friend profile</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/notifications.png" width="250"><br><sub><b>Notifications</b></sub></td>
    <td align="center"><img src="docs/screenshots/notification-settings.png" width="250"><br><sub><b>ntfy &amp; push settings</b></sub></td>
    <td align="center"><img src="docs/screenshots/add-friend.png" width="250"><br><sub><b>Add a friend</b></sub></td>
  </tr>
</table>

## Features

**Your diary**
- **Automatic logging**: reads your AMC emails and records every movie, no manual entry.
- **Rich metadata**: pulls posters, runtimes, genres, and directors from TMDB.
- **Your seat**: the auditorium and seats from each reservation email, shown on the film. **See seat map** draws it in place: the live map for a show still to come, or the auditorium with where you sat for one you've seen.
- **Showtime reminders**: a notification two hours before a booked film with where to go, where you are sitting and when it lets out (`SHOWTIME_REMINDER_MINUTES` changes the lead time).
- **Screen Unseen reveals**: resolves AMC Screen/Scream Unseen mysteries via r/AMCsAList, keeping the title hidden until the showing lets out.
- **Film sheet**: tap a poster to rate, add notes and tags, change the status (Booked, Watched, No-show, Cancelled) or the date; everything saves as you go. **Show friends** keeps a film out of what friends see when switched off.
- **Showtimes on posters**: upcoming films show their release date; booked reservations show the showtime.
- **Year-in-Review**: cadence chart, top genres/directors/theatres, 5★ picks, and a per-month/per-year A-List savings breakdown (mark the months you didn't have A-List and they drop out of the maths). Every stat is tappable for a plain-English detail sheet.
- **Monthly Wrapped**: a story-style recap of the month, offered in its last few days.
- **Search & filter**: across your entire history by title, director, genre, rating, or tag (formats like IMAX and Dolby are tags).
- **Installable PWA**: works on phone and desktop, offline-friendly.

**Now Playing**
- **Showtimes at your AMC**: no setup. It opens on the theatre you go to most, found from your reservation emails, and you can add others or set a home theatre. Each day's films are listed by screen (IMAX, Dolby Cinema, PRIME, 3D, standard) for as far ahead as tickets are on sale.
- **Film details**: tap a poster or title for the synopsis, director, cast, TMDB score and trailer.
- **Guess the Unseen**: an upcoming Screen or Scream Unseen offers a ranked shortlist of likely films, worked out from AMC's rating and runtime, what opens soon, and how past Unseens went. Hidden until you ask.
- **Alerts**: an Unseen going on sale at your theatres, new films at your main theatre, and any showing you choose to watch filling up or selling out.
- **Seats left and seat maps**: every showtime shows how many seats are open; tap it for the auditorium, seat by seat, refreshed while you look.
- **Knows your diary**: films you have seen or already booked are marked, and the theatres you have been to appear as one-tap chips, most visited first.
- Showtimes and seats are read from Fandango's public site endpoints, with no key or account. They are undocumented, so this tab can break if Fandango changes them; the Status page reports it when it does.

**Friends (federation)**
- **Connect instances directly**: no central server; you and a friend swap secret links and the two instances sync over an encrypted Tailcat tunnel, with nothing exposed to the internet. Each URL is its own credential: revoke or rotate one friend without touching the rest.
- **Activity feed**: see what friends have logged and what's coming up.
- **Seeing together**: matching upcoming reservations merge into one card with a shared comment thread, and the card says where each person is sitting.
- **Taste-match**: % agreement and films-in-common on each friend's profile.
- **Notifications**: in-app bell plus iOS Web Push and [ntfy](https://ntfy.sh) for comments, friend bookings, and seeing-together alerts.

**Operations**
- **Daily backups**: automatic Postgres dumps, retained for 30 days.
- **Owner lock**: an optional passcode gates your diary so only the friend-facing API is reachable when you share the instance.
- **Status page**: every background job (AMC emails, Screen Unseen lookup, showtimes, showtime reminders, Now Playing alerts, film details, friend sync, Tailcat, backups, nightly cleanup, phone push, ntfy, and Trakt when it is set up) with when it last ran and whether it worked, plus a notification when one has been failing for over a day.

## Setup

Marquee runs as a single Docker stack (app + Postgres). You need Docker and two free
third-party credentials.

### 1. Get a TMDB API key (required)

1. Create an account at <https://www.themoviedb.org>.
2. Go to **Settings → API → Request an API key → Developer**.
3. Fill out the form (any URL works, e.g. `http://localhost:3000`). Approval is instant.
4. Copy the **v3 API key** (32 characters).

### 2. Get a Gmail app password (required for auto-ingest)

The poller signs into Gmail over IMAP and needs an app-specific password, not your
normal account password.

1. Enable **2-Step Verification** at <https://myaccount.google.com/security>.
2. Generate a password at <https://myaccount.google.com/apppasswords> (any name).
   Copy the **16-character** string.
3. Nothing else to configure: Marquee scans `[Gmail]/All Mail` for
   `from:@amctheatres.com` automatically.

> Skip this step to run in manual-entry-only mode: leave `GMAIL_USER` and
> `GMAIL_APP_PASSWORD` blank.

### 3. Launch

Marquee is published as a multi-architecture image (`linux/amd64` and
`linux/arm64`), so all you need are two files:

```bash
mkdir marquee && cd marquee
curl -O https://raw.githubusercontent.com/ijoshi129/Marquee/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/ijoshi129/Marquee/main/.env.example
# Edit .env and fill in the Required variables (see Configuration below).
docker compose up -d
```

Open **<http://localhost:3000>**. If port 3000 is taken, set `APP_HOST_PORT` in
`.env` before launching.

`compose.yaml` tracks `:latest` by default. To pin a release, set `MARQUEE_TAG=2.2`
in `.env`.

<details>
<summary>Building from source instead</summary>

```bash
git clone https://github.com/ijoshi129/Marquee.git marquee && cd marquee
cp .env.example .env
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

</details>

### What to expect on first launch

The first poll fetches **every** AMC email in your inbox in one pass. With years of
history this can take a few minutes. After that, polls run every 5 minutes and only
look at new mail. Posters fade in as TMDB matches resolve. Reservations older than 30
days with no thank-you auto-flip to `watched`; anything 7–30 days old appears in the
bulletin asking "did you go or miss it?".

## Friends (federation), optional

Connect your instance with a friend's so you can see each other's activity.
Connecting is a URL swap: adding a friend mints a secret URL for them, they do
the same for you, and you each paste the other's. The URL is the whole
credential: no accounts, no invite codes.

Friends reach each other over **Tailcat**, an encrypted tunnel carried through
Tailscale's free public relays. There is no domain to buy, no port to forward,
no VPN to share and no Tailscale account: each instance gets a permanent
`tailcat://` address, and traffic goes direct between the two boxes when it
can. The relays only ever see encrypted bytes, and the tunnel only answers
`/api/federation/*`.

### 1. Turn it on and lock your diary

In `.env`, set:

```ini
FEDERATION_ENABLED=1
TAILCAT_ENABLED=1
INSTANCE_NAME=Your Name                 # shown to friends
OWNER_PASSCODE=<long random string>     # protects your diary
```

Then recreate the stack (`docker compose up -d`). Your friend needs the same on
their instance. `OWNER_PASSCODE` gates **every** screen except the
friend-facing API, so a friend's link never exposes your diary. You unlock
once per device.

Your Tailcat address is kept in the database, so it survives restarts,
updates, backups and moving to a new host: friends never need a new link
because you redeployed.

### 2. Connect

1. One of you opens **Friends → Add a friend**, enters the other's name, and
   gets a secret link (shown once, as a QR code to scan or a link to copy).
   Send it over something private.
2. The other opens **Add a friend**, enters a name and pastes that link. Their
   instance sends its own link back over the tunnel, so the connection is
   two-way from that single paste.
3. If the link back never arrives (say the first instance was offline), ask
   for theirs and paste it via **Manage friends → Add URL**.

Once connected, each side syncs the other every few minutes (and within ~2–3s on
changes). Remove or rotate a friend's URL any time from **Manage friends**;
control what you expose under **What friends see**: recent watches, ratings, upcoming bookings, your seat at those showings, and Year-in-Review stats, each switchable, plus **Show friends** on any single film.

Treat these URLs like passwords: anyone holding yours can read what you share and
post comments as that friend. Send them over something private, and rotate a URL
if it leaks.

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

### 4. (Optional) ntfy

Prefer ntfy (or can't use iOS push)? Open the bell → **ntfy alerts**, point it at
ntfy.sh or your own server with a topic of your choice, and pick which alerts to
send. Configured entirely in the UI: no env vars, works on any device with the
ntfy app subscribed to that topic. Use a hard-to-guess topic name; on ntfy.sh,
the topic is the only secret.

## Updating

```bash
cd marquee
docker compose pull
docker compose up -d
```

Your data volume (`marquee_pgdata`) is preserved across updates and new schema
migrations apply automatically on boot.

If you build from source, pull the repo and rebuild instead:

```bash
git pull
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

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
| `APP_TIMEZONE` | `America/New_York` | The timezone your theatres are in. Showtime reminders and the Unseen reveal delay are timed by it. |
| `SHOWTIME_REMINDER_MINUTES` | `120` | How long before a booked show the reminder is sent. |
| `ALIST_MONTHLY_FEE` / `ALIST_TICKET_PRICE` / `ALIST_PREMIUM_SURCHARGE` | `27.71` / `16` / `5` | Prices behind the A-List savings estimate. Premium formats count as ticket + surcharge. |
| `GMAIL_LABEL` / `GMAIL_AMC_FROM` | unset / `amctheatres.com` | Scan one Gmail label instead of All Mail, and the sender domain to match. Only for special filter setups. |
| `TRUST_PROXY` | private proxies | Which proxies to trust for client IPs (hop count, addresses, or `false`). Only the rate limiter uses it. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn` or `error`. |
| `DATABASE_IMPORT_LIMIT` | `200mb` | Max request body size for the database import API. |
| `OWNER_PASSCODE` | unset | Passcode gating everything except the federation API. **Required before sharing your instance.** |
| `FEDERATION_ENABLED` | unset | Set to `1` to enable the Friends layer. |
| `TAILCAT_ENABLED` | unset | Set to `1` to reach friends over Tailcat. Needed for Friends. |
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

## Screen Unseen reveals

AMC sells Screen Unseen and Scream Unseen screenings without saying what the film
is, and the reservation email is no more forthcoming, so those watches arrive with
no poster and no TMDB match. The community posts the answers in a megathread on
[r/AMCsAList](https://www.reddit.com/r/AMCsAList/), which Marquee reads to fill them
in once the reveal is up. Nothing to configure: it reads the subreddit's public Atom
feed, no Reddit account or API key involved.

The reveal usually isn't posted until after the screening, so a fresh Unseen stays
unidentified for a while. That's expected. The film sheet has a **Re-check** button
to force a fresh lookup when the megathread has been updated but the app hasn't
noticed yet, and **Assign movie** to set it yourself. You were there, after all.

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
| `Invalid credentials` from Gmail | You're using your account password, not an app-specific one. See step 2. |
| TMDB matches wrong/missing | Open the watch → **Assign movie** → pick the right film. Bulk re-run: `node server/scripts/backfill-tmdb.js`. |
| Friend won't sync / shows an error | Confirm both sides have `FEDERATION_ENABLED=1` and `TAILCAT_ENABLED=1`, and that the Status page shows Tailcat connected. "Access rejected" means their URL for you was rotated or removed. Ask for a fresh one and paste it via **Manage friends → Edit URL**. |
| Tailcat never connects | The Status page's Tailcat line says why. Check both sides have `TAILCAT_ENABLED=1` and recreated the stack, and that the box can make outbound connections (HTTPS and UDP) to the internet; a network that blocks Tailscale's relays blocks Tailcat. `docker logs marquee` shows the helper's own errors. |
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
| `GET /api/watches` | List watches. Supports `q`, `status`, `sort`, `dir`, `genre`, `director`, `tag`, `min_rating`, `from`, `to`, `include_pending`, `limit`, `offset`. |
| `GET /api/watches/notifications` | Watches needing attention (no-show, cancelled, identify, confirm). |
| `GET /api/watches/:id` · `POST /api/watches` · `PATCH /api/watches/:id` · `DELETE /api/watches/:id` | Read/create/update/delete a watch. |
| `POST /api/watches/:id/recheck-unseen` | Re-resolve a Screen Unseen against r/AMCsAList. |
| `GET /api/watches/:id/comments` · `POST /api/watches/:id/comment` | Friends' comments on your film, and your replies. |
| `GET /api/tags` | Tags in use, for the tag picker. |
| `GET /api/alist-membership` · `PUT /api/alist-membership/:year[/:month]` | Which years and months counted as A-List. |
| `GET /api/tmdb/search?q=` · `GET /api/theaters?q=` · `GET /api/search-suggest?q=` | Search helpers. |
| `GET /api/stats?period=all\|year\|month&month=YYYY-MM` | Aggregate stats; drives Year-in-Review. |
| `GET /api/export[?download=0]` | Full JSON dump of watches, theatres, and TMDB cache. |
| `GET /api/admin/database/export` · `POST /api/admin/database/import` | Full DB backup / restore (import is destructive). |
| `GET /api/admin/email-log[/:id]` · `POST /api/admin/email-log/:id/reparse` · `POST /api/admin/poll-now` | Parsed emails, re-parse one, poll Gmail now. |
| `GET /api/status` | Health of every background job (the Status page). |
| `GET /api/auth/status` · `POST /api/auth/unlock` | Owner lock state, and unlock with the passcode. |

**Now Playing**

| Route | Purpose |
|---|---|
| `GET\|PUT /api/now-playing/theatres` | Home theatre and the saved list. |
| `GET /api/now-playing/theatres/search?q=` | AMC theatres near a ZIP or `City, ST`. |
| `GET /api/now-playing/showtimes?theatre=&date=` | One theatre's films and showtimes for a day, plus the dates on sale. |
| `GET /api/now-playing/seats/:hash` · `POST /api/now-playing/seats/counts` | A showing's seat map, and open-seat counts for several showings. |
| `GET /api/now-playing/booking/:watchId` | The seat map for a diary film, with your seat. |
| `GET /api/now-playing/poster?title=&year=` | A TMDB poster for a film whose own poster is missing or dead. |
| `GET /api/now-playing/film?title=&year=` | Synopsis, cast, score and trailer for a film on the board, from TMDB. |
| `GET /api/now-playing/unseen-guesses?date=&kind=&rating=` | Ranked guesses at what an upcoming Unseen is. |
| `GET\|POST /api/now-playing/watching` · `DELETE /api/now-playing/watching/:hash` | Showings to be told about when they fill up. |

**Friends & social**

| Route | Purpose |
|---|---|
| `GET\|POST /api/friends` · `PATCH\|DELETE /api/friends/:id` | List / add / edit / remove friends. |
| `POST /api/friends/:id/rotate` | Mint a fresh secret URL for a friend. |
| `POST /api/friends/sync-now` · `POST /api/friends/:id/sync` · `POST /api/friends/:id/test-connection` | Sync everyone or one friend now, and check a friend's URL. |
| `GET\|PUT /api/friends/identity` | The instance name friends see. |
| `GET /api/friends/feed` | Combined activity feed. |
| `GET /api/friends/:id/watches` · `GET /api/friends/:id/profile` · `GET /api/friends/:id/common` | A friend's cached diary, profile, and films-in-common. |
| `POST /api/friends/:id/comment` | Comment on a friend's film. |
| `GET\|PUT /api/friends/settings` | What you share. |
| `GET\|POST\|DELETE /api/notifications` | In-app notifications (list, mark read, dismiss/clear). |
| `GET /api/push/key` · `POST /api/push/subscribe` · `POST /api/push/unsubscribe` | Web Push subscription for this device. |
| `GET\|PUT /api/ntfy` · `POST /api/ntfy/test` | ntfy settings, and a test message. |
| `/api/federation/:token/*` | Friend-facing; the secret URL is the credential. Fails closed unless `FEDERATION_ENABLED=1`. |

All `/api/*` routes are rate-limited to 600 req/min per IP. With `OWNER_PASSCODE` set,
every route except `/api/federation`, `/api/auth`, and `/api/health` requires the
unlock header.

</details>

<details>
<summary><b>Database schema</b></summary>

Auto-applied on boot via `CREATE TABLE IF NOT EXISTS` in `server/db.js` plus numbered
migrations under `server/migrations/`.

- `theaters`: distinct AMC venues seen so far.
- `watches`: one row per reservation/Thank You. `status` is `pending`, `watched`, `cancelled`, or `no_show`.
- `tmdb_cache`: TMDB API responses, keyed by `tmdb_id`.
- `email_log`: every parsed AMC email, deduped by `gmail_message_id`; pruned to the last 730 days.
- `friends` / `friend_watches` / `friend_profiles`: connected instances and their cached diaries.
- `social_events` / `notifications`: comments and the notification feed.
- `federation_identity` / `federation_settings`: this instance's name and what it shares.
- `push_subscriptions` / `ntfy_settings`: where notifications go.
- `alist_membership` / `alist_membership_month`: which years and months counted as A-List.
- `app_state`: small key/value state (theatres, saved seat layouts, Tailcat identity, job status).
- `_migrations`: tracks which numbered SQL files have been applied.

</details>

## Stack

React 19 + Vite (plain JS/CSS) · Node 24 + Express · Postgres 16 · `imapflow` +
`cheerio` for email ingest · `web-push` for iOS notifications · a small Go helper on Tailscale's `tailcat` library for friend tunnels · single multi-stage
Docker image bundled with Postgres via `compose.yaml`.
