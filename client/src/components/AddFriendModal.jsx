import { useState } from 'react';
import { api } from '../api';

// Two ways to connect: generate an invite to hand a friend, or paste one they
// gave you. Either side can initiate; pairing is mutual once redeemed.
export default function AddFriendModal({ onClose, onChanged }) {
  const [mode, setMode] = useState('accept');
  const [invite, setInvite] = useState('');
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const { invite: code } = await api.inviteFriend();
      setGenerated(code);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(generated);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  async function connect() {
    if (!invite.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.acceptFriend(invite.trim());
      onChanged?.();
      onClose();
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
            Connect two Marquee instances to share what you&rsquo;re watching.
          </p>
        </header>

        <div className="friends-tabs">
          <button
            type="button"
            className={`friends-tab ${mode === 'accept' ? 'is-on' : ''}`}
            onClick={() => setMode('accept')}
          >
            I have an invite
          </button>
          <button
            type="button"
            className={`friends-tab ${mode === 'invite' ? 'is-on' : ''}`}
            onClick={() => setMode('invite')}
          >
            Invite someone
          </button>
        </div>

        {err && <div className="error-banner">{err}</div>}

        {mode === 'accept' ? (
          <div className="friends-form">
            <label className="friends-label">Paste the invite your friend sent you</label>
            <textarea
              className="friends-textarea"
              rows={4}
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="eyJiYXNlX3VybCI6…"
            />
            <button className="friends-primary" onClick={connect} disabled={busy || !invite.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        ) : (
          <div className="friends-form">
            {!generated ? (
              <button className="friends-primary" onClick={generate} disabled={busy}>
                {busy ? 'Generating…' : 'Generate invite'}
              </button>
            ) : (
              <>
                <label className="friends-label">
                  Send this to your friend. It expires in 15 minutes and works once.
                </label>
                <textarea className="friends-textarea" rows={4} readOnly value={generated} />
                <button className="friends-primary" onClick={copy}>
                  {copied ? 'Copied ✓' : 'Copy invite'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
