import { useState } from 'react';
import { api } from '../api';
import StarRating from './StarRating';

// AMC promotional/special-event detector. The original email title is preserved
// in `w.title` even after a TMDB match, so this stays accurate.
export function specialTag(title) {
  if (!title) return null;
  const m = /amc\s+(screen|scream)\s+unseen/i.exec(title);
  if (m) {
    const word = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${word} Unseen`;
  }
  return null;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STATUS_LABEL = {
  pending: 'Upcoming',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export default function WatchList({ watches, onSelect, onWatchUpdated }) {
  if (!watches.length) {
    return (
      <div className="empty-state">
        <div className="empty-glyph">◌</div>
        <div className="empty-headline">A blank reel.</div>
        <p className="empty-body">No watches match your filters. Tap + to add one.</p>
      </div>
    );
  }
  return (
    <div className="watch-grid">
      {watches.map((w, i) => (
        <WatchCard
          key={w.id}
          w={w}
          index={i}
          onSelect={onSelect}
          onWatchUpdated={onWatchUpdated}
        />
      ))}
    </div>
  );
}

function WatchCard({ w, index, onSelect, onWatchUpdated }) {
  const [savingRating, setSavingRating] = useState(false);

  function open() {
    onSelect(w);
  }

  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  }

  async function quickRate(value) {
    if (savingRating) return;
    setSavingRating(true);
    try {
      const updated = await api.updateWatch(w.id, { rating: value });
      onWatchUpdated?.(updated);
    } catch (err) {
      console.error('quick-rate:', err);
    } finally {
      setSavingRating(false);
    }
  }

  const tag = specialTag(w.title);
  const isScream = !!tag && /scream/i.test(tag);
  const displayTitle = w.tmdb?.title || w.title;
  const year = w.tmdb?.release_year;
  const runtime = w.tmdb?.runtime_minutes;
  const isInactive =
    w.status === 'cancelled' || w.status === 'no_show';
  const needsIdentify = !!tag && !w.tmdb_id;

  return (
    <article
      className={`poster-card status-${w.status}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      style={{ animationDelay: `${Math.min(index * 28, 600)}ms` }}
      aria-label={`${displayTitle} — ${STATUS_LABEL[w.status] || 'watched'}`}
    >
      <div className={`poster-frame ${isInactive ? 'desaturated' : ''}`}>
        {w.tmdb?.poster_url ? (
          <img src={w.tmdb.poster_url} alt="" loading="lazy" />
        ) : tag ? (
          <img
            src={isScream ? '/scream-unseen.avif' : '/screen-unseen.avif'}
            alt={tag}
            loading="lazy"
            className="poster-unseen-art"
          />
        ) : (
          <div className="poster-blank">
            <span>{(displayTitle || '?').slice(0, 2).toUpperCase()}</span>
          </div>
        )}

        {tag && !needsIdentify && (
          <span className={`poster-ribbon ${isScream ? 'scream' : ''}`}>{tag}</span>
        )}

        {needsIdentify && (
          <span className="poster-identify">Identify?</span>
        )}

        {w.tmdb_needs_review && !needsIdentify && (
          <span className="poster-flag" title="TMDB match needs review">
            ?
          </span>
        )}

        {w.status === 'pending' && (
          <span className="poster-status pending">Upcoming</span>
        )}
        {w.status === 'cancelled' && (
          <span className="poster-status cancelled">Cancelled</span>
        )}
        {w.status === 'no_show' && (
          <span className="poster-status cancelled">No-show</span>
        )}

        <div className="poster-overlay">
          <div className="poster-meta">
            <div className="poster-title">{displayTitle}</div>
            <div className="poster-sub">
              {[
                year,
                runtime ? `${Math.floor(runtime / 60)}h ${runtime % 60}m` : null,
                fmtDate(w.watched_at || w.showtime),
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {w.theater_name && <div className="poster-theater">{w.theater_name}</div>}
          </div>
        </div>
      </div>

      <div className="poster-foot">
        <div className="poster-foot-title">{displayTitle}</div>
        <div
          className="poster-foot-rate"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <StarRating value={w.rating} onChange={quickRate} size={14} />
        </div>
      </div>
    </article>
  );
}
