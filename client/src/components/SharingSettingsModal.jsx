import { useEffect, useState } from 'react';
import { api } from '../api';

const TOGGLES = [
  { key: 'share_activity', label: 'Recent watches', hint: 'The films you log, with posters and dates.' },
  { key: 'share_ratings', label: 'Your ratings', hint: 'Star ratings on shared films.' },
  { key: 'share_now_playing', label: 'Upcoming', hint: 'Reservations you have booked.' },
  { key: 'share_stats', label: 'Year-in-review stats', hint: 'Counts, runtime, top genres and directors.' },
];

// What friends can see. A-List savings are never shared. Per-film exceptions
// live on each film (mark it private in its edit sheet).
export default function SharingSettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.federationSettings().then(setSettings).catch((e) => setErr(e.message));
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

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="friends-modal-head">
          <h2 className="friends-modal-title">What friends can see</h2>
          <p className="friends-modal-sub">
            Applies to everyone you&rsquo;re connected with. Mark an individual film private from its
            own sheet to keep it off entirely.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {!settings ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : (
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
        )}
      </div>
    </div>
  );
}

function Switch({ on, onClick, label }) {
  return (
    <button
      type="button"
      className={`fed-toggle ${on ? '' : 'off'}`}
      role="switch"
      aria-checked={on}
      onClick={onClick}
      aria-label={label}
    />
  );
}
