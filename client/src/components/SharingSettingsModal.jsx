import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Switch from './Switch';

const TOGGLES = [
  { key: 'share_activity', label: 'Recent watches', hint: 'The films you log, with posters and dates.' },
  { key: 'share_ratings', label: 'Your ratings', hint: 'Star ratings on shared films.' },
  { key: 'share_now_playing', label: 'Upcoming', hint: 'Reservations you have booked.' },
  { key: 'share_stats', label: 'Year-in-review stats', hint: 'Counts, runtime, top genres and directors.' },
];

// Your name as friends see it, plus what they can see. A-List savings are never
// shared. Per-film exceptions live on each film (mark it private in its edit sheet).
export default function SharingSettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    api.federationSettings().then(setSettings).catch((e) => setErr(e.message));
    api
      .federationIdentity()
      .then((row) => {
        setIdentity(row);
        setName(row?.display_name || '');
      })
      .catch((e) => setErr(e.message));
    return () => clearTimeout(savedTimer.current);
  }, []);

  async function toggle(key) {
    const next = !settings[key];
    setSettings((s) => ({ ...s, [key]: next }));
    try {
      await api.setFederationSettings({ [key]: next });
    } catch (e) {
      setErr(e.message);
      setSettings((s) => ({ ...s, [key]: !next }));
    }
  }

  async function commitName() {
    const next = name.trim();
    if (!next) return setName(identity?.display_name || '');
    if (next === identity?.display_name) return;
    try {
      const row = await api.setFederationIdentity(next);
      setIdentity(row);
      setName(row.display_name);
      setErr(null);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="friends-modal-head">
          <h2 className="friends-modal-title">Sharing</h2>
          <p className="friends-modal-sub">
            Applies to everyone you&rsquo;re connected with. Mark an individual film private from its
            own sheet to keep it off entirely.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {identity && (
          <>
            <p className="sharing-sec">How you appear</p>
            <div className="sharing-identity">
              <div className="sharing-identity-row">
                <div className="sharing-avatar" aria-hidden="true">
                  {(name.trim()[0] || '?').toUpperCase()}
                </div>
                <input
                  className="sharing-name"
                  value={name}
                  maxLength={120}
                  aria-label="Instance name"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </div>
              <p className={`sharing-hint${saved ? ' is-saved' : ''}`}>
                {saved ? 'Saved' : 'Friends see this name on everything you share.'}
              </p>
            </div>
            <div className="sharing-divider" />
          </>
        )}

        {!settings ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : (
          <>
            <p className="sharing-sec">What friends can see</p>
            <ul className="sharing-list">
              {TOGGLES.map((t) => (
                <li key={t.key} className="sharing-row">
                  <div className="sharing-text">
                    <div className="sharing-label">{t.label}</div>
                    <div className="sharing-hint">{t.hint}</div>
                  </div>
                  <Switch on={!!settings[t.key]} onClick={() => toggle(t.key)} label={t.label} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
