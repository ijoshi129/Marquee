import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtShowtime, isShowingNow } from '../format';
import FriendProfile from './FriendProfile';
import SocialBar from './SocialBar';
import { specialTag } from './WatchList';

// Short relative time, shared with FriendProfile.
export function fmtAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dayLabel(at) {
  if (!at) return 'Earlier';
  const d = new Date(at);
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Compact chip for the strip (showtimes are wall-clock in UTC). A weekday only
// reads as a date within the coming week — "Tue" for something three weeks out
// is ambiguous — so beyond that it's the calendar date. Date + time won't fit on
// one line inside a 96px poster, hence `date`/`time` for the caller to stack;
// the shorter in-week forms come back as a single `label`.
function fmtChip(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const diff = Math.round(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      startOfDay(new Date())) / 86400000
  );
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  if (diff === 0) return { label: `Today ${time}` };
  if (diff === 1) return { label: `Tmrw ${time}` };
  if (diff > 1 && diff <= 6) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(d);
    return { label: `${wd} ${time}` };
  }
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(d);
  return { date, time };
}

// "You & Alice" / "Alice & Bob" / "You, Alice & Bob" — You first.
function peopleLabel(people) {
  const ns = [...(people || [])].sort((a, b) => (a.you ? -1 : b.you ? 1 : 0)).map((p) => p.name);
  if (ns.length <= 1) return ns[0] || '';
  if (ns.length === 2) return `${ns[0]} & ${ns[1]}`;
  return `${ns.slice(0, -1).join(', ')} & ${ns[ns.length - 1]}`;
}

function Stars({ value }) {
  return (
    <span className="feed-stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? '' : 'off'}>★</span>
      ))}
    </span>
  );
}

export default function FriendsView({ onAddFriend, focus }) {
  const [feed, setFeed] = useState(null);
  const [friends, setFriends] = useState([]);
  const [recs, setRecs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [picker, setPicker] = useState(null);
  const [expanded, setExpanded] = useState(null); // strip card id whose detail is open
  const [highlight, setHighlight] = useState(null); // feed item id to flash + open thread
  const [err, setErr] = useState(null);
  const handledFocus = useRef(null);

  // Open a feed item: one friend on it → that friend; several → a "who was
  // there" picker. Cards with no cast fall back to their single friend.
  function openItem(it) {
    const fr = (it.people || []).filter((p) => !p.you && p.friend_id);
    if (fr.length === 1) setSelected({ id: fr[0].friend_id, display_name: fr[0].name });
    else if (fr.length > 1) setPicker(fr);
    else if (it.friend_id) setSelected({ id: it.friend_id, display_name: it.friend_name });
  }

  const load = useCallback(async () => {
    try {
      const [f, fr, rc] = await Promise.all([
        api.friendsFeed(),
        api.friends(),
        api.recommendations().catch(() => []),
      ]);
      setFeed(f);
      setFriends(fr);
      setRecs(rc);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  async function actRec(fn) {
    try {
      await fn();
    } catch {}
    load();
  }

  // Poll while open so live-synced changes surface on their own.
  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  // Deep link from a notification: find the film's card, scroll to it, flash
  // it, and open its comment thread.
  useEffect(() => {
    if (!focus || !feed || handledFocus.current === focus.ts) return;
    const target = feed.find(
      (it) =>
        it.host_own_watch_id === focus.watchId ||
        it.your_watch_id === focus.watchId ||
        it.id === `me:${focus.watchId}`
    );
    if (!target) return;
    handledFocus.current = focus.ts;
    setSelected(null);
    if (target.kind === 'upcoming') setExpanded(target.id);
    setHighlight(target.id);
    setTimeout(() => {
      document
        .getElementById(`feed-item-${target.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    setTimeout(() => setHighlight(null), 3500);
  }, [focus, feed]);

  if (selected) {
    return (
      <FriendProfile
        friend={selected}
        onBack={() => {
          setSelected(null);
          load();
        }}
        onRemoved={() => {
          setSelected(null);
          load();
        }}
      />
    );
  }

  if (feed === null) {
    return <div className="friends-empty">Loading&hellip;</div>;
  }

  if (friends.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-glyph">◌</div>
        <div className="empty-headline">No friends yet.</div>
        <p className="empty-body">
          Connect another Marquee to see what the people you trust are watching.
        </p>
        <ol className="empty-steps">
          <li><b>Add a friend</b> — you&rsquo;ll get a secret URL made just for them.</li>
          <li><b>Swap URLs</b> — text yours over; paste the one they send back.</li>
          <li><b>That&rsquo;s it</b> — their films, reservations, and comments show up here.</li>
        </ol>
        <button type="button" className="feed-empty-add" onClick={onAddFriend}>
          + Add a friend
        </button>
      </div>
    );
  }

  const upcoming = feed
    .filter((it) => it.kind === 'upcoming')
    .sort((a, b) => new Date(a.showtime || 0) - new Date(b.showtime || 0));
  const past = feed.filter((it) => it.kind !== 'upcoming');

  function renderCard(it) {
    const who = it.people?.length ? peopleLabel(it.people) : it.friend_name;
    const watchingNow = it.kind === 'upcoming' && isShowingNow(it.showtime, it.runtime_minutes);
    const verb =
      it.kind === 'upcoming'
        ? watchingNow
          ? it.together ? 'are watching' : 'is watching'
          : it.together ? 'are seeing' : 'is seeing'
        : 'saw';
    const people = it.people || [];
    // An Unseen is worth calling out — the title alone doesn't say they went in
    // blind. Only on watched films; an upcoming one has nothing to reveal yet.
    const unseen = it.kind === 'watched'
      ? specialTag({ tags: it.tags, title: it.source_title })
      : null;
    const avatarName = people.length
      ? (people.find((p) => !p.you) || people[0] || {}).name
      : it.friend_name;
    return (
      <div
        id={`feed-item-${it.id}`}
        className={`feed-card ${it.kind === 'upcoming' ? 'up' : ''} ${highlight === it.id ? 'flash' : ''}`}
      >
        <button type="button" className="feed-main" onClick={() => openItem(it)}>
          {it.kind === 'watched' && <span className="feed-time">{fmtAgo(it.at)}</span>}
          <span className="feed-poster">
            {it.poster_url ? (
              <img src={it.poster_url} alt="" loading="lazy" />
            ) : (
              <span className="feed-poster-blank">
                {(it.title || '?').slice(0, 2).toUpperCase()}
              </span>
            )}
          </span>
          <span className="feed-body">
            <span className="feed-line1">
              <span className="feed-ava">{(avatarName || '?').slice(0, 1).toUpperCase()}</span>
              <span className="feed-who">{who}</span>
              {/* "saw" needs no "together" — naming the group already says it. */}
              <span className="feed-verb">
                {verb}
                {it.kind === 'upcoming' && it.together ? ' together' : ''}
              </span>
            </span>
            <span className="feed-title">{it.title}</span>
            {it.kind === 'upcoming' ? (
              watchingNow ? (
                <span className="feed-now">
                  <span className="feed-now-dot" aria-hidden="true" />
                  Watching now{it.theater_name ? ` · ${it.theater_name}` : ''}
                </span>
              ) : (
                <span className="feed-tix">
                  🎟 {fmtShowtime(it.showtime)}
                  {it.theater_name ? ` · ${it.theater_name}` : ''}
                </span>
              )
            ) : it.rating ? (
              <Stars value={it.rating} />
            ) : null}
            {it.kind !== 'upcoming' &&
              (unseen || it.director || it.release_year ? (
                <span className="feed-metarow">
                  {unseen && (
                    <span className={`feed-unseen ${/scream/i.test(unseen) ? 'scream' : ''}`}>
                      {unseen}
                    </span>
                  )}
                  <span className="feed-meta">
                    {[it.director, it.release_year].filter(Boolean).join(' · ')}
                  </span>
                </span>
              ) : null)}
          </span>
        </button>
        {((it.host_friend_id && it.host_remote_id) || it.host_own_watch_id) && (
          <SocialBar item={it} onChanged={load} defaultOpen={highlight === it.id} />
        )}
      </div>
    );
  }

  const expandedItem = expanded && upcoming.find((it) => it.id === expanded);

  let lastDay = null;
  return (
    <section className="feed">
      {err && <div className="error-banner">{err}</div>}

      {upcoming.length > 0 && (
        <div className="up-rail">
          <div className="up-rail-title">Coming up</div>
          <div className="up-strip">
            {upcoming.map((it) => {
              const watchingNow = isShowingNow(it.showtime, it.runtime_minutes);
              const on = expanded === it.id;
              const chip = fmtChip(it.showtime);
              return (
                <button
                  key={it.id}
                  type="button"
                  className={`up-card ${on ? 'is-on' : ''}`}
                  onClick={() => setExpanded(on ? null : it.id)}
                  aria-expanded={on}
                >
                  <span className="up-poster">
                    {it.poster_url ? (
                      <img src={it.poster_url} alt="" loading="lazy" />
                    ) : (
                      <span className="feed-poster-blank">
                        {(it.title || '?').slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    {watchingNow ? (
                      <span className="up-chip now">
                        <span className="feed-now-dot" aria-hidden="true" />Now
                      </span>
                    ) : chip?.label ? (
                      <span className="up-chip">{chip.label}</span>
                    ) : chip ? (
                      <span className="up-chip stack">
                        <span>{chip.date}</span>
                        <span>{chip.time}</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="up-title">{it.title}</span>
                  <span className="up-people">{peopleLabel(it.people)}</span>
                </button>
              );
            })}
          </div>
          {expandedItem && <div className="up-detail">{renderCard(expandedItem)}</div>}
        </div>
      )}

      {recs.length > 0 && (
        <div className="rec-strip">
          <div className="rec-strip-title">Recommended for you</div>
          {recs.map((r) => (
            <div key={r.id} className="rec-card">
              {r.poster_url ? (
                <img className="rec-poster" src={r.poster_url} alt="" loading="lazy" />
              ) : (
                <span className="rec-poster blank">{(r.title || '?').slice(0, 2).toUpperCase()}</span>
              )}
              <div className="rec-info">
                <div className="rec-from">{r.from_name} recommends</div>
                <div className="rec-title">{r.title}{r.release_year ? ` · ${r.release_year}` : ''}</div>
              </div>
              <div className="rec-actions">
                <button type="button" className="rec-add" onClick={() => actRec(() => api.addRecommendation(r.id))}>
                  + Watchlist
                </button>
                <button type="button" className="rec-dismiss" onClick={() => actRec(() => api.dismissRecommendation(r.id))} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {feed.length === 0 && (
        <div className="empty-state">
          <div className="empty-glyph">◌</div>
          <div className="empty-headline">Quiet so far.</div>
          <p className="empty-body">When your friends log a film, it&rsquo;ll show up here.</p>
        </div>
      )}

      {past.map((it) => {
        const label = dayLabel(it.at);
        const head = label !== lastDay ? ((lastDay = label), label) : null;
        return (
          <div key={it.id}>
            {head && <div className="feed-day">{head}</div>}
            {/* A screening several of you attended belongs to no one side, so it
                spans the full width instead of picking left or right. */}
            <div className={`msg ${it.together ? 'both' : it.you ? 'you' : 'them'}`}>
              {!it.together && !it.you && (
                <span className="msg-ava">{(it.friend_name || '?').slice(0, 1).toUpperCase()}</span>
              )}
              {renderCard(it)}
            </div>
          </div>
        );
      })}

      {picker && (
        <div className="fmenu-backdrop" onClick={() => setPicker(null)}>
          <div className="fmenu-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="fmenu-grab" />
            <div className="picker-title">Open a profile</div>
            {picker.map((f) => (
              <button
                key={f.friend_id}
                type="button"
                className="fmenu-row"
                onClick={() => {
                  setSelected({ id: f.friend_id, display_name: f.name });
                  setPicker(null);
                }}
              >
                <span className="fmenu-ico picker-ava">{(f.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="fmenu-text">
                  <span className="fmenu-t">{f.name}</span>
                </span>
                <span className="fmenu-chev">›</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
