import { useEffect, useState } from 'react';
import { api } from '../api';

const KIND_TOGGLES = [
  { key: 'notify_comment', label: 'Comments', hint: 'A friend comments on one of your films.' },
  { key: 'notify_recommend', label: 'Recommendations', hint: 'A friend sends a film your way.' },
  { key: 'notify_together', label: 'Seeing together', hint: 'You and a friend booked the same showing.' },
];

// Push notifications via ntfy — server, topic, and optional access token, plus
// per-kind switches. Saved server-side so every device honors the same setup.
export default function NtfySettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    api.ntfySettings().then(setSettings).catch((e) => setErr(e.message));
  }, []);

  function set(key, value) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  async function save(patch) {
    setErr(null);
    try {
      setSettings(await api.setNtfySettings(patch));
    } catch (e) {
      setErr(e.message);
    }
  }

  async function toggle(key) {
    const next = !settings[key];
    set(key, next);
    try {
      await api.setNtfySettings({ [key]: next });
    } catch (e) {
      setErr(e.message);
      set(key, !next);
    }
  }

  async function saveServer() {
    setBusy(true);
    await save({
      server_url: (settings.server_url || '').trim(),
      topic: (settings.topic || '').trim(),
      token: (settings.token || '').trim(),
    });
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setTestResult(null);
    try {
      await api.testNtfy({
        server_url: (settings.server_url || '').trim(),
        topic: (settings.topic || '').trim(),
        token: (settings.token || '').trim(),
      });
      setTestResult({ ok: true, message: 'Sent — check your phone' });
    } catch (e) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>

        <header className="friends-modal-head">
          <h2 className="friends-modal-title">ntfy alerts</h2>
          <p className="friends-modal-sub">
            Send notifications to any device with the ntfy app, through ntfy.sh or your own server.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {!settings ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : (
          <>
            <ul className="sharing-list">
              <li className="sharing-row">
                <div className="sharing-text">
                  <div className="sharing-label">Enabled</div>
                  <div className="sharing-hint">Master switch for all ntfy alerts.</div>
                </div>
                <Switch on={!!settings.enabled} onClick={() => toggle('enabled')} label="Enabled" />
              </li>
            </ul>

            <div className="friends-form" style={{ marginTop: 12 }}>
              <label className="friends-label">Server</label>
              <input
                className="friends-input"
                type="url"
                value={settings.server_url || ''}
                onChange={(e) => set('server_url', e.target.value)}
                placeholder="https://ntfy.sh"
              />
              <label className="friends-label">Topic</label>
              <input
                className="friends-input"
                type="text"
                value={settings.topic || ''}
                onChange={(e) => set('topic', e.target.value)}
                placeholder="marquee-yourname-x7k2"
              />
              <label className="friends-label">Access token (only if your server needs one)</label>
              <input
                className="friends-input"
                type="password"
                value={settings.token || ''}
                onChange={(e) => set('token', e.target.value)}
                placeholder="tk_…"
              />
              <div className="ntfy-actions">
                <button className="friends-primary" onClick={saveServer} disabled={busy}>
                  Save
                </button>
                <button className="friends-secondary" onClick={test} disabled={busy || !(settings.topic || '').trim()}>
                  Send test
                </button>
              </div>
              {testResult && (
                <div className={`mf-test ${testResult.ok ? 'ok' : 'bad'}`} style={{ paddingLeft: 0 }}>
                  {testResult.ok ? '✓ ' : '✕ '}{testResult.message}
                </div>
              )}
            </div>

            <ul className="sharing-list" style={{ marginTop: 8 }}>
              {KIND_TOGGLES.map((t) => (
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
