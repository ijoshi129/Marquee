import { useEffect, useState } from 'react';
import { api } from '../api';

const KIND_TOGGLES = [
  { key: 'notify_comment', label: 'Comments', hint: 'A friend comments on one of your films.' },
  { key: 'notify_recommend', label: 'Recommendations', hint: 'A friend sends a film your way.' },
  { key: 'notify_together', label: 'Seeing together', hint: 'You and a friend booked the same showing.' },
  { key: 'notify_booked', label: 'Friend bookings', hint: 'A friend books a showing you’re not part of.' },
];

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Everything notification-related in one sheet: this device's Web Push
// subscription, and the instance-wide ntfy channel with per-kind switches.
export default function NotificationSettingsModal({ onClose }) {
  // 'unknown' | 'unsupported' | 'off' | 'on' | 'busy'
  const [push, setPush] = useState('unknown');
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    api.ntfySettings().then(setSettings).catch((e) => setErr(e.message));
  }, []);

  // Push is only available on the installed PWA over HTTPS (so the service
  // worker is registered). Show why when it isn't.
  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        return setPush('unsupported');
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return setPush('unsupported');
      const sub = await reg.pushManager.getSubscription();
      setPush(sub ? 'on' : 'off');
    })().catch(() => setPush('unsupported'));
  }, []);

  async function enablePush() {
    setPush('busy');
    try {
      const { enabled, key } = await api.pushKey();
      if (!enabled || !key) throw new Error('Push not configured on the server');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permission denied');
      const reg = await navigator.serviceWorker.ready;
      // Replace any existing subscription so we never orphan a stale one on the
      // server (orphaned subs get silent pushes, which trips iOS's display budget).
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await api.unsubscribePush(existing.endpoint).catch(() => {});
        await existing.unsubscribe().catch(() => {});
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
      await api.subscribePush(sub.toJSON());
      setPush('on');
    } catch (e) {
      setPush('off');
      setErr(`Couldn't enable notifications: ${e.message}`);
    }
  }

  async function disablePush() {
    setPush('busy');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    } catch {}
    setPush('off');
  }

  function set(key, value) {
    setSettings((s) => ({ ...s, [key]: value }));
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
    setErr(null);
    try {
      setSettings(
        await api.setNtfySettings({
          server_url: (settings.server_url || '').trim(),
          topic: (settings.topic || '').trim(),
          token: (settings.token || '').trim(),
        })
      );
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
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
          <h2 className="friends-modal-title">Notification settings</h2>
          <p className="friends-modal-sub">
            How alerts reach you outside the app.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        <div className="mf-section-title">This device</div>
        <ul className="sharing-list">
          <li className="sharing-row">
            <div className="sharing-text">
              <div className="sharing-label">Push notifications</div>
              <div className="sharing-hint">
                {push === 'unsupported'
                  ? 'Needs the installed app (Add to Home Screen) over HTTPS.'
                  : 'Lock-screen alerts on this device.'}
              </div>
            </div>
            {push === 'on' || push === 'off' || push === 'busy' ? (
              <Switch
                on={push === 'on'}
                onClick={() => (push === 'on' ? disablePush() : push === 'off' ? enablePush() : null)}
                label="Push notifications"
              />
            ) : null}
          </li>
        </ul>

        <div className="mf-section-title" style={{ marginTop: 18 }}>ntfy</div>
        {!settings ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : (
          <>
            <ul className="sharing-list">
              <li className="sharing-row">
                <div className="sharing-text">
                  <div className="sharing-label">Send alerts via ntfy</div>
                  <div className="sharing-hint">Any device with the ntfy app subscribed to your topic.</div>
                </div>
                <Switch on={!!settings.enabled} onClick={() => toggle('enabled')} label="ntfy enabled" />
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

            <div className="mf-section-title" style={{ marginTop: 18 }}>What to send</div>
            <ul className="sharing-list">
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
