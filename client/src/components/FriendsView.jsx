import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import AddFriendModal from './AddFriendModal';
import SharingSettingsModal from './SharingSettingsModal';
import FriendProfile from './FriendProfile';

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

export default function FriendsView() {
  const [friends, setFriends] = useState(null);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setFriends(await api.friends());
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  // Refresh the list periodically so synced changes appear without a reload.
  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    try {
      await api.syncFriends();
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSyncing(false);
    }
  }

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

  return (
    <section className="friends-view">
      <div className="friends-head">
        <div>
          <h2 className="friends-title">Friends</h2>
          <p className="friends-sub">See what the people you trust are watching.</p>
        </div>
        <div className="friends-actions">
          <button type="button" className="friends-ghost" onClick={() => setSettingsOpen(true)}>
            Sharing
          </button>
          <button type="button" className="friends-add" onClick={() => setAdding(true)}>
            + Add friend
          </button>
        </div>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {friends === null ? (
        <div className="friends-empty">Loading&hellip;</div>
      ) : friends.length === 0 ? (
        <div className="empty-state">
          <div className="empty-glyph">◌</div>
          <div className="empty-headline">No friends yet.</div>
          <p className="empty-body">
            Add a friend running their own Marquee to start sharing what you watch.
          </p>
        </div>
      ) : (
        <>
          <ul className="friend-list">
            {friends.map((f) => (
              <li key={f.id}>
                <button type="button" className="friend-row" onClick={() => setSelected(f)}>
                  <span className="friend-avatar" aria-hidden="true">
                    {(f.display_name || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="friend-row-text">
                    <span className="friend-row-name">{f.display_name || 'Pending…'}</span>
                    <span className="friend-row-meta">
                      {f.status === 'revoked'
                        ? 'Disconnected'
                        : f.last_error
                          ? `Couldn't reach · ${fmtAgo(f.last_synced_at)}`
                          : `Synced ${fmtAgo(f.last_synced_at)}`}
                    </span>
                  </span>
                  <span className="friend-row-chevron" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="friends-sync" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </>
      )}

      {adding && (
        <AddFriendModal
          onClose={() => setAdding(false)}
          onChanged={() => {
            load();
            syncNow();
          }}
        />
      )}
      {settingsOpen && <SharingSettingsModal onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
