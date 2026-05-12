import { useEffect, useState } from 'react';
import { api } from '../api';
import StarRating from './StarRating';
import { specialTag } from './WatchList';
import Backdrop from './Backdrop';
import InfoTip from './InfoTip';
import TagEditor from './TagEditor';

function fmtDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

export default function EditWatchModal({ watch, onClose, onUpdated, onDeleted, onFilterDirector }) {
  const [rating, setRating] = useState(watch.rating || null);
  const [notes, setNotes] = useState(watch.notes || '');
  const [watchedDate, setWatchedDate] = useState(fmtDateInput(watch.watched_at));
  const [theater, setTheater] = useState(watch.theater_name || '');
  const [tags, setTags] = useState(watch.tags || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  const [showOverride, setShowOverride] = useState(false);
  const [overrideQ, setOverrideQ] = useState(watch.title);
  const [overrideResults, setOverrideResults] = useState([]);

  const isUnseen = !!specialTag(watch);

  useEffect(() => {
    if (!showOverride) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.searchTmdb(overrideQ);
        setOverrideResults(r);
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [overrideQ, showOverride]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const patch = {
        rating: rating || null,
        notes: notes.trim() || null,
        theater_name: theater.trim() || null,
        tags,
      };
      if (watchedDate) {
        patch.watched_at = new Date(watchedDate + 'T20:00:00').toISOString();
      }
      const updated = await api.updateWatch(watch.id, patch);
      onUpdated(updated);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function markAsWatched() {
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateWatch(watch.id, { status: 'watched' });
      onUpdated(updated);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function recheckUnseen() {
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const result = await api.recheckUnseen(watch.id);
      onUpdated(result.watch);
      if (result.resolved) setInfo(`Resolved to “${result.title}”`);
      else setInfo(`No reveal yet — ${result.reason || 'Reddit hasn’t updated'}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function pickTmdb(r) {
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateWatch(watch.id, { tmdb_id: r.tmdb_id });
      onUpdated(updated);
      setShowOverride(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`Delete "${watch.title}"?`)) return;
    setBusy(true);
    try {
      await api.deleteWatch(watch.id);
      onDeleted(watch.id);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  const tmdb = watch.tmdb || {};
  const title = tmdb.title || watch.title;
  const tag = specialTag(watch);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <Backdrop posterUrl={tmdb.poster_url || null} intensity="hero" />

        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <header className="sheet-hero">
          <div className="sheet-poster">
            {tmdb.poster_url ? (
              <img src={tmdb.poster_url} alt="" />
            ) : (
              <div className="sheet-poster-blank">
                {(title || '?').slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>

          <div className="sheet-headline">
            {tag && <span className="sheet-tag">{tag}</span>}
            <h2 className="sheet-title">{title}</h2>
            <div className="sheet-meta">
              {[
                tmdb.release_year,
                tmdb.runtime_minutes
                  ? `${Math.floor(tmdb.runtime_minutes / 60)}h ${tmdb.runtime_minutes % 60}m`
                  : null,
                tmdb.genres?.slice(0, 2).join(' · '),
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {tmdb.director && (
              <div className="sheet-director">
                Directed by{' '}
                {onFilterDirector ? (
                  <button
                    type="button"
                    className="link-inline"
                    onClick={() => {
                      onFilterDirector(tmdb.director);
                      onClose();
                    }}
                  >
                    {tmdb.director}
                  </button>
                ) : (
                  <span>{tmdb.director}</span>
                )}
              </div>
            )}

            <div className="sheet-actionrow">
              <span className="link-with-info">
                <button type="button" className="link-inline" onClick={() => setShowOverride((s) => !s)}>
                  {showOverride ? 'Cancel' : 'Assign movie'}
                </button>
                <InfoTip label="What does Assign movie do?">
                  Manually pick the matching TMDB title. Useful when the
                  auto-match is wrong or flagged for review. The original email
                  title (incl. any “Screen Unseen” tag) stays intact.
                </InfoTip>
              </span>

              {isUnseen && (
                <span className="link-with-info">
                  <button
                    type="button"
                    className="link-inline"
                    onClick={recheckUnseen}
                    disabled={busy}
                  >
                    Re-check
                  </button>
                  <InfoTip label="What does Re-check do?">
                    Re-fetches the actual movie reveal from r/AMCsAList. Use
                    this if the megathread has been updated with the title
                    since the last check.
                  </InfoTip>
                </span>
              )}
            </div>
          </div>
        </header>

        {showOverride && (
          <div className="override">
            <input
              className="override-search"
              value={overrideQ}
              onChange={(e) => setOverrideQ(e.target.value)}
              placeholder="Search TMDB"
            />
            <div className="override-results">
              {overrideResults.map((r) => (
                <button
                  key={r.tmdb_id}
                  type="button"
                  className="override-item"
                  onClick={() => pickTmdb(r)}
                >
                  {r.poster_url ? (
                    <img src={r.poster_url} alt="" />
                  ) : (
                    <div className="override-thumb-blank" />
                  )}
                  <div>
                    <div>{r.title}</div>
                    <div className="dim">{r.release_year || ''}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="sheet-body">
          <div className="sheet-field rate-field">
            <label className="sheet-label">Your rating</label>
            <StarRating value={rating} onChange={setRating} size={28} />
          </div>

          <div className="sheet-field">
            <label className="sheet-label">Notes</label>
            <textarea
              className="textarea-naked"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What did you think?"
            />
          </div>

          <div className="sheet-field">
            <label className="sheet-label">Tags</label>
            <TagEditor tags={tags} onChange={setTags} />
          </div>

          <div className="sheet-row">
            <div className="sheet-field">
              <label className="sheet-label">Watched on</label>
              <input
                type="date"
                className="input-naked"
                value={watchedDate}
                onChange={(e) => setWatchedDate(e.target.value)}
              />
            </div>
            <div className="sheet-field">
              <label className="sheet-label">Theatre</label>
              <input
                className="input-naked"
                value={theater}
                onChange={(e) => setTheater(e.target.value)}
              />
            </div>
          </div>

          {err && <div className="form-error">{err}</div>}
          {info && <div className="form-info">{info}</div>}
        </div>

        <footer className="sheet-actions">
          <button type="button" className="ghost-btn danger" onClick={del} disabled={busy}>
            Delete
          </button>
          <div style={{ flex: 1 }} />
          {(watch.status === 'no_show' || watch.status === 'cancelled') && (
            <button
              type="button"
              className="solid-btn"
              onClick={markAsWatched}
              disabled={busy}
            >
              Mark as Watched
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="solid-btn" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
