# Marquee

A self-hosted, single-user AMC movie tracker PWA. Watches Gmail for AMC reservation and Thank You emails, parses them, enriches the films with TMDB, and surfaces everything in a poster-grid UI. Owner: `ijoshi129`. Lives in this repo.

## Stack

- **Client:** React 18 + Vite. Plain JS (no TypeScript). Plain CSS (no Tailwind). Font stack: Fraunces (display) + Geist Mono (UI caps).
- **Server:** Node 20 + Express + `pg` connection pool.
- **Database:** Postgres 16. Schema auto-applies on boot via `CREATE TABLE IF NOT EXISTS` in `server/db.js` plus numbered SQL migrations in `server/migrations/`. Tracked in `_migrations`.
- **Email ingest:** `imapflow` + `cheerio`. Polls Gmail every 5 minutes for `from:@amctheatres.com` in `[Gmail]/All Mail`.
- **Container:** Single multi-stage Dockerfile (`docker/Dockerfile`) builds client and server into one image. Bundled with Postgres via `compose.yaml`.

## Production deployment — Tank (Unraid)

Prod lives on the user's Unraid box "Tank" at `/mnt/user/appdata/marquee/`. **Non-obvious specifics:**

- **Port:** `APP_HOST_PORT=3030` in `.env` (3000 was taken).
- **Postgres volume:** the data volume on Tank is named **`docker_marquee_pgdata`**, not `marquee_pgdata`. Legacy from the original install which used `docker/docker-compose.yml` (project name "docker"). That compose file no longer exists in the repo.
- **Override file:** Tank has `compose.override.yaml` (alongside `compose.yaml`) mapping the in-repo volume name to the existing one:
  ```yaml
  volumes:
    marquee_pgdata:
      external: true
      name: docker_marquee_pgdata
  ```
- **This override is the only line of defense protecting Tank's data.** If lost, the next `docker compose up -d` creates an empty `marquee_pgdata` volume and runs a blank database. Always preserve `.env` and `compose.override.yaml` alongside any backup.
- Container names are pinned (`marquee`, `marquee-postgres`). Backup dir is host-mounted; daily Postgres dumps land there.
- **NPM (Nginx Proxy Manager) fronts prod.** Express has no `trust proxy` set, so the rate-limiter and access logs see NPM's IP, not the client — pre-existing, not a regression; only matters if you want per-client limiting/real IPs.
- **Planned migration (not done):** move prod off Tank to a **dedicated Proxmox LXC** with **Tailscale installed inside the LXC** (so the LXC is its own tailnet node — node-sharing exposes only Marquee, and `OWNER_PASSCODE` locks everything but the federation API). Needs `/dev/net/tun` passthrough for `tailscaled`. Migrate via `pg_dump` → restore; carry `.env`. Until then prod stays on Tank and is **still pre-v1.5** (v1.5 + v2.0 are `main`/branch only).

## Deploy / update flow

The image is built on the host from the checkout — no registry round-trip. To update Tank:

```bash
cd /mnt/user/appdata/marquee
git pull
docker compose up -d --build
```

`compose.yaml` declares `build: { context: ., dockerfile: docker/Dockerfile }` so `--build` rebuilds whatever's in the working tree. Pinned `name: marquee` (project) and `name: marquee_pgdata` (volume) make fresh installs produce deterministic names regardless of install path.

GHCR has stale tags (`:latest`, `:0.2.0`, `:0.2`, `:sha-2e2f103`) all pointing at the same pre-removal digest — intentionally left in place, cost nothing.

## Repo conventions

- **Branch protection on `main`:** PRs required (0 required approvals → self-merge works). No direct pushes. No force pushes. No branch deletions. `enforce_admins: false` (owner can hotfix in an emergency).
- **Workflow for every change:** feature branch → PR → squash-merge → delete branch. Even one-line doc fixes go through this.
- **No Claude / Anthropic / AI / Opus / "assistant" mentions** anywhere user-facing — commits, PR titles, PR bodies, release notes, comments in code. Strict. Never add `Co-Authored-By` lines. Everything should read like a human authored it.
- **Comments:** default to none. Add a comment only when the *why* is non-obvious. No what-comments, no recap-comments, no "added for X feature" trail.
- **Migrations:** numbered SQL in `server/migrations/`. Idempotent (`IF NOT EXISTS`). One-shot data backfills go in `server/scripts/`.

## Contributors

- `ijoshi129` — owner, admin.
- `kiran` — write access. Pushed a database backup API directly to `main` once before branch protection was on; the same flow now goes through PRs.

## Release state

- Latest git tag: **`v1.5`** (2026-06-21), with a matching GitHub release. Tags are markers only — the image is built per-host from the tagged checkout. **No `v2.0` tag/WhatsNew yet** — the v2.0 feature work is unmerged on `federation-client` (see below).
- `client/src/components/WhatsNew.jsx` holds the in-app changelog. Bump `WHATS_NEW_VERSION` and prepend a `v1.x` block whenever shipping user-facing changes. The `v1.5` entry now has six sections (A-List by month · Tap any stat · Showtimes · Screen Unseen · director-filter chip · clickable Five-Star Picks).
- Merged to `main` since v1.5 (2026-06-22): **#39** director-filter chip in the filters panel, **#40** clickable Five-Star Picks posters, **#41** their WhatsNew entries.

## Friends / federation (v2.0 — WIP on branch `federation-client`, unmerged)

A federated social layer: independent Marquee instances pair and share over token-gated HTTP (Mastodon-style, no central server). Connectivity-agnostic — the code only stores a friend's `base_url` string. **Migrations 010–014.** Off unless `FEDERATION_ENABLED=1`; the friend-facing API fails closed otherwise.

- **Core (`/api/federation`, `/api/friends`):** per-friend tokens minted at pairing, **one per direction** — `inbound_token_hash` (sha256 of the token they present) + `outbound_token` (plaintext we present). One-time-code invite/accept handshake. `federation-sync` worker polls active friends, full-replace caching into `friend_watches`/`friend_profiles`; offline-tolerant, 401 ⇒ revoked. Change-triggered push (`notifyFriends` ping → targeted sync) for ~2–3s live updates.
- **Owner lock:** `OWNER_PASSCODE` gates **every** `/api` route except `/api/federation`, `/api/auth`, `/api/health`. Unset = no lock (legacy). One-time unlock per device (client sends `X-Owner-Passcode`). This is what makes Tailscale node-sharing safe — friends can reach the box but only the federation API.
- **Notifications (`/api/notifications`):** generic model + in-app bell (mark-read/dismiss/clear) **and iOS Web Push** (`web-push` dep, VAPID env, `sw.js` push handler). Push gotchas: needs HTTPS + installed PWA + iOS 16.4+; notification `icon`/`badge` must be **PNG** (SVG silently fails on iOS); a stale/orphaned subscription causes silent pushes that trip iOS's display budget — client unsubscribes-before-subscribe to avoid accumulation.
- **Social:** activity feed; **seeing-together** (matching upcoming reservations merge into one card; comments use a deterministic **canonical-host** so a mutually-connected group shares one thread — host can be a friend's copy or your own film); comments (`social_events`, owner-hub re-broadcast); recommendations (push a film → friend's watchlist + "Recommended by X" badge); taste-match (% agreement + films-in-common on a friend profile); presence ("Watching now" derived from showtime+runtime).
- **Env:** `FEDERATION_ENABLED`, `FEDERATION_BASE_URL`, `INSTANCE_NAME`, `FEDERATION_SYNC_INTERVAL_MIN`, `OWNER_PASSCODE`, `VAPID_PUBLIC_KEY`/`PRIVATE_KEY`/`SUBJECT` (all documented in `.env.example`; instance handles were dropped — name only).
- **Status / open items:** `federation-client` is **not merged or PR'd**; **#42** (early server-only branch) is now a strict subset of it — close it and open one clean PR. No v2.0 WhatsNew/tag/deploy yet. **Friends timeline layout is disliked** (upcoming reservations sort above Today's activity); a "Coming up" rail experiment was built then reverted — still unresolved.

## Session log — v2.0 WIP (2026-06-22)

Built the whole **Friends / federation + notifications + social layer** on `federation-client` (architecture + open items in the "Friends / federation" section above), ~9 commits, verified on a local 2–3 instance rig and real iOS Web Push via `mtest.monklabs.org`. Also merged **#39/#40/#41** (director-filter chip, clickable Five-Star Picks) to `main`.

Process notes:
- Long-lived dev servers must use the **managed background runner** — plain `&` backgrounding dies when the Bash tool call returns.
- `compose.yaml` has `env_file: ./.env`, so the container's env comes from `./.env`; a `--env-file` flag only covers `${...}` **interpolation**, not container env. Inject federation/VAPID vars via the override's `environment:` block (or put everything in the test dir's `./.env`).
- iOS PWA service-worker updates: reopening doesn't swap the worker — delete + re-add the home-screen icon (and clear Safari website data) to pick up a new `sw.js`.

## Session log — v1.5 (2026-06-21)

Shipped a batch of features as four squash-merged PRs (#33, #37, #34, #38) plus an earlier fix (#32). **Tank prod has NOT been updated yet** — owner updates it manually via the deploy flow above; v1.5 is on `main`/GitHub only.

What shipped and where the code lives:

- **Cancelled ≠ Seen (#32, noted under v1.4):** `server/routes/watchlist.js` now-playing "seen" set is scoped to `status = 'watched'`, so a cancelled reservation no longer shows as Seen in Now Playing.
- **Per-month A-List membership (#33):** `alist_membership` (year) + new `alist_membership_month` (year, month) table (migration `009`). Membership resolves per month: month override → year flag → default member. A year toggle is authoritative — it clears that year's month overrides in the same transaction (`server/routes/alist.js`). Savings math lives in `server/services/alist-value.js` (`computeAlistValue`, pure, unit-tested). Editor UI: `AListMembershipModal.jsx`, opened from "Edit A-List membership" under the In Review header (replaced the old inline per-year toggle).
- **Overview stat detail sheets (#37):** every In Review overview number is a clickable cell opening a period-aware sheet; each figure inside taps to reveal a plain-English note. `AListValueModal.jsx` (A-List Saved: paid vs ticket value, cost/film, value-per-dollar, break-even, per-year) and `StatDetailModal.jsx` (films / runtime / rating / genre). Server stats payload gained `value.by_year`, `rating_breakdown` (histogram + rated/unrated), and `years` (films + runtime per year).
- **Showtimes on posters (#34):** `server/services/tmdb.js` `shapeSearchResult` carries full `release_date`; `format.js` adds `fmtShortDate`/`isUpcoming`/`fmtShowtime`. Now Playing shows an amber release-date chip on unreleased films; pending diary cards show `🎟 <date · time>` in the badge (formatted in UTC).
- **Unseen reveal gate (#38):** an AMC Screen/Scream Unseen's title stays hidden until **showtime + 2h** (≈ when the film lets out) so the mystery isn't spoiled. `tmdb-rechecker` skips pre-showtime Unseens (no resolve, no retry burned); `WatchList.jsx` `needsIdentify` + the TMDB-review "?" flag + `Notifications.jsx` "identify" kind are all gated. Showtimes are stored as wall-clock labelled UTC, so the gate reinterprets them in the owner's timezone (`APP_TIMEZONE`, default `America/New_York`, server) / browser-local (client). Tunable constant `UNSEEN_REVEAL_AFTER_MS = 2h` lives in both `server/workers/tmdb-rechecker.js` and `client/src/format.js`.

Process notes for next time:
- **Stacked PRs auto-close when their base branch is deleted on merge.** When that happens: `git rebase --onto main <old-base-sha> <branch>`, force-push, open a *fresh* PR against `main` (you can't re-point a closed PR's base). Hit this with #36→#37 and #35→#38.
- Multiple PRs editing `WhatsNew.jsx`'s `v1.5` block conflict on merge — resolve by keeping all section objects under the one `v1.5` entry.

## Local dev environment (Mac)

- Postgres for dev runs in the `marquee-postgres` container (`docker compose up -d postgres`), host port **5433**, volume `marquee_pgdata`, seeded with ~40 watched films (incl. a future pending "AMC Screen Unseen: June 22" used to exercise the Unseen gate). The server reads the root `.env` (`server/server.js` line 1).
- **Port 3000 on this Mac is taken by an unrelated `server.mjs`** — run the marquee dev server with `PORT=3001 node server.js`. `client/vite.config.js` proxies `/api` to `:3000` by default; for local dev temporarily point it at `:3001`, and **always revert that proxy edit before committing**.
- Phone testing: `npx vite --host 0.0.0.0`, then open `http://10.0.0.55:5173` (LAN) or `http://100.76.29.29:5173` (Tailscale). The full Docker app (`docker compose up -d --build`) serves on `:3030`.
- UI mockups: write throwaway `.html` into `client/public/` (Vite serves it at root, reachable on the phone), then **delete before committing**. The owner reviews UI on their phone before merging and often wants a mockup before a real build.
- **Federation rig:** run multiple instances on one Mac by overriding env — extra logical DBs (`marquee_b`, `marquee_c`) in the same `marquee-postgres` container, each its own `node server.js` with `PORT=` / `POSTGRES_DB=` / `FEDERATION_ENABLED=1` / `FEDERATION_BASE_URL=http://localhost:<port>` / `INSTANCE_NAME=` (and `OWNER_PASSCODE=marqueetest` for the lock). They pair over `localhost` URLs. Plain `&` backgrounding doesn't survive a Bash tool call — use the managed background runner.
- **Push test container:** `marquee-fedtest` (Docker, host port **3033**, project `marquee-fedmac`, volume `marquee_fedtest_pgdata`) serves the prod build (SW registered, needed for push). Behind NPM at **`https://mtest.monklabs.org`** for iOS Web Push testing. Config in gitignored `.env.fedtest-mac` + `compose.fedtest.yaml` (run: `docker compose -p marquee-fedmac -f compose.yaml -f compose.fedtest.yaml --env-file .env.fedtest-mac up -d --build`). Rebuild it to pick up SW/client changes; iOS won't swap the worker on reopen — delete + re-add the home-screen PWA.

## User context

- Single-user, single-tenant app — there's no auth, no multi-account anything.
- Runs on the user's homelab; mostly reachable via Tailscale/LAN. Any "auth" or "CSP" conversation should account for that (no CSP, simple bearer token for admin DB API).
- The user is the AMC A-Lister whose data this tracks. Real watch history sits in prod.

## Working style preferences

- Terse responses. No end-of-turn recaps unless the change is substantial.
- Confirm before destructive actions (deletions, force-pushes, anything that touches prod data).
- For UI changes, the user prefers to verify visually before merging.
- Use `Read` / `Edit` / `Write` instead of `cat`/`sed`/`echo` for files. Use `gh` for all GitHub operations (PRs, releases, API).
- `rtk` wraps most CLI invocations automatically — don't reinvoke explicitly.
