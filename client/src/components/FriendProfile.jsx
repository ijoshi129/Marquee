import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtRuntime } from '../format';
import WatchList from './WatchList';
import { fmtAgo } from './FriendsView';

// A friend's shared world: a light stats header (no A-List money) plus their
// recent watches rendered read-only with the same poster cards as the diary.
export default function FriendProfile({ friend, onBack, onRemoved }) {
  const [profile, setProfile] = useState(null);
  const [watches, setWatches] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const fetchAll = () => {
      Promise.all([api.friendProfile(friend.id), api.friendWatches(friend.id)])
        .then(([p, w]) => {
          if (!alive) return;
          setProfile(p);
          // The cached payloads key on remote_id; give them an `id` so the grid
          // (and its React keys) work unchanged.
          setWatches(w.map((x) => ({ ...x, id: x.remote_id })));
        })
        .catch((e) => alive && setErr(e.message));
    };
    fetchAll();
    // Poll while open so a friend's freshly-synced changes appear on their own.
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

  return (
    <section className="friend-profile">
      <div className="friend-profile-bar">
        <button type="button" className="friend-back" onClick={onBack}>
          ‹ Friends
        </button>
        <button type="button" className="friend-remove" onClick={remove}>
          Remove
        </button>
      </div>

      <header className="friend-profile-head">
        <div className="friend-avatar lg" aria-hidden="true">
          {(friend.display_name || '?').slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h2 className="friend-profile-name">{friend.display_name || 'Friend'}</h2>
          <div className="friend-profile-synced">
            {friend.last_error ? `Couldn't reach · synced ${fmtAgo(friend.last_synced_at)}` : `Synced ${fmtAgo(friend.last_synced_at)}`}
          </div>
        </div>
      </header>

      {err && <div className="error-banner">{err}</div>}

      {stats && (
        <div className="friend-stats">
          <div className="friend-stat">
            <div className="friend-stat-num">{stats.films ?? 0}</div>
            <div className="friend-stat-lbl">Films</div>
          </div>
          <div className="friend-stat">
            <div className="friend-stat-num">{fmtRuntime(stats.runtime_minutes || 0)}</div>
            <div className="friend-stat-lbl">Runtime</div>
          </div>
          {stats.average_rating != null && (
            <div className="friend-stat">
              <div className="friend-stat-num">{stats.average_rating}★</div>
              <div className="friend-stat-lbl">Mean</div>
            </div>
          )}
          {stats.genres?.[0] && (
            <div className="friend-stat">
              <div className="friend-stat-num">{stats.genres[0].name}</div>
              <div className="friend-stat-lbl">Top genre</div>
            </div>
          )}
        </div>
      )}

      <h3 className="friend-section-title">Recent watches</h3>
      <WatchList
        watches={watches}
        readOnly
        emptyBody={`Nothing shared yet${friend.last_error ? " — couldn't reach their instance." : '.'}`}
      />
    </section>
  );
}
