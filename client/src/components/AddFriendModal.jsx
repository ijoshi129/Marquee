import { useState } from 'react';
import { api } from '../api';
import UrlReveal from './UrlReveal';

// Connecting is a URL swap: adding a friend mints your secret URL for them
// (shown once — only its hash is kept), and you paste the one they send you.
// Either half can happen first; paste theirs later from Manage friends.
export default function AddFriendModal({ onClose, onChanged }) {
  const [name, setName] = useState('');
  const [theirUrl, setTheirUrl] = useState('');
  const [myUrl, setMyUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const body = { display_name: name.trim() };
      if (theirUrl.trim()) body.friend_url = theirUrl.trim();
      const created = await api.addFriend(body);
      setMyUrl(created.my_url);
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="friends-modal-head">
          <h2 className="friends-modal-title">Add a friend</h2>
          <p className="friends-modal-sub">
            Swap secret URLs to connect two Marquee instances.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {!myUrl ? (
          <div className="friends-form">
            <label className="friends-label">Friend&rsquo;s name</label>
            <input
              className="friends-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kiran"
              maxLength={120}
            />
            <label className="friends-label">Their URL for you (optional — paste it later if you don&rsquo;t have it yet)</label>
            <textarea
              className="friends-textarea"
              rows={3}
              value={theirUrl}
              onChange={(e) => setTheirUrl(e.target.value)}
              placeholder="https://…/api/federation/…"
            />
            <button className="friends-primary" onClick={add} disabled={busy || !name.trim()}>
              {busy ? 'Adding…' : 'Add friend'}
            </button>
          </div>
        ) : (
          <div className="friends-form">
            <UrlReveal
              url={myUrl}
              label={`Send this URL to ${name.trim()} — or let them scan it. It’s shown only once; if it’s lost, rotate it from Manage friends.`}
            />
            <button className="friends-secondary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
