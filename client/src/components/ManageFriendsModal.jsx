import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

// All connected instances with their sync state, and a way to remove one —
// the reach-everyone counterpart to the feed (which only shows active friends).
export default function ManageFriendsModal({ onClose }) {
  const [friends, setFriends] = useState(null);
  const [err, setErr] = useState(null);

  function load() {
    api.friends().then(setFriends).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    load();
  }, []);

  async function remove(f) {
    if (!confirm(`Remove ${f.display_name || 'this friend'}? They will no longer see your activity, and you won't see theirs.`)) {
      return;
    }
    try {
      await api.removeFriend(f.id);
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  function status(f) {
    if (f.status === 'revoked') return 'Disconnected';
    if (f.last_error) return `Couldn't reach · ${fmtAgo(f.last_synced_at)}`;
    return `Synced ${fmtAgo(f.last_synced_at)}`;
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <header className="friends-modal-head">
          <h2 className="friends-modal-title">Manage friends</h2>
          <p className="friends-modal-sub">Removing a friend stops sharing in both directions.</p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {friends === null ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : friends.length === 0 ? (
          <div className="friends-empty">No friends yet.</div>
        ) : (
          <ul className="mf-list">
            {friends.map((f) => (
              <li key={f.id} className="mf-row">
                <span className="mf-ava">{(f.display_name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="mf-text">
                  <span className="mf-name">{f.display_name || 'Pending…'}</span>
                  <span className="mf-sub">{status(f)}</span>
                </span>
                <button type="button" className="mf-remove" onClick={() => remove(f)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
