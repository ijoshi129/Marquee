import { useState } from 'react';
import { api, setStoredPasscode } from '../api';

// Full-screen gate shown when the instance is passcode-locked and this device
// hasn't unlocked yet. Stores the passcode on success so it's a one-time step.
export default function Unlock({ onUnlocked }) {
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!passcode.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setStoredPasscode(passcode.trim());
      await api.unlock(passcode.trim());
      onUnlocked();
    } catch (e2) {
      setStoredPasscode(null);
      setErr(e2.message || 'Incorrect passcode');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="unlock-wordmark">
          <h1 className="wordmark-name">Marquee</h1>
          <span className="wordmark-tag">Cinema Diary</span>
        </div>
        <p className="unlock-sub">Enter your passcode to unlock this device.</p>
        <input
          className="unlock-input"
          type="password"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          autoComplete="current-password"
        />
        {err && <div className="unlock-err">{err}</div>}
        <button className="unlock-btn" type="submit" disabled={busy || !passcode.trim()}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
