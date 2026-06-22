import { useEffect, useState } from 'react';
import { api } from '../api';
import { specialTag } from './WatchList';
import { watchDisplayTitle, unseenRevealed } from '../format';

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
  if (specialTag(w) && !w.tmdb_id && unseenRevealed(w.showtime)) return 'identify';
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

const UNDO_TIMEOUT_MS = 8000;

export default function Notifications({ refreshKey, onWatchUpdated, onSelectWatch }) {
  const [items, setItems] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [undo, setUndo] = useState(null); // { watch, prev, label, timer }

  useEffect(() => {
    api
      .notifications()
      .then(setItems)
      .catch((err) => console.error('notifications fetch failed:', err));
  }, [refreshKey]);

  useEffect(() => () => {
    if (undo?.timer) clearTimeout(undo.timer);
  }, [undo]);

  if (!items.length && !undo) return null;

  function removeFromList(id) {
    setItems((rows) => rows.filter((r) => r.id !== id));
  }

  function scheduleUndo(watch, prev, label) {
    setUndo((current) => {
      if (current?.timer) clearTimeout(current.timer);
      const timer = setTimeout(() => setUndo(null), UNDO_TIMEOUT_MS);
      return { watch, prev, label, timer };
    });
  }

  async function runAction(w, patch, label) {
    setBusyId(w.id);
    const prev = {
      status: w.status,
      acknowledged: w.acknowledged ?? false,
      watched_at: w.watched_at ?? null,
    };
    try {
      const updated = await api.updateWatch(w.id, patch);
      onWatchUpdated?.(updated);
      removeFromList(w.id);
      scheduleUndo(w, prev, label);
    } catch (err) {
      console.error(label, err);
    } finally {
      setBusyId(null);
    }
  }

  const markWatched = (w) => runAction(w, { status: 'watched' }, 'mark watched');
  const markMissed = (w) => runAction(w, { status: 'no_show' }, 'mark missed');
  const markCancelled = (w) => runAction(w, { status: 'cancelled' }, 'mark cancelled');
  const dismiss = (w) => runAction(w, { acknowledged: true }, 'dismiss');

  function identify(w) {
    onSelectWatch?.(w);
    removeFromList(w.id);
  }

  async function runUndo() {
    if (!undo) return;
    const { watch, prev, timer } = undo;
    if (timer) clearTimeout(timer);
    setUndo(null);
    setBusyId(watch.id);
    try {
      const updated = await api.updateWatch(watch.id, {
        status: prev.status,
        acknowledged: prev.acknowledged,
        watched_at: prev.watched_at,
      });
      onWatchUpdated?.(updated);
      setItems((rows) =>
        rows.some((r) => r.id === updated.id) ? rows : [updated, ...rows]
      );
    } catch (err) {
      console.error('undo:', err);
    } finally {
      setBusyId(null);
    }
  }

  async function dismissAll() {
    setBusyId('all');
    try {
      // allSettled so one failed update doesn't strand the rows that did
      // succeed — clear those, keep any that failed so they can be retried.
      const results = await Promise.allSettled(
        items.map((w) => api.updateWatch(w.id, { acknowledged: true }))
      );
      const failedIds = new Set(
        items.filter((_, i) => results[i].status === 'rejected').map((w) => w.id)
      );
      setItems((prev) => prev.filter((w) => failedIds.has(w.id)));
      if (failedIds.size) console.error(`dismiss all: ${failedIds.size} failed`);
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

  const undoSnack = undo && (
    <div className="notif-undo" role="status">
      <span className="notif-undo-text">
        “{watchDisplayTitle(undo.watch)}” updated.
      </span>
      <button
        type="button"
        className="link-quiet"
        onClick={runUndo}
        disabled={busyId === undo.watch.id}
      >
        Undo
      </button>
    </div>
  );

  if (!items.length) {
    return (
      <aside className="notif-panel notif-panel-empty" role="complementary">
        {undoSnack}
      </aside>
    );
  }

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
                <span className="notif-name">{watchDisplayTitle(w)}</span>
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
      {undoSnack}
    </aside>
  );
}
