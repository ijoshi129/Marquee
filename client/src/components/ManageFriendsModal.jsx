import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

// All connected instances with their sync state, plus per-friend Test / Sync /
// Remove — the reach-everyone counterpart to the feed (which only shows active
// friends).
export default function ManageFriendsModal({ onClose }) {
  const [friends, setFriends] = useState(null);
  const [err, setErr] = useState(null);
  // id -> 'sync' | 'test' while that action is running
  const [busy, setBusy] = useState({});
  // id -> { ok, message } result of the last connection test
  const [tested, setTested] = useState({});

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

  async function sync(f) {
    setBusy((b) => ({ ...b, [f.id]: 'sync' }));
    setTested((t) => ({ ...t, [f.id]: undefined }));
    try {
      await api.syncFriend(f.id);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((b) => ({ ...b, [f.id]: undefined }));
    }
  }

  async function test(f) {
    setBusy((b) => ({ ...b, [f.id]: 'test' }));
    try {
      const r = await api.testConnection(f.id);
      const message = r.ok
        ? `Connected${typeof r.ms === 'number' ? ` · ${r.ms}ms` : ''}`
        : r.message || 'Connection failed';
      setTested((t) => ({ ...t, [f.id]: { ok: r.ok, message } }));
    } catch (e) {
      setTested((t) => ({ ...t, [f.id]: { ok: false, message: e.message } }));
    } finally {
      setBusy((b) => ({ ...b, [f.id]: undefined }));
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
            {friends.map((f) => {
              const b = busy[f.id];
              const t = tested[f.id];
              return (
                <li key={f.id} className="mf-row">
                  <div className="mf-main">
                    <span className="mf-ava">{(f.display_name || '?').slice(0, 1).toUpperCase()}</span>
                    <span className="mf-text">
                      <span className="mf-name">{f.display_name || 'Pending…'}</span>
                      <span className="mf-sub">{status(f)}</span>
                    </span>
                  </div>
                  <div className="mf-actions">
                    <button type="button" className="mf-btn" disabled={!!b} onClick={() => test(f)}>
                      {b === 'test' ? 'Testing…' : 'Test'}
                    </button>
                    <button type="button" className="mf-btn" disabled={!!b} onClick={() => sync(f)}>
                      {b === 'sync' ? 'Syncing…' : 'Sync'}
                    </button>
                    <button type="button" className="mf-remove" disabled={!!b} onClick={() => remove(f)}>
                      Remove
                    </button>
                  </div>
                  {t && (
                    <div className={`mf-test ${t.ok ? 'ok' : 'bad'}`}>
                      {t.ok ? '✓ ' : '✕ '}{t.message}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
