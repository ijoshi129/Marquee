import { useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

// Inline, collapsible comment thread under a feed card. Comments come from the
// (live-polling) feed item; posting pushes to the owner instance and the thread
// refreshes on the next sync.
export default function SocialBar({ item, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const comments = item.comments || [];
  const n = comments.length;

  async function post(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // Route to the thread's canonical host: a friend's copy, or your own film.
      if (item.host_own_watch_id) {
        await api.commentOnOwnWatch(item.host_own_watch_id, body);
      } else {
        await api.commentOnWatch(item.host_friend_id, item.host_remote_id, body);
      }
      setText('');
      setTimeout(() => onChanged?.(), 1500);
    } catch {
      // Keep the typed text so the user can retry; just flag that it didn't send.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="social-bar" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="social-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        💬 {n > 0 ? `${n} comment${n > 1 ? 's' : ''}` : 'Comment'}
        {n > 0 && <span className="social-caret">{open ? '▴' : '▾'}</span>}
      </button>

      {open && (
        <div className="cmt-inline">
          {comments.map((c, i) => (
            <div key={c.id || `${c.at}-${i}`} className="cmt">
              <span className="cmt-ava">{(c.name || '?').slice(0, 1).toUpperCase()}</span>
              <span className="cmt-body">
                <span className="cmt-name">{c.name}</span>
                <span className="cmt-text">{c.body}</span>
                <span className="cmt-time">{fmtAgo(c.at)}</span>
              </span>
            </div>
          ))}
          <form className="cmt-form" onSubmit={post}>
            <input
              className="cmt-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add a comment…"
              maxLength={1000}
            />
            <button type="submit" className="cmt-send" disabled={busy || !text.trim()}>
              {busy ? '…' : 'Post'}
            </button>
          </form>
          {failed && <div className="cmt-error">Couldn’t post — try again.</div>}
        </div>
      )}
    </div>
  );
}
