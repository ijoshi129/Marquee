import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

const ICON = { together: '🍿', friend_added: '👋', comment: '💬', recommend: '📨' };

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Global header bell: unread badge, a panel of recent notifications, and the
// per-device push toggle.
export default function NotificationsBell({ onOpen }) {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  // 'unknown' | 'unsupported' | 'off' | 'on' | 'busy'
  const [push, setPush] = useState('unknown');

  const load = useCallback(() => {
    api.alerts().then(setData).catch(() => {});
  }, []);

  // Poll briskly while the panel is open; back off to a slow heartbeat when it's
  // closed (just enough to keep the unread badge current) so we're not hitting
  // the server every 5s in the background all day.
  useEffect(() => {
    load();
    const id = setInterval(load, open ? 5000 : 30000);
    return () => clearInterval(id);
  }, [load, open]);

  // Refresh immediately when the app returns to the foreground so the badge is
  // current the instant you reopen it (a push received while closed shows up
  // right away rather than waiting for the next poll tick).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  // Push is only available on the installed PWA over HTTPS (so the service
  // worker is registered). Hide the toggle otherwise.
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
      alert(`Couldn't enable notifications: ${e.message}`);
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

  async function act(fn) {
    try {
      await fn();
    } catch {}
    load();
  }

  return (
    <>
      <button type="button" className="hdr-icon" onClick={() => setOpen(true)} aria-label="Notifications">
        <BellIcon />
        {data.unread > 0 && <span className="hdr-badge">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>

      {open &&
        createPortal(
          <div className="fmenu-backdrop" onClick={() => setOpen(false)}>
            <div className="fmenu-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <div className="fmenu-grab" />
              <div className="notif-head">
                <span className="picker-title" style={{ margin: 0 }}>Notifications</span>
                <span className="notif-head-actions">
                  {data.unread > 0 && (
                    <button type="button" className="notif-action" onClick={() => act(api.markAlertsRead)}>
                      Mark all read
                    </button>
                  )}
                  {data.items.length > 0 && (
                    <button type="button" className="notif-action danger" onClick={() => act(api.clearAlerts)}>
                      Clear all
                    </button>
                  )}
                </span>
              </div>
              {push === 'off' && (
                <button type="button" className="push-toggle" onClick={enablePush}>
                  <span>🔔 Enable notifications on this device</span>
                </button>
              )}
              {push === 'on' && (
                <button type="button" className="push-toggle on" onClick={disablePush}>
                  <span>Notifications on for this device ✓</span>
                  <span className="push-off">Turn off</span>
                </button>
              )}
              {data.items.length === 0 ? (
                <div className="friends-empty">Nothing yet.</div>
              ) : (
                data.items.map((n) => (
                  <div key={n.id} className={`notif-item ${n.read_at ? '' : 'unread'}`}>
                    <button
                      type="button"
                      className="notif-main"
                      onClick={() => {
                        act(() => api.markAlertRead(n.id));
                        setOpen(false);
                        onOpen?.(n);
                      }}
                    >
                      <span className="notif-ico">{ICON[n.kind] || '•'}</span>
                      <span className="notif-text">
                        <span className="notif-title">{n.title}</span>
                        {n.body && <span className="notif-sub">{n.body}</span>}
                        <span className="notif-time">{fmtAgo(n.created_at)}</span>
                      </span>
                      {!n.read_at && <span className="notif-dot" aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="notif-x"
                      aria-label="Dismiss"
                      onClick={() => act(() => api.deleteAlert(n.id))}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
