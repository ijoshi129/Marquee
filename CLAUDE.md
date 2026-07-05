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
- **Tank now runs v2.0** (deployed 2026-06-23). Tank is on tailnet **`tail4da5e4`**.
- **LXC migration (in progress):** a **dedicated Proxmox LXC** with **Tailscale inside the LXC** (its own tailnet node — node-sharing exposes only Marquee; `OWNER_PASSCODE` locks everything but the federation API). Needs `/dev/net/tun` for `tailscaled`. The LXC is up, fronted by NPM at **`https://marquee.monklabs.org`**. Migrate via `pg_dump` → restore; carry `.env`. To share with a friend, share that *one* LXC node (it's also the tailnet node).

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

- Latest git tag: **`v2.0`** (2026-06-23, GitHub release published), the Friends/federation layer. `v1.5` (2026-06-21) before it. Tags are markers only — the image is built per-host from the tagged checkout.
- `client/src/components/WhatsNew.jsx` holds the in-app changelog. Bump `WHATS_NEW_VERSION` and prepend a block whenever shipping user-facing changes. `WHATS_NEW_VERSION` is now `2.0` (Friends entry); `v1.5` and earlier blocks retained.
- Pre-v2.0 merges to `main`: **#39** director-filter chip, **#40** clickable Five-Star Picks, **#41** their WhatsNew entries.

## Friends / federation (v2.0 — shipped & merged to `main`)

A federated social layer: independent Marquee instances pair and share over token-gated HTTP (Mastodon-style, no central server). Connectivity-agnostic — the code only stores a friend's `base_url` string. **Migrations 010–014.** Off unless `FEDERATION_ENABLED=1`; the friend-facing API fails closed otherwise.

- **Core (`/api/federation`, `/api/friends`):** per-friend tokens minted at pairing, **one per direction** — `inbound_token_hash` (sha256 of the token they present) + `outbound_token` (plaintext we present). One-time-code invite/accept handshake. `federation-sync` worker polls active friends, full-replace caching into `friend_watches`/`friend_profiles`; offline-tolerant, 401 ⇒ revoked. Change-triggered push (`notifyFriends` ping → targeted sync) for ~2–3s live updates.
- **Owner lock:** `OWNER_PASSCODE` gates **every** `/api` route except `/api/federation`, `/api/auth`, `/api/health`. Unset = no lock (legacy). One-time unlock per device (client sends `X-Owner-Passcode`). This is what makes Tailscale node-sharing safe — friends can reach the box but only the federation API.
- **Notifications (`/api/notifications`):** generic model + in-app bell (mark-read/dismiss/clear) **and iOS Web Push** (`web-push` dep, VAPID env, `sw.js` push handler). Push gotchas: needs HTTPS + installed PWA + iOS 16.4+; notification `icon`/`badge` must be **PNG** (SVG silently fails on iOS); a stale/orphaned subscription causes silent pushes that trip iOS's display budget — client unsubscribes-before-subscribe to avoid accumulation.
- **Social:** activity feed; **seeing-together** (matching upcoming reservations merge into one card; comments use a deterministic **canonical-host** so a mutually-connected group shares one thread — host can be a friend's copy or your own film); comments (`social_events`, owner-hub re-broadcast); recommendations (push a film → friend's watchlist + "Recommended by X" badge); taste-match (% agreement + films-in-common on a friend profile); presence ("Watching now" derived from showtime+runtime).
- **Env:** `FEDERATION_ENABLED`, `FEDERATION_BASE_URL`, `INSTANCE_NAME`, `FEDERATION_SYNC_INTERVAL_MIN`, `OWNER_PASSCODE`, `VAPID_PUBLIC_KEY`/`PRIVATE_KEY`/`SUBJECT` (all in `.env.example`; instance handles dropped — name only). Identity (`federation_identity.instance_id` + `display_name`) is seeded from `INSTANCE_NAME` **once on a fresh DB** (`ON CONFLICT DO NOTHING`) — **cloning a Marquee volume carries the old identity**, and changing `INSTANCE_NAME` later does nothing; fix with `UPDATE federation_identity SET display_name=…, instance_id=gen_random_uuid()`.
- **Reachability:** federation needs **bidirectional** reach (each box hits the other's `FEDERATION_BASE_URL`). Pairing only tests the accepter→inviter direction; sync needs both. `safeBaseUrl` allows LAN/Tailscale/localhost, rejects bad schemes + link-local `169.254`. Tailscale **MagicDNS names are tailnet-scoped — they DON'T resolve across tailnets even when nodes are shared**; for a shared node use its `100.x` IP + app port (`http://100.x:port`; Tailscale encrypts transport). Cross-tailnet sharing is a 2-step handshake (share **and** accept) — `tailscale ping` `no matching peer` = not accepted. Public HTTPS via NPM (valid cert) is the lowest-friction `FEDERATION_BASE_URL` (works for any friend); `https://…ts.net` needs a real cert (Tailscale Serve) or it fails.
- **Manage friends UI:** per-friend **Test Connection** (`POST /api/friends/:id/test-connection`, probes reach + token) and **Sync** (`/:id/sync`) buttons.
- **Status / open items:** v2.0 **merged** (#44, superseding the closed #42; README #43; #45 test/sync buttons + sync-on-pair; #46 pairing-race fix; #47 own-film comment threads), **tagged + released**. `federation-server-core` branch deleted. **Still open:** Friends timeline layout disliked (upcoming reservations sort above Today's activity; a reverted "Coming up" rail experiment).

## Session log — v2.0 ship + prod federation (2026-06-23)

- **Shipped v2.0:** merged #44 (Friends, incl. ~27 reliability/validation fixes from a multi-agent whole-app review), #43 (README + `docs/screenshots/`), #45–#47 (federation UX); published `v2.0` tag/release; closed #42; deleted `federation-server-core`.
- **Prod federation (Tank ↔ rugbytank):** `rugbytank` = second Unraid box, tailnet **`tail5011ba`**, Tailscale IP **`100.66.101.73`**, Marquee app **:3067**; also hosts the `mtest.monklabs.org` fedtest (a *separate* instance, identity "Mac"). Most debugging was reachability: cross-tailnet MagicDNS doesn't resolve (Tank `tail4da5e4` ≠ rugby `tail5011ba`) + a typo'd `100.x` IP. Fixes captured in the federation section.
- **Two prod bugs fixed:** #46 — the sync-on-pair from #45 raced the accepter storing its token → spurious 401 → friend wrongly `revoked`; now the accepter pings the inviter *after* storing (unstick a pair with `UPDATE friends SET status='active', last_error=NULL WHERE status='revoked'`). #47 — comments on *your own* films were stored + notified but had no UI; the feed now surfaces own films with comment threads.
- **Gotcha:** `web-push` is a v2.0 dep — a container missing it from `/app/server/node_modules` is running **pre-v2.0** code (deploy to fix). Generate VAPID in-container: `docker exec -w /app/server marquee node -e 'console.log(require("web-push").generateVAPIDKeys())'`. `OWNER_PASSCODE` was left as `changeme` on a public-facing box — harden before exposing.

## Session log — v2.0 build (2026-06-22)

Built the Friends/federation + notifications + social layer on `federation-client` (architecture in the section above), verified on a local rig + real iOS Web Push via `mtest.monklabs.org`. Process notes:
- Long-lived dev servers need the **managed background runner** — plain `&` dies when the Bash call returns.
- `compose.yaml` has `env_file: ./.env`; a `--env-file` flag only covers `${...}` interpolation, not container env. Inject vars via the override `environment:` block or the test dir's `./.env`.
- iOS PWA SW updates: reopening doesn't swap the worker — delete + re-add the home-screen icon (clear Safari data) to pick up a new `sw.js`.

## Session log — v1.5 (2026-06-21)

Four squash-merged PRs (#33/#37/#34/#38) + fix #32, where the code lives:
- **#32 Cancelled ≠ Seen:** `watchlist.js` now-playing "seen" scoped to `status='watched'`.
- **#33 Per-month A-List:** `alist_membership_month` table (mig `009`); resolve month override → year flag → default; year toggle clears that year's month overrides in one txn (`routes/alist.js`); math in `services/alist-value.js` (`computeAlistValue`, unit-tested); editor `AListMembershipModal.jsx`.
- **#37 Stat detail sheets:** every In Review number opens a period-aware sheet (`AListValueModal.jsx`, `StatDetailModal.jsx`); stats payload gained `value.by_year`, `rating_breakdown`, `years`.
- **#34 Showtimes on posters:** `tmdb.js shapeSearchResult` carries `release_date`; `format.js` `fmtShortDate`/`isUpcoming`/`fmtShowtime`; amber release chip + `🎟` badge (UTC).
- **#38 Unseen reveal gate:** Unseen title hidden until **showtime+2h**; `tmdb-rechecker` skips pre-showtime Unseens; gate honors `APP_TIMEZONE` (default `America/New_York`); `UNSEEN_REVEAL_AFTER_MS=2h` in `tmdb-rechecker.js` + `format.js`.

Process notes:
- **Stacked PRs auto-close when their base branch is deleted on merge.** Recover: `git rebase --onto main <old-base-sha> <branch>`, force-push, open a *fresh* PR (can't re-point a closed PR's base).
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
