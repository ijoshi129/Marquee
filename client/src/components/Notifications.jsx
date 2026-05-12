import { useEffect, useState } from 'react';
import { api } from '../api';
import { specialTag } from './WatchList';

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Four flavors of notification:
//   - 'identify': Screen/Scream Unseen the auto-resolver couldn't figure out
//   - 'confirm':  AMC-email watch auto-marked past showtime with no thank-you
//                 email after 4 days — did you go, no-show, or cancel?
//   - 'no_show' / 'cancelled':  reservation flipped, "were you there?"
function notifKind(w) {
  if (w.status === 'no_show') return 'no_show';
  if (w.status === 'cancelled') return 'cancelled';
  if (specialTag(w) && !w.tmdb_id) return 'identify';
  if (w.status === 'watched' && !w.thankyou_email_id) return 'confirm';
  if (w.status === 'pending') return 'confirm'; // defensive — shouldn't appear under the new lifecycle
  return 'other';
}

const PILL_LABEL = {
  no_show: 'No-show',
  cancelled: 'Cancelled',
  identify: 'Identify',
  confirm: 'Did you go?',
};

export default function Notifications({ refreshKey, onWatchUpdated, onSelectWatch }) {
  const [items, setItems] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    api
      .notifications()
      .then(setItems)
      .catch((err) => console.error('notifications fetch failed:', err));
  }, [refreshKey]);

  if (!items.length) return null;

  function removeFromList(id) {
    setItems((rows) => rows.filter((r) => r.id !== id));
  }

  async function markWatched(w) {
    setBusyId(w.id);
    try {
      const updated = await api.updateWatch(w.id, { status: 'watched' });
      onWatchUpdated?.(updated);
      removeFromList(w.id);
    } catch (err) {
      console.error('mark watched:', err);
    } finally {
      setBusyId(null);
    }
  }

  async function markMissed(w) {
    setBusyId(w.id);
    try {
      const updated = await api.updateWatch(w.id, { status: 'no_show' });
      onWatchUpdated?.(updated);
      removeFromList(w.id);
    } catch (err) {
      console.error('mark missed:', err);
    } finally {
      setBusyId(null);
    }
  }

  async function markCancelled(w) {
    setBusyId(w.id);
    try {
      const updated = await api.updateWatch(w.id, { status: 'cancelled' });
      onWatchUpdated?.(updated);
      removeFromList(w.id);
    } catch (err) {
      console.error('mark cancelled:', err);
    } finally {
      setBusyId(null);
    }
  }

  function identify(w) {
    onSelectWatch?.(w);
    removeFromList(w.id);
  }

  async function dismiss(w) {
    setBusyId(w.id);
    try {
      await api.updateWatch(w.id, { acknowledged: true });
      removeFromList(w.id);
    } catch (err) {
      console.error('dismiss:', err);
    } finally {
      setBusyId(null);
    }
  }

  async function dismissAll() {
    setBusyId('all');
    try {
      await Promise.all(
        items.map((w) => api.updateWatch(w.id, { acknowledged: true }))
      );
      setItems([]);
    } catch (err) {
      console.error('dismiss all:', err);
    } finally {
      setBusyId(null);
    }
  }

  // Headline tailored to which kinds of notifications are pending.
  const kinds = items.map(notifKind);
  const hasIdentify = kinds.includes('identify');
  const hasConfirm = kinds.includes('confirm');
  const hasFlipped = kinds.includes('no_show') || kinds.includes('cancelled');
  const flavors = [hasIdentify, hasConfirm, hasFlipped].filter(Boolean).length;
  const headline =
    flavors > 1
      ? `${items.length} item${items.length === 1 ? '' : 's'} need your attention`
      : hasIdentify
      ? `${items.length} Screen Unseen${items.length === 1 ? '' : 's'} — what did you actually see?`
      : hasConfirm
      ? `${items.length} watch${items.length === 1 ? '' : 'es'} unconfirmed — did you actually go?`
      : `${items.length} reservation${items.length === 1 ? '' : 's'} flipped — were you actually there?`;

  return (
    <aside className="notif-panel" role="complementary">
      <div className="notif-head">
        <span className="notif-eyebrow">Marquee Bulletin</span>
        <span className="notif-title">{headline}</span>
        <button
          type="button"
          className="link-quiet"
          onClick={dismissAll}
          disabled={busyId === 'all'}
        >
          Dismiss all
        </button>
      </div>
      <ul className="notif-list">
        {items.map((w) => {
          const kind = notifKind(w);
          return (
            <li key={w.id} className="notif-row">
              <span className={`notif-pill ${kind}`}>
                {PILL_LABEL[kind] || kind}
              </span>
              <div className="notif-text">
                <span className="notif-name">{w.tmdb?.title || w.title}</span>
                <span className="notif-meta">
                  {fmtDate(w.showtime || w.watched_at)}
                  {w.theater_name ? ` · ${w.theater_name}` : ''}
                </span>
              </div>
              <div className="notif-actions">
                {kind === 'identify' ? (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => identify(w)}
                    disabled={busyId === w.id}
                  >
                    Identify →
                  </button>
                ) : kind === 'confirm' ? (
                  <>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => markWatched(w)}
                      disabled={busyId === w.id}
                    >
                      I went
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => markMissed(w)}
                      disabled={busyId === w.id}
                    >
                      No-show
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => markCancelled(w)}
                      disabled={busyId === w.id}
                    >
                      I cancelled it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => markWatched(w)}
                    disabled={busyId === w.id}
                  >
                    I went →
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-btn icon"
                  onClick={() => dismiss(w)}
                  disabled={busyId === w.id}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
