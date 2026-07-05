import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fmtAgo } from './FriendsView';
import NotificationSettingsModal from './NotificationSettingsModal';

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

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </svg>
  );
}

const ICON = { together: '🍿', friend_added: '👋', comment: '💬', recommend: '📨', booked: '🎟️' };

// Global header bell: unread badge and a panel of recent notifications. Push
// and ntfy configuration live behind the gear.
export default function NotificationsBell({ onOpen }) {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
                  <button
                    type="button"
                    className="notif-gear"
                    aria-label="Notification settings"
                    onClick={() => {
                      setOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    <GearIcon />
                  </button>
                </span>
              </div>
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

      {settingsOpen && createPortal(<NotificationSettingsModal onClose={() => setSettingsOpen(false)} />, document.body)}
    </>
  );
}
