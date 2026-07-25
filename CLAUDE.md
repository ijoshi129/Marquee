# Marquee

A self-hosted, single-user AMC movie tracker PWA. Watches Gmail for AMC reservation and Thank You emails, parses them, enriches the films with TMDB, and surfaces everything in a poster-grid UI. Owner: `ijoshi129`. Lives in this repo.

## Stack

- **Client:** React 18 + Vite. Plain JS (no TypeScript). Plain CSS (no Tailwind). Font stack: Fraunces (display) + Geist Mono (UI caps).
- **Server:** Node 20 + Express + `pg` connection pool.
- **Database:** Postgres 16. Schema auto-applies on boot via `CREATE TABLE IF NOT EXISTS` in `server/db.js` plus numbered SQL migrations in `server/migrations/`. Tracked in `_migrations`.
- **Email ingest:** `imapflow` + `cheerio`. Polls Gmail every 5 minutes for `from:@amctheatres.com` in `[Gmail]/All Mail`.
- **Container:** Multi-stage Dockerfile (`docker/Dockerfile`) builds client + server into one image, published multi-arch to GHCR. Bundled with Postgres via `compose.yaml`.

## Production deployment — laputa LXC 163

Prod lives in a **dedicated Proxmox LXC on laputa: CTID 163, hostname `marquee`** (2 cores / 2 GB), at `/opt/marquee/`. Tailscale runs inside (needs `/dev/net/tun`). **Non-obvious specifics:**

- **Addressing:** LAN `10.0.0.63`, tailnet `100.99.174.120`. `APP_HOST_PORT=3007`, `POSTGRES_HOST_PORT=5433`.
- **DB:** `POSTGRES_USER=marqueeadmin`, `POSTGRES_DB=marquee`, volume `marquee_pgdata`. No override file — the legacy `docker_marquee_pgdata` mapping is gone with Tank.
- **Identity/federation:** `INSTANCE_NAME=LaterrKidd`, `FEDERATION_ENABLED=1`, `FEDERATION_BASE_URL=https://marquee-fed.monklabs.org` (see **Exposure** below). `OWNER_PASSCODE` hardened (no longer `changeme`).
- **NPM (LXC 152 on laputa) fronts prod** at **`https://marquee.monklabs.org`**; app otherwise tailnet/LAN-private. Express has no `trust proxy` set, so the rate-limiter and access logs see NPM's IP, not the client — pre-existing, not a regression.
- Container names pinned (`marquee`, `marquee-postgres`). `backups/` under `/opt/marquee`. Running **v2.2** from `ghcr.io/ijoshi129/marquee:latest` (migrations →016; no `MARQUEE_TAG` in `.env`, so it tracks `latest`).
- **Tank (Unraid, tailnet `tail4da5e4`, LAN `10.0.0.58`) no longer runs Marquee** — fully torn down 2026-07-05. `rugbytank` = second Unraid box, tailnet `tail5011ba`, TS IP `100.66.101.73`.

## Deploy / update flow

Tagged releases publish a multi-arch image to GHCR; hosts pull it instead of building. To update prod:

```bash
pct exec 163 -- sh -c 'cd /opt/marquee && git pull && docker compose pull && docker compose up -d'
```

- **Publishing:** `.github/workflows/publish.yml` fires on `v*` tags — builds `linux/amd64` + `linux/arm64` on native runners (free, public repo — no QEMU), pushes by digest, merges one manifest list. Tag-triggered, not per-push, so `:latest` = last release. Tags are `vMAJOR.MINOR`, **not valid semver**, so `metadata-action` matches the version by pattern, not `type=semver`; `v2.2` → `2.2`, `2`, `latest`.
- **compose:** `compose.yaml` pulls `ghcr.io/ijoshi129/marquee:${MARQUEE_TAG:-latest}` — that file + a filled-in `.env` is a complete install, no checkout. `compose.build.yaml` is the override that builds from source. Pinned `name: marquee` (project) and `name: marquee_pgdata` (volume) keep installs deterministic.
- **`.dockerignore` is load-bearing:** without it `COPY server ./server` layered the host's `node_modules` over the pruned prod install and baked `server/.env` into the image. Patterns are **anchored at the context root** — `.env` does *not* match `server/.env`; that needs `**/.env`.
- **Migrating an existing/self-built install:** keep their `.env` (identity, passcode, VAPID live there), `docker compose down` **without `-v`**, swap in the published `compose.yaml`, pull. **Check the volume name first** — a differently-named project yields `<dir>_marquee_pgdata`, so the pinned `marquee_pgdata` silently starts a blank DB; map it in `compose.override.yaml` (`external: true`, `name: <actual>`).
- Migrate hosts via `pg_dump` → restore; carry `.env` (identity gotcha under Friends/federation).

## Repo conventions

- **Branch protection on `main`:** PRs required (0 required approvals → self-merge works). No direct pushes. No force pushes. No branch deletions. `enforce_admins: false` (owner can hotfix in an emergency).
- **Workflow for every change:** feature branch → PR → squash-merge → delete branch. Even one-line doc fixes go through this.
- **No Claude / Anthropic / AI / Opus / "assistant" mentions** anywhere user-facing — commits, PR titles, PR bodies, release notes, comments in code. Strict. Never add `Co-Authored-By` lines. Watch for the harness auto-appending a "Generated with" footer to PR bodies — strip it.
- **Comments:** default to none. Add a comment only when the *why* is non-obvious. No what-comments, no recap-comments.
- **Migrations:** numbered SQL in `server/migrations/`. Idempotent (`IF NOT EXISTS`). One-shot data backfills go in `server/scripts/` (exception: a backfill that must precede a column drop lives in the migration, e.g. 015).

## Contributors

- `ijoshi129` — owner, admin.
- `kiran` — write access. Pushed a DB backup API straight to `main` pre-branch-protection; goes through PRs now.

## Release state

- Latest git tag: **`v2.2`** (2026-07-24, GitHub release published) — GHCR publishing, chat feed, one-paste connect. `v2.1` (2026-07-05), `v2.0` (2026-06-23), `v1.5` (2026-06-21) before it. **Tags now trigger the image build** — pushing one is what publishes.
- `client/src/components/WhatsNew.jsx` holds the in-app changelog. Bump `WHATS_NEW_VERSION` and prepend a block whenever shipping user-facing changes. Now `2.2` (covers #52–#62); older blocks retained.

## Friends / federation (v2.1 — capability URLs)

Independent Marquee instances share over HTTP; the entire credential is a per-friend **capability URL**. Off unless `FEDERATION_ENABLED=1` (friend-facing API fails closed). **Migrations 010–016.**

- **Connect = URL swap.** `POST /api/friends {display_name}` mints `FEDERATION_BASE_URL/api/federation/<token>` — shown **once** (QR + copy), only its sha256 kept in `friends.inbound_token_hash`. Paste theirs into `friends.friend_url` (`PATCH /:id`); `POST /:id/rotate` invalidates + reissues. No invite codes, no handshake, no status state machine — migration 015 dropped `status`/`direction`/`base_url`/`outbound_token`, **deleted revoked rows** (they'd otherwise regain access), and dropped `federation_invites`.
- **Auto-reciprocate (single-sided connect).** Adding a friend *with* their URL, or pasting one via Edit URL into a **previously-empty** slot, pushes our URL back over the channel they gave us (`connect` inbox kind) — one paste links both ways. Receiver fills its slot when **empty or erroring** (`last_error` set) → repairs a dead link, never redirects a healthy one. PATCH reciprocation **rotates** our inbound token first (only its hash is stored, so minting is the only way to re-advertise) — done only when the slot was empty, so tracking a friend's rotation doesn't cycle our token needlessly.
- **Friend-facing API:** `GET /api/federation/:token/feed` (identity + stats + upcoming + watches with comment threads — one fetch per sync) and `POST …/inbox` (`kind: ping|connect|comment|recommend`). Wrong/rotated token ⇒ 404. The matched row **is** the authenticated author; inbox writes made before our first pull are re-keyed once sync learns `remote_instance_id`.
- **Sync worker:** full-replace caching into `friend_watches`/`friend_profiles`; every failure is transient (`last_error` + keep polling). Peer-input hardened: showtime guard (`validShowing`), duplicate `remote_id` skip, 23505 remap only on the `remote_instance_id` constraint. `notifyFriends` debounced ping → targeted sync gives ~2–3s live updates.
- **Owner lock:** `OWNER_PASSCODE` gates every `/api` route except `/api/federation`, `/api/auth`, `/api/health`. One-time unlock per device (`X-Owner-Passcode`).
- **Notifications:** in-app bell (always records) + iOS Web Push + **ntfy** (`ntfy_settings`, mig 016; configured in-app via bell → gear). Per-kind toggles (comment/recommend/together/**booked**) gate **both** push channels at `notify()`. `booked` fires when a friend's sync shows a new reservation; skipped when it matches one of yours (seeing-together announces instead). Push gotchas: HTTPS + installed PWA + iOS 16.4+; icons must be PNG; client unsubscribes-before-subscribe.
- **Social:** the activity feed is one **chat-style timeline** — your watched films **right** ("You saw …", warm-tinted), friends' **left** with an avatar, interleaved by date under centered day dividers (a separate "On your films" strip was tried and removed). Comment threads render as **iMessage bubbles** (yours right/accent, theirs left; tagged `mine` server-side by `author_instance_id`). **Coming-up rail** pinned on top (soonest-first, tap-to-expand). Conversations on your **own** films live **on the film** (`EditWatchModal` + `GET /api/watches/:id/comments`); their bell alerts deep-link to the film, not a feed card. Watched-verb is always "saw". Plus: seeing-together canonical-host threads; comments (hub = film owner's instance, re-broadcast via feed); recommendations; taste-match; presence. Friend detail sheets in Manage friends (Test/Sync/Edit URL/Rotate).
- **Exposure (laputa LXC 163):** app stays private (Tailscale + NPM); only `/api/federation/*` goes public via a **Cloudflare Tunnel** path filter (`cloudflared` in the LXC: hostname `marquee-fed.monklabs.org`, path `api/federation/*` → app port; everything else 404s at the edge), so minted URLs are public. Any mutually reachable URL also works (LAN/VPN).
- **Env:** unchanged set + VAPID. Identity gotcha: `federation_identity` seeds from `INSTANCE_NAME` once on a fresh DB — cloning a volume carries the old `instance_id`; fix by SQL update.

## Session log — 2026-07-24 (GHCR publishing)

- **Published to GHCR** (#61) so others update by pulling, not cloning + building — motive was ease of updates for friends, not discoverability. WhatsNew → 2.2 (#62); tagged **v2.2** + GitHub release. Chose GHCR over Docker Hub: no second account, `GITHUB_TOKEN` auth, no pull rate limit.
- **The `.dockerignore` was the real find** (details under Deploy flow) — surfaced by inspecting a *built* image, not by reading the Dockerfile, and the first fix missed `server/.env` because ignore patterns don't recurse.
- **GHCR package was already public** (inherited from the May 2026 `ci/ghcr-publish` run) — no flip needed. Verify anonymous pull with an unauthenticated `ghcr.io/token` request, not `docker logout`. `:latest` moved off the stale digest, which now holds only junk `0.2`/`0.2.0`/`sha-2e2f103` tags.
- **Prod cut over** to the published image: pre-upgrade dump at `backups/marquee-pre-v2.2.sql.gz`, Postgres never recreated (only the app service changed), data intact. Orphaned `marquee:local` left in place. Pull takes seconds vs. the old on-LXC Vite build.
- Gotchas: `raw.githubusercontent.com` caches ~5 min — confirm merged docs with `gh api …/contents/<path>`. #65 fixed a `MARQUEE_TAG` example naming `2.1`, never published; user-facing examples must name a real tag.

## Session log — 2026-07-19 (federation reciprocity + chat feed)

- **Shipped #52–#60** (no schema changes — migrations still →016). Auto-reciprocate (#52/#55) and the feed rework (#53–#60): current state for both is under Friends/federation. Auto-reciprocate verified on the two-instance rig incl. broken-both-ways reconnect and healthy-link-not-hijacked. "On your films" strip (#56) tried then removed (#57).
- **Owner's design taste:** iterated the feed model live three times via HTML mockups (published as **Artifacts** for phone review, not `client/public`) before landing "one chronological timeline of movies seen, you + friends."

## Session log — earlier releases

- **v2.1 (2026-07-05, #48–#51):** capability URLs, ntfy, Friends UI, screenshots. Pre-merge self-review caught 8 real bugs — worst was migration 015's revoked-friend regression (see **Connect = URL swap**), unfixable after the fact.
- **Gotchas:** a `node_modules` symlink committed from a worktree clobbers the real directory on merge (`npm install` to recover). README screenshots shot headless via Playwright (390×844, `deviceScaleFactor` only — `isMobile` inflates the viewport to ~507px and crops); diary grid needs 507px; Playwright is in `client/`, uncommitted.
- **v2.0 (2026-06-23, #43–#47):** cross-tailnet MagicDNS doesn't resolve even for shared nodes (use the `100.x` IP). `compose.yaml` uses `env_file: ./.env` — `--env-file` only covers `${...}` interpolation, not container env; inject via an override `environment:` block. VAPID: `docker exec -w /app/server marquee node -e 'console.log(require("web-push").generateVAPIDKeys())'`.
- **v1.5 (2026-06-21, #32–#38):** stacked PRs auto-close when their base branch is deleted on merge — rebase onto main + open a fresh PR to recover.
- **Open:** rugbytank rollout (now just a `docker compose pull`); reconnect the pre-v2.1 **"Rugby"** friend — broken both ways. Fix: Rugby hits **Rotate** (a URL is shown once and only its hash stored, so rotating is the only way to re-advertise) and sends the fresh URL; paste via **Edit URL** and auto-reciprocate repairs both ends.

## Local dev environment (Mac)

- Postgres for dev runs in the `marquee-postgres` container (`docker compose up -d postgres`), host port **5433**, volume `marquee_pgdata`, ~40 seeded films. The server reads the root `.env` (`server/server.js` line 1).
- **Port 3000 on this Mac is taken by an unrelated `server.mjs`** — run the dev server with `PORT=3001 node server.js`; point `client/vite.config.js`'s `/api` proxy at `:3001` temporarily and **revert before committing**.
- Phone testing: `npx vite --host 0.0.0.0` → `http://10.0.0.55:5173` (LAN) or `http://100.76.29.29:5173` (Tailscale). Full Docker app serves on `:3030`.
- UI mockups: throwaway `.html` in `client/public/` (delete before committing). The owner reviews UI on their phone before merging and often wants a mockup first.
- **Federation rig:** multiple instances on one Mac — extra logical DBs (`marquee_b`, `marquee_c`, create/drop as needed) in `marquee-postgres`, each its own `node server.js` with `PORT=`/`DATABASE_URL=`/`FEDERATION_ENABLED=1`/`FEDERATION_BASE_URL=http://localhost:<port>`/`INSTANCE_NAME=` (+ `OWNER_PASSCODE=marqueetest`). **Pass `GMAIL_USER= GMAIL_APP_PASSWORD=` (empty) or the poller ingests real AMC emails into test DBs.** Plain `&` doesn't survive a Bash call — use `nohup … & disown` or the managed background runner. **zsh won't word-split an unquoted var**, so `env $common …` passes the whole string as one arg and the vars silently don't apply (also how empty `GMAIL_*` fails to take); list each `VAR=val` explicitly.
- **Push test container:** `marquee-fedtest` (host port **3033**, project `marquee-fedmac`, volume `marquee_fedtest_pgdata`), prod build behind NPM at **`https://mtest.monklabs.org`** for iOS Web Push. Config in gitignored `.env.fedtest-mac` + `compose.fedtest.yaml`. iOS won't swap the SW on reopen — delete + re-add the home-screen PWA.

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
