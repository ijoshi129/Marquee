import { useEffect, useState } from 'react';
import { api } from '../api';
import StarRating from './StarRating';
import { specialTag } from './WatchList';
import { watchDisplayTitle, rewatchLabel } from '../format';
import Backdrop from './Backdrop';
import InfoTip from './InfoTip';
import TagEditor from './TagEditor';
import SocialBar from './SocialBar';

const STATUS_OPTIONS = [
  { value: 'watched', label: 'Watched' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
];

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
  const [isPrivate, setIsPrivate] = useState(!!watch.is_private);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  const [showOverride, setShowOverride] = useState(false);
  const [overrideQ, setOverrideQ] = useState(watch.title);
  const [overrideResults, setOverrideResults] = useState([]);

  // Conversations on your own films live here on the film, not the friends feed.
  const [comments, setComments] = useState([]);
  async function loadComments() {
    try {
      setComments(await api.watchComments(watch.id));
    } catch {}
  }
  useEffect(() => {
    loadComments();
  }, [watch.id]);

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
        is_private: isPrivate,
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

  async function setStatus(status) {
    setBusy(true);
    setErr(null);
    try {
      const patch = { status };
      if (status !== 'watched') patch.watched_at = null;
      const updated = await api.updateWatch(watch.id, patch);
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
  const title = watchDisplayTitle(watch);
  const tag = specialTag(watch);

  const traktStatus = watch.trakt_sync_error
    ? { kind: 'error', text: `Trakt sync failed — ${watch.trakt_sync_error}` }
    : watch.trakt_synced_at
    ? { kind: 'ok', text: 'Synced to Trakt' }
    : watch.trakt_sync_requested_at
    ? { kind: 'pending', text: 'Trakt sync pending' }
    : null;

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
                rewatchLabel(watch),
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

          <div className="sheet-field">
            <label className="private-toggle">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              <span>
                Keep private
                <span className="private-hint">Hidden from friends — never leaves this instance.</span>
              </span>
            </label>
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

          {comments.length > 0 && (
            <div className="sheet-field">
              <label className="sheet-label">Comments</label>
              <SocialBar
                item={{ host_own_watch_id: watch.id, comments }}
                onChanged={loadComments}
                defaultOpen
              />
            </div>
          )}

          {traktStatus && (
            <div className="sheet-field">
              <label className="sheet-label">Trakt</label>
              <span className={`trakt-status trakt-status--${traktStatus.kind}`}>
                {traktStatus.text}
              </span>
            </div>
          )}

          {err && <div className="form-error">{err}</div>}
          {info && <div className="form-info">{info}</div>}
        </div>

        <footer className="sheet-actions">
          <button type="button" className="ghost-btn danger" onClick={del} disabled={busy}>
            Delete
          </button>
          <div style={{ flex: 1 }} />
          {STATUS_OPTIONS.filter((s) => s.value !== watch.status).map((s) => (
            <button
              key={s.value}
              type="button"
              className={s.value === 'watched' ? 'solid-btn' : 'ghost-btn'}
              onClick={() => setStatus(s.value)}
              disabled={busy}
            >
              Mark as {s.label}
            </button>
          ))}
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
