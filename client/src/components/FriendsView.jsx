import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { fmtShowtime, isShowingNow } from '../format';
import FriendProfile from './FriendProfile';
import SocialBar from './SocialBar';

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

// "You & Alice" / "Alice & Bob" / "You, Alice & Bob" — You first.
function peopleLabel(people) {
  const ns = [...people].sort((a, b) => (a.you ? -1 : b.you ? 1 : 0)).map((p) => p.name);
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

export default function FriendsView({ onAddFriend }) {
  const [feed, setFeed] = useState(null);
  const [friends, setFriends] = useState([]);
  const [recs, setRecs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [picker, setPicker] = useState(null);
  const [err, setErr] = useState(null);

  // Open a feed item: watched → that friend; upcoming with one friend → that
  // friend; upcoming with several → a "who's going" picker.
  function openItem(it) {
    if (it.kind === 'watched') {
      if (it.friend_id) setSelected({ id: it.friend_id, display_name: it.friend_name });
      return;
    }
    const fr = (it.people || []).filter((p) => !p.you && p.friend_id);
    if (fr.length === 1) setSelected({ id: fr[0].friend_id, display_name: fr[0].name });
    else if (fr.length > 1) setPicker(fr);
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
        <button type="button" className="feed-empty-add" onClick={onAddFriend}>
          + Add a friend
        </button>
      </div>
    );
  }

  const recStrip = recs.length > 0 && (
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
  );

  let lastDay = null;
  return (
    <section className="feed">
      {err && <div className="error-banner">{err}</div>}
      {recStrip}
      {feed.length === 0 && (
        <div className="empty-state">
          <div className="empty-glyph">◌</div>
          <div className="empty-headline">Quiet so far.</div>
          <p className="empty-body">When your friends log a film, it&rsquo;ll show up here.</p>
        </div>
      )}
      {feed.map((it) => {
        const label = dayLabel(it.at);
        const head = label !== lastDay ? ((lastDay = label), label) : null;
        const who = it.kind === 'upcoming' ? peopleLabel(it.people) : it.friend_name;
        const watchingNow = it.kind === 'upcoming' && isShowingNow(it.showtime, it.runtime_minutes);
        const verb =
          it.kind === 'upcoming'
            ? watchingNow
              ? it.together ? 'are watching' : 'is watching'
              : it.together ? 'are seeing' : 'is seeing'
            : it.rating ? 'rated' : 'logged';
        const avatarName =
          it.kind === 'upcoming'
            ? (it.people.find((p) => !p.you) || it.people[0]).name
            : it.friend_name;
        return (
          <div key={it.id}>
            {head && <div className="feed-day">{head}</div>}
            <div className={`feed-card ${it.kind === 'upcoming' ? 'up' : ''}`}>
            <button
              type="button"
              className="feed-main"
              onClick={() => openItem(it)}
            >
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
                  <span className="feed-verb">{verb}{it.together ? ' together' : ''}</span>
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
                ) : (
                  <span className="feed-meta">Not yet rated</span>
                )}
                {it.kind !== 'upcoming' && (it.director || it.release_year) && (
                  <span className="feed-meta">
                    {[it.director, it.release_year].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
            </button>
              {((it.host_friend_id && it.host_remote_id) || it.host_own_watch_id) && (
                <SocialBar item={it} onChanged={load} />
              )}
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
