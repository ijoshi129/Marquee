import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';
import UrlReveal from './UrlReveal';

// Friend list → per-friend detail sheet. The list stays scannable (name +
// status); everything you can do to a friend lives on their detail page.
export default function ManageFriendsModal({ onClose }) {
  const [friends, setFriends] = useState(null);
  const [err, setErr] = useState(null);
  const [detailId, setDetailId] = useState(null);

  function load() {
    api.friends().then(setFriends).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    load();
  }, []);

  function status(f) {
    if (!f.friend_url) return 'Waiting for their URL';
    if (f.last_error) return f.last_error;
    return `Synced ${fmtAgo(f.last_synced_at)}`;
  }

  const detail = detailId && (friends || []).find((f) => f.id === detailId);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        {detail ? (
          <FriendDetail
            friend={detail}
            status={status(detail)}
            onBack={() => {
              setDetailId(null);
              load();
            }}
            onChanged={load}
            onRemoved={() => {
              setDetailId(null);
              load();
            }}
          />
        ) : (
          <>
            <header className="friends-modal-head">
              <h2 className="friends-modal-title">Manage friends</h2>
              <p className="friends-modal-sub">Tap a friend for connection details and controls.</p>
            </header>

            {err && <div className="error-banner">{err}</div>}

            {friends === null ? (
              <div className="friends-empty">Loading&hellip;</div>
            ) : friends.length === 0 ? (
              <div className="friends-empty">No friends yet.</div>
            ) : (
              <ul className="mf-list">
                {friends.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="mf-row mf-rowbtn" onClick={() => setDetailId(f.id)}>
                      <span className="mf-ava">{(f.display_name || '?').slice(0, 1).toUpperCase()}</span>
                      <span className="mf-text">
                        <span className="mf-name">{f.display_name}</span>
                        <span className={`mf-sub ${!f.friend_url || f.last_error ? 'warn' : ''}`}>{status(f)}</span>
                      </span>
                      <span className="fmenu-chev">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FriendDetail({ friend, status, onBack, onChanged, onRemoved }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null); // 'test' | 'sync' | 'rotate' | 'save'
  const [tested, setTested] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(friend.friend_url || '');
  const [rotated, setRotated] = useState(null);

  async function run(kind, fn) {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    await run('test', async () => {
      const r = await api.testConnection(friend.id);
      setTested({
        ok: r.ok,
        message: r.ok ? `Connected${typeof r.ms === 'number' ? ` · ${r.ms}ms` : ''}` : r.message || 'Connection failed',
      });
    });
  }

  async function sync() {
    setTested(null);
    await run('sync', async () => {
      await api.syncFriend(friend.id);
      onChanged();
    });
  }

  async function saveUrl() {
    await run('save', async () => {
      await api.updateFriend(friend.id, { friend_url: draftUrl.trim() });
      setEditing(false);
      onChanged();
    });
  }

  async function rotate() {
    if (!confirm(`Rotate your URL for ${friend.display_name}? Their current URL stops working immediately — you'll need to send them the new one.`)) {
      return;
    }
    await run('rotate', async () => {
      const { my_url } = await api.rotateFriendUrl(friend.id);
      setRotated(my_url);
    });
  }

  async function remove() {
    if (!confirm(`Remove ${friend.display_name}? They will no longer see your activity, and you won't see theirs.`)) {
      return;
    }
    try {
      await api.removeFriend(friend.id);
      onRemoved();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <>
      <header className="friends-modal-head">
        <button type="button" className="mf-back" onClick={onBack}>‹ Friends</button>
        <h2 className="friends-modal-title">{friend.display_name}</h2>
        <p className={`friends-modal-sub ${!friend.friend_url || friend.last_error ? 'warn' : ''}`}>{status}</p>
      </header>

      {err && <div className="error-banner">{err}</div>}

      <div className="mf-actions">
        <button type="button" className="mf-btn" disabled={!!busy || !friend.friend_url} onClick={test}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" className="mf-btn" disabled={!!busy || !friend.friend_url} onClick={sync}>
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {tested && (
        <div className={`mf-test ${tested.ok ? 'ok' : 'bad'}`}>
          {tested.ok ? '✓ ' : '✕ '}{tested.message}
        </div>
      )}

      <div className="mf-section">
        <div className="mf-section-title">Their URL</div>
        {editing ? (
          <div className="mf-urlrow">
            <textarea
              className="friends-textarea"
              rows={2}
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://…/api/federation/…"
            />
            <div className="mf-actions">
              <button type="button" className="mf-btn" disabled={!!busy || !draftUrl.trim()} onClick={saveUrl}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="mf-btn" disabled={!!busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mf-urlline">
            <span className="mf-url">{friend.friend_url || 'Not set — ask them for theirs.'}</span>
            <button type="button" className="mf-btn" disabled={!!busy} onClick={() => { setDraftUrl(friend.friend_url || ''); setEditing(true); }}>
              {friend.friend_url ? 'Edit' : 'Add'}
            </button>
          </div>
        )}
      </div>

      <div className="mf-section">
        <div className="mf-section-title">Your URL for them</div>
        {rotated ? (
          <UrlReveal url={rotated} label={`Send this to ${friend.display_name} — shown only once.`} />
        ) : (
          <div className="mf-urlline">
            <span className="mf-url">Stored hashed — rotate to issue a fresh one.</span>
            <button type="button" className="mf-btn" disabled={!!busy} onClick={rotate}>
              {busy === 'rotate' ? 'Rotating…' : 'Rotate'}
            </button>
          </div>
        )}
      </div>

      <div className="mf-section">
        <button type="button" className="mf-remove" style={{ width: '100%' }} disabled={!!busy} onClick={remove}>
          Remove friend
        </button>
      </div>
    </>
  );
}
