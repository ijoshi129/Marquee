import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtRuntime } from '../format';
import WatchList from './WatchList';
import { fmtAgo } from './FriendsView';
import RecommendSheet from './RecommendSheet';
import CommonFilmsSheet from './CommonFilmsSheet';

// A friend's shared world: a light stats header (no A-List money) plus their
// recent watches rendered read-only with the same poster cards as the diary.
export default function FriendProfile({ friend, onBack, onRemoved }) {
  const [profile, setProfile] = useState(null);
  const [watches, setWatches] = useState([]);
  const [recommend, setRecommend] = useState(false);
  const [common, setCommon] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const fetchAll = () => {
      Promise.all([api.friendProfile(friend.id), api.friendWatches(friend.id)])
        .then(([p, w]) => {
          if (!alive) return;
          setProfile(p);
          // Cached payloads key on remote_id; give them an `id` for the grid keys.
          setWatches(w.map((x) => ({ ...x, id: x.remote_id })));
        })
        .catch((e) => alive && setErr(e.message));
    };
    fetchAll();
    const iv = setInterval(fetchAll, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [friend.id]);

  async function remove() {
    if (!confirm(`Remove ${friend.display_name || 'this friend'}? They will no longer see your activity, and you won't see theirs.`)) {
      return;
    }
    try {
      await api.removeFriend(friend.id);
      onRemoved?.();
    } catch (e) {
      setErr(e.message);
    }
  }

  const stats = profile?.stats;
  const synced = profile?.last_synced_at || friend.last_synced_at;
  const offline = profile?.last_error || friend.last_error;

  return (
    <section className="fp">
      <div className="fp-top">
        <button type="button" className="fp-back" onClick={onBack}>‹ Friends</button>
        <span className="fp-top-actions">
          <button type="button" className="fp-recommend" onClick={() => setRecommend(true)}>📨 Recommend</button>
          <button type="button" className="fp-remove" onClick={remove}>Remove</button>
        </span>
      </div>

      {recommend && <RecommendSheet friend={friend} onClose={() => setRecommend(false)} />}

      <header className="fp-head">
        <div className="fp-avatar" aria-hidden="true">
          {(friend.display_name || '?').slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h2 className="fp-name">{friend.display_name || 'Friend'}</h2>
          <div className="fp-sync">
            <span className={`fp-dot ${offline ? 'off' : ''}`} />
            {offline ? `Couldn't reach · synced ${fmtAgo(synced)}` : `Synced ${fmtAgo(synced)}`}
          </div>
        </div>
      </header>

      {err && <div className="error-banner">{err}</div>}

      {profile?.taste?.in_common > 0 && (
        <button type="button" className="fp-taste scored" onClick={() => setCommon(true)}>
          <span className="fp-taste-pct">
            {profile.taste.agreement_pct != null ? `${profile.taste.agreement_pct}%` : profile.taste.in_common}
          </span>
          <span className="fp-taste-text">
            {profile.taste.agreement_pct != null
              ? `You agree on ${profile.taste.agreement_pct}% of the ${profile.taste.rated_in_common} films you've both rated · ${profile.taste.in_common} in common`
              : `film${profile.taste.in_common > 1 ? 's' : ''} in common`}
          </span>
          <span className="fp-taste-chev">›</span>
        </button>
      )}

      {common && <CommonFilmsSheet friend={friend} onClose={() => setCommon(false)} />}

      {stats && (
        <div className="fp-stats">
          <div className="fp-stat"><b>{stats.films ?? 0}</b><span>Films</span></div>
          <div className="fp-stat"><b>{fmtRuntime(stats.runtime_minutes || 0)}</b><span>Runtime</span></div>
          {stats.average_rating != null && (
            <div className="fp-stat"><b>{stats.average_rating}★</b><span>Mean</span></div>
          )}
          {stats.genres?.[0] && (
            <div className="fp-stat"><b>{stats.genres[0].name}</b><span>Top genre</span></div>
          )}
        </div>
      )}

      <div className="fp-sec">Recent watches</div>
      <WatchList
        watches={watches}
        readOnly
        emptyBody={`Nothing shared yet${offline ? " — couldn't reach their instance." : '.'}`}
      />
    </section>
  );
}
