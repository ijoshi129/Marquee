# Marquee

A self-hosted, single-user AMC movie tracker PWA. Watches Gmail for AMC reservation + Thank You emails, parses them, enriches with TMDB, surfaces it all in a poster grid. Owner: `ijoshi129`.

## Stack

- **Client:** React 18 + Vite, plain JS (no TS), plain CSS (no Tailwind). Fonts: Fraunces (display) + Geist Mono (UI caps). **Server:** Node 20 + Express + `pg` pool; also serves `client/dist`.
- **DB:** Postgres 16. Schema auto-applies on boot (`CREATE TABLE IF NOT EXISTS` in `server/db.js`) plus numbered migrations in `server/migrations/`, tracked in `_migrations`.
- **Email ingest:** `imapflow` + `cheerio`, polling Gmail every 5 min for `from:@amctheatres.com` in `[Gmail]/All Mail`. **Container:** multi-stage `docker/Dockerfile` → one multi-arch image on GHCR, bundled with Postgres via `compose.yaml`.

## Production deployment — laputa LXC 163

**Dedicated Proxmox LXC on laputa: CTID 163, hostname `marquee`** (2 cores / 2 GB), at `/opt/marquee/`. Tailscale runs inside (needs `/dev/net/tun`). Non-obvious specifics:

- **Addressing:** LAN `10.0.0.63`, tailnet `100.99.174.120`. `APP_HOST_PORT=3007`, `POSTGRES_HOST_PORT=5433`. DB `POSTGRES_USER=marqueeadmin`, `POSTGRES_DB=marquee`, volume `marquee_pgdata` (no override file — the legacy `docker_marquee_pgdata` mapping went with Tank).
- **Identity/federation:** `INSTANCE_NAME=LaterrKidd`, `FEDERATION_ENABLED=1`, `FEDERATION_BASE_URL=https://marquee-fed.monklabs.org` (see **Exposure**). `OWNER_PASSCODE` hardened (no longer `changeme`).
- **NPM (LXC 152 on laputa) fronts prod** at **`https://marquee.monklabs.org`**; otherwise tailnet/LAN-private. No `trust proxy` set, so the rate-limiter and logs see NPM's IP — pre-existing.
- Container names pinned (`marquee`, `marquee-postgres`). `backups/` under `/opt/marquee` (nightly dumps ~3.9M). Running **v2.3** from `ghcr.io/ijoshi129/marquee:latest` (migrations →016; no `MARQUEE_TAG` in `.env`, so it tracks `latest`).
- `rugbytank` = second Unraid box, TS IP `100.66.101.73`. Tank itself is gone (2026-07-05).

## Deploy / update flow

Tagged releases publish a multi-arch image to GHCR; hosts pull rather than build. Update prod:

```bash
ssh laputa "pct exec 163 -- sh -c 'cd /opt/marquee && git pull && docker compose pull && docker compose up -d'"
```

- **`pct` only exists on laputa** (`10.0.0.42`, in `~/.ssh/config`) — never run it from the Mac. Nested quoting bites: one `ssh laputa 'pct exec …'` per command beats a long `&&` chain. **Don't `. ./.env`** there (unquoted values with special chars make `sh` choke) — use `U=$(grep -m1 ^POSTGRES_USER= .env | cut -d= -f2)`. `_migrations`' PK is **`filename`**, not `name`.
- **Publishing:** `.github/workflows/publish.yml` fires on `v*` tags — builds `linux/amd64` + `linux/arm64` on native runners (free, public repo, no QEMU), pushes by digest, merges one manifest list. So `:latest` = last release. Tags are `vMAJOR.MINOR`, **not valid semver**, so `metadata-action` matches by pattern, not `type=semver`; `v2.3` → `2.3`, `2`, `latest`.
- **compose:** pulls `ghcr.io/ijoshi129/marquee:${MARQUEE_TAG:-latest}` — that file + a filled `.env` is a complete install, no checkout. `compose.build.yaml` overrides to build from source. Pinned `name: marquee` (project) and `name: marquee_pgdata` (volume) keep installs deterministic.
- **`.dockerignore` is load-bearing:** without it `COPY server ./server` layered the host's `node_modules` over the pruned prod install and baked `server/.env` into the image. Patterns are **anchored at the context root** — `.env` does *not* match `server/.env`; use `**/.env`.
- **Migrating a self-built install:** keep their `.env` (identity, passcode, VAPID live there), `docker compose down` **without `-v`**, swap in the published `compose.yaml`, pull. **Check the volume name first** — a differently-named project yields `<dir>_marquee_pgdata`, so the pinned `marquee_pgdata` silently starts a blank DB; map it in `compose.override.yaml` (`external: true`, `name: <actual>`). Between hosts: `pg_dump` → restore, carry `.env`.

## Repo conventions

- **Branch protection on `main`:** PRs required (0 approvals → self-merge works). No direct/force pushes, no branch deletions. `enforce_admins: false` (owner can hotfix).
- **Every change:** branch → PR → squash-merge → delete branch. Even one-line doc fixes.
- **No Claude / Anthropic / AI / Opus / "assistant" mentions** anywhere user-facing — commits, PR titles/bodies, release notes, code comments. Strict. Never add `Co-Authored-By`. Watch for the harness auto-appending a "Generated with" footer to PR bodies — strip it.
- **Comments:** default to none; only when the *why* is non-obvious. No what- or recap-comments.
- **Migrations:** numbered idempotent SQL in `server/migrations/`. One-shot backfills in `server/scripts/` — exception: a backfill that must precede a column drop lives in the migration (e.g. 015).
- **Contributors:** `ijoshi129` (owner/admin); `kiran` (write access — pushed a DB backup API straight to `main` pre-branch-protection, goes through PRs now, and runs his own instance at `marquee.kirantheram.com`).

## Release state

- Latest tag: **`v2.3`** (2026-07-31, released, on prod) — shared-screening cards, Unseen badges, editable instance name. Then `v2.2` (07-24), `v2.1` (07-05), `v2.0` (06-23), `v1.5` (06-21). **Pushing a tag is what publishes.**
- `client/src/components/WhatsNew.jsx` is the in-app changelog: bump `WHATS_NEW_VERSION` and prepend a block for any user-facing change. Now `2.3` (#67); older blocks retained.

## Friends / federation (v2.1 — capability URLs)

Independent instances share over HTTP; the whole credential is a per-friend **capability URL**. Off unless `FEDERATION_ENABLED=1` (fails closed with 503). **Migrations 010–016.**

- **Connect = URL swap.** `POST /api/friends {display_name}` mints `FEDERATION_BASE_URL/api/federation/<token>`, shown **once** (QR + copy), only its sha256 in `friends.inbound_token_hash`. Paste theirs into `friends.friend_url` (`PATCH /:id`); `POST /:id/rotate` invalidates + reissues. No invite codes or handshake — migration 015 dropped `status`/`direction`/`base_url`/`outbound_token`, **deleted revoked rows** (they'd otherwise regain access), and dropped `federation_invites`.
- **Auto-reciprocate.** Adding a friend *with* their URL, or pasting one into a **previously-empty** slot, pushes ours back over the channel they gave us (`connect` inbox kind) — one paste links both ways. Receiver fills its slot when **empty or erroring** (`last_error` set): repairs a dead link, never redirects a healthy one. PATCH reciprocation **rotates** our inbound token first (only the hash is stored, so minting is the only way to re-advertise), and only when the slot was empty — so tracking a friend's rotation doesn't cycle ours.
- **Friend-facing API:** `GET /api/federation/:token/feed` (identity + stats + upcoming + watches with threads in one fetch; carries `tags` + the raw AMC title) and `POST …/inbox` (`kind: ping|connect|comment|recommend`). Wrong/rotated token ⇒ 404. The matched row **is** the authenticated author; inbox writes made before our first pull are re-keyed once sync learns `remote_instance_id`.
- **Sync worker:** full-replace caching into `friend_watches`/`friend_profiles`; every failure is transient (`last_error`, keep polling). Peer input hardened: showtime guard (`validShowing`), duplicate `remote_id` skip, 23505 remap only on the `remote_instance_id` constraint. `notifyFriends` debounced ping → targeted sync = ~2–3s live updates.
- **Owner lock:** `OWNER_PASSCODE` gates every `/api` route except `/api/federation`, `/api/auth`, `/api/health`. One-time unlock per device (`X-Owner-Passcode`). Unset ⇒ disabled (as in dev).
- **Notifications:** in-app bell (always records) + iOS Web Push + **ntfy** (`ntfy_settings`, mig 016; bell → gear). Per-kind toggles (comment/recommend/together/**booked**) gate **both** push channels at `notify()`. `booked` fires on a friend's new reservation, skipped when it matches one of yours (seeing-together announces instead). Push needs HTTPS + installed PWA + iOS 16.4+; PNG icons only; client unsubscribes-before-subscribe.
- **Social:** the feed is one **chat-style timeline** — your watched films **right** (warm-tinted), friends' **left** with an avatar, by date under day dividers ("On your films" strip was tried and removed). Threads are **iMessage bubbles** (tagged `mine` server-side by `author_instance_id`). **Coming-up rail** on top (soonest-first, tap-to-expand); out-of-week showtimes show a stacked date. Conversations on your **own** films live **on the film** (`EditWatchModal` + `GET /api/watches/:id/comments`) and those alerts deep-link there, not to a feed card. Verb is always "saw". Plus recommendations, taste-match, presence; friend sheets in Manage friends (Test/Sync/Edit URL/Rotate).
- **Shared screenings merge (v2.3).** Watched items use the same film+theatre+minute key as upcoming: one showing = one **full-width** card ("You, Alice & Bob saw" — no "together"; full width since it belongs to neither side) with one **canonical-host** thread; comments on non-host copies stay in the DB but leave the feed. Merged cards show **only your own** rating. Unseens key on **theatre+minute alone** (no tmdb id until identified; raw title differs per instance) and get a gold **SCREEN UNSEEN** chip (Scream = red) via `specialTag()`; rows missing a theatre *or* showtime never merge. `your_watch_id` keeps deep-links working on cards a friend hosts.
- **Exposure (LXC 163):** app stays private (Tailscale + NPM); only `/api/federation/*` goes public via a **Cloudflare Tunnel** path filter (`cloudflared` in the LXC: `marquee-fed.monklabs.org`, path `api/federation/*` → app port; everything else 404s at the edge). Any mutually reachable URL also works (LAN/VPN).
- **Identity gotcha:** `INSTANCE_NAME` still seeds `federation_identity` but **only on a fresh DB** (`ON CONFLICT DO NOTHING`), so setting it later never takes. Since v2.3 the name is editable in-app (Friends → Sharing; `GET`/`PUT /api/friends/identity`, saves on blur, pings friends) — and a friend's rename **overwrites the name you typed for them** on their next sync (`federation-sync.js:74`). Pre-v2.3 installs need `UPDATE federation_identity SET display_name='…' WHERE id=TRUE`. Cloning a volume still carries the old `instance_id` — SQL only.
- **A 403 is never Marquee.** It emits 404 (bad/rotated token, unknown route), 401 (owner lock), 400, 503 (federation off) — never 403, so a 403 from a friend's URL is always something in front of their app. `server: cloudflare` is on *every* proxied response and proves nothing — read the body: an nginx page or `/login` redirect means their origin, a branded block page means CF's WAF. Fix is a bypass for `/api/federation/*` (self-authenticating; wrong token 404s).

## Session log — 2026-07-31 (v2.3: shared screenings, Unseen badges, instance name)

- **Shipped #67 → tagged v2.3 → deployed to prod.** One PR, four changes (state under Friends/federation). Pre-upgrade dump `backups/marquee-pre-v2.3.sql.gz`; Postgres never recreated; verified digest, `_migrations`, identity, watch count, both public surfaces. The instance-name bug was the seed-once `ON CONFLICT DO NOTHING`, surfaced only because Kiran's instance advertised "Marquee" *with* `INSTANCE_NAME` set.
- **Verify a real build with no proxy edit:** `npx vite build` + `PORT=3001 node server.js` serves the production bundle (`server/server.js:139`) on the LAN.
- **Playwright `page.route`** rewrites an API response to fabricate feed cases without touching the dev DB (which already has 10 Screen / 3 Scream Unseen rows). Grouping took 125 watched cards → 47. The coming-up chip has ~78px inside a 96px poster, so `Jun 22 12:19 PM` truncated — date stacks over time instead of shrinking the type.

## Standing gotchas (earlier releases)

- **GHCR** over Docker Hub: no second account, `GITHUB_TOKEN` auth, no rate limit. Verify anonymous pull via an unauthenticated `ghcr.io/token` request, not `docker logout`. `raw.githubusercontent.com` caches ~5 min — confirm merged docs with `gh api …/contents/<path>`.
- **Pre-merge self-review earns its keep** — caught 8 real bugs before v2.1, worst migration 015's revoked-friend regression.
- Cross-tailnet MagicDNS doesn't resolve even for shared nodes — use the `100.x` IP. `compose.yaml` uses `env_file: ./.env`, and `--env-file` only covers `${...}` interpolation, not container env; inject via an override `environment:` block. New VAPID keys: `docker exec -w /app/server marquee node -e 'console.log(require("web-push").generateVAPIDKeys())'`.
- A `node_modules` symlink committed from a worktree clobbers the real directory on merge (`npm install` recovers). Stacked PRs auto-close when their base branch is deleted — rebase onto main, open a fresh PR. Screenshots via Playwright (in `client/`, uncommitted) at 390×844 with `deviceScaleFactor` only — `isMobile` inflates the viewport to ~507px and crops.
## Open

- **Kiran (`marquee.kirantheram.com`) unreachable** — his proxy blocks `/api/federation/*`; needs the bypass (403 note above) and, pre-v2.3, the SQL rename. Blocks live two-instance testing of v2.3 grouping.
- **Reconnect the pre-v2.1 "Rugby" friend** — broken both ways. Rugby hits **Rotate** (a URL shows once and only its hash is stored, so rotating is the only way to re-advertise) and sends it; paste via **Edit URL** and auto-reciprocate repairs both ends. Then check whether a conversation went quiet — v2.3 stops surfacing comments held on a non-host copy.
- **rugbytank rollout** — now just a `docker compose pull`.

## Local dev environment (Mac)

- Dev Postgres = the `marquee-postgres` container (`docker compose up -d postgres`), port **5433**, volume `marquee_pgdata`, ~40 seeded films + Alice/Bob friends. Server reads the root `.env`; no `OWNER_PASSCODE`/`FEDERATION_ENABLED` there, so the lock is off and federation 503s.
- **Port 3000 on this Mac is taken by an unrelated `server.mjs`** — use `PORT=3001 node server.js`. A *built* client needs no proxy edit (Express serves `client/dist`); only Vite dev mode needs `vite.config.js`'s `/api` proxy on `:3001`, and that must be **reverted before committing**.
- Phone testing: LAN `10.0.0.55`, Tailscale `100.76.29.29` (Vite `--host 0.0.0.0` on `:5173`, or the Express port). Docker on `:3030`.
- UI mockups: publish as **Artifacts** for phone review (not `client/public`). The owner reviews UI on their phone before merging and **always wants a mockup first** — offer labelled variants (A/B) with a recommendation rather than one design.
- **Federation rig:** extra logical DBs (`marquee_b`, `marquee_c`) in `marquee-postgres`, each its own `node server.js` with `PORT=`/`DATABASE_URL=`/`FEDERATION_ENABLED=1`/`FEDERATION_BASE_URL=http://localhost:<port>`/`INSTANCE_NAME=` (+ `OWNER_PASSCODE=marqueetest`). **Pass empty `GMAIL_USER= GMAIL_APP_PASSWORD=` or the poller ingests real AMC email into test DBs.** Plain `&` doesn't survive a Bash call — `nohup … & disown`. **zsh won't word-split an unquoted var**, so `env $common …` passes one arg and the vars silently don't apply.
- **Push test container:** `marquee-fedtest` (port **3033**, project `marquee-fedmac`, volume `marquee_fedtest_pgdata`), prod build behind NPM at **`https://mtest.monklabs.org`** for iOS Web Push. Config in gitignored `.env.fedtest-mac` + `compose.fedtest.yaml`. iOS won't swap the SW on reopen — delete + re-add.

## User context

- Single-user, single-tenant — no auth, no multi-account anything. Homelab-hosted, mostly Tailscale/LAN, so "auth"/"CSP" talk should account for that (no CSP; bearer token for the admin DB API). The owner is the A-Lister whose data this tracks; **real watch history sits in prod**.

## Working style preferences

- Terse. No end-of-turn recaps unless the change is substantial. Confirm before anything destructive or touching prod data.
- UI: mockup first, then verify visually on their phone before merging.
- `Read`/`Edit`/`Write` over `cat`/`sed`/`echo`. `gh` for all GitHub work. `rtk` wraps most CLI invocations — don't reinvoke it.
