import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

// All friends with their sync state, plus per-friend Test / Sync / Edit URL /
// Rotate / Remove. A friend is healthy unless last_error says otherwise; a row
// with no saved URL is one you can't pull from yet.
export default function ManageFriendsModal({ onClose }) {
  const [friends, setFriends] = useState(null);
  const [err, setErr] = useState(null);
  // id -> 'sync' | 'test' | 'rotate' | 'save' while that action is running
  const [busy, setBusy] = useState({});
  // id -> { ok, message } result of the last connection test
  const [tested, setTested] = useState({});
  // id currently showing the URL editor, and its draft value
  const [editing, setEditing] = useState(null);
  const [draftUrl, setDraftUrl] = useState('');
  // id -> freshly rotated URL (shown once)
  const [rotated, setRotated] = useState({});
  const [copied, setCopied] = useState(null);

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

  async function rotate(f) {
    if (!confirm(`Rotate your URL for ${f.display_name || 'this friend'}? Their current URL stops working immediately — you'll need to send them the new one.`)) {
      return;
    }
    setBusy((b) => ({ ...b, [f.id]: 'rotate' }));
    try {
      const { my_url } = await api.rotateFriendUrl(f.id);
      setRotated((r) => ({ ...r, [f.id]: my_url }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((b) => ({ ...b, [f.id]: undefined }));
    }
  }

  function startEdit(f) {
    setEditing(f.id);
    setDraftUrl(f.friend_url || '');
  }

  async function saveUrl(f) {
    setBusy((b) => ({ ...b, [f.id]: 'save' }));
    setErr(null);
    try {
      await api.updateFriend(f.id, { friend_url: draftUrl.trim() });
      setEditing(null);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((b) => ({ ...b, [f.id]: undefined }));
    }
  }

  async function copyRotated(f) {
    try {
      await navigator.clipboard.writeText(rotated[f.id]);
      setCopied(f.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  }

  function status(f) {
    if (!f.friend_url) return 'Waiting for their URL';
    if (f.last_error) return f.last_error;
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
                      <span className="mf-name">{f.display_name}</span>
                      <span className="mf-sub">{status(f)}</span>
                    </span>
                  </div>
                  <div className="mf-actions">
                    <button type="button" className="mf-btn" disabled={!!b || !f.friend_url} onClick={() => test(f)}>
                      {b === 'test' ? 'Testing…' : 'Test'}
                    </button>
                    <button type="button" className="mf-btn" disabled={!!b || !f.friend_url} onClick={() => sync(f)}>
                      {b === 'sync' ? 'Syncing…' : 'Sync'}
                    </button>
                    <button type="button" className="mf-btn" disabled={!!b} onClick={() => (editing === f.id ? setEditing(null) : startEdit(f))}>
                      {f.friend_url ? 'Edit URL' : 'Add URL'}
                    </button>
                  </div>
                  <div className="mf-actions">
                    <button type="button" className="mf-btn" disabled={!!b} onClick={() => rotate(f)}>
                      {b === 'rotate' ? 'Rotating…' : 'Rotate my URL'}
                    </button>
                    <button type="button" className="mf-remove" disabled={!!b} onClick={() => remove(f)}>
                      Remove
                    </button>
                  </div>
                  {editing === f.id && (
                    <div className="mf-urlrow">
                      <textarea
                        className="friends-textarea"
                        rows={2}
                        value={draftUrl}
                        onChange={(e) => setDraftUrl(e.target.value)}
                        placeholder="https://…/api/federation/…"
                      />
                      <div className="mf-actions" style={{ paddingLeft: 0 }}>
                        <button type="button" className="mf-btn" disabled={!!b || !draftUrl.trim()} onClick={() => saveUrl(f)}>
                          {b === 'save' ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="mf-btn" disabled={!!b} onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {rotated[f.id] && (
                    <div className="mf-urlrow">
                      <span className="friends-label">
                        New URL for {f.display_name} — send it to them. Shown only once.
                      </span>
                      <textarea className="friends-textarea" rows={2} readOnly value={rotated[f.id]} />
                      <button type="button" className="mf-btn" onClick={() => copyRotated(f)}>
                        {copied === f.id ? 'Copied ✓' : 'Copy URL'}
                      </button>
                    </div>
                  )}
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
