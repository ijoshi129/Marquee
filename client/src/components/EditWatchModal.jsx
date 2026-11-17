import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import StarRating from './StarRating';
import { specialTag } from './WatchList';
import { watchDisplayTitle, rewatchLabel, fmtShowtime } from '../format';
import Backdrop from './Backdrop';
import TagEditor from './TagEditor';
import SocialBar from './SocialBar';
import BookingSeatSheet from './BookingSeatSheet';

const STATUSES = [
  { value: 'pending', label: 'Booked' },
  { value: 'watched', label: 'Watched' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TYPING_SAVE_MS = 700;

function fmtDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function fmtDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Showtimes are the theatre's clock labelled UTC, so the weekday is read in UTC too.
function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}, ${fmtShowtime(iso)}`;
}

export default function EditWatchModal({ watch, onClose, onUpdated, onDeleted, onFilterDirector, onOpenNowPlaying }) {
  const [status, setStatus] = useState(watch.status);
  const [rating, setRating] = useState(watch.rating || null);
  const [notes, setNotes] = useState(watch.notes || '');
  const [watchedDate, setWatchedDate] = useState(fmtDateInput(watch.watched_at));
  const [theater, setTheater] = useState(watch.theater_name || '');
  const [tags, setTags] = useState(watch.tags || []);
  const [isPrivate, setIsPrivate] = useState(!!watch.is_private);
  const [saving, setSaving] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [seatsOpen, setSeatsOpen] = useState(false);

  const [showOverride, setShowOverride] = useState(false);
  const [overrideQ, setOverrideQ] = useState(watch.title);
  const [overrideResults, setOverrideResults] = useState([]);

  // Typed fields wait for a pause before saving. Whatever is still waiting
  // when the sheet closes is saved on the way out.
  const pending = useRef({});
  const timer = useRef(null);
  const flashTimer = useRef(null);

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
        setOverrideResults(await api.searchTmdb(overrideQ));
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [overrideQ, showOverride]);

  async function persist(patch) {
    setSaving((n) => n + 1);
    setErr(null);
    try {
      const updated = await api.updateWatch(watch.id, patch);
      onUpdated(updated);
      setSavedFlash(true);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1600);
      return updated;
    } catch (e) {
      setErr(`Not saved: ${e.message}`);
      return null;
    } finally {
      setSaving((n) => n - 1);
    }
  }

  function flush() {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) return persist(patch);
    return null;
  }

  function saveSoon(patch) {
    Object.assign(pending.current, patch);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, TYPING_SAVE_MS);
  }

  function saveNow(patch) {
    Object.assign(pending.current, patch);
    return flush();
  }

  useEffect(() => () => {
    clearTimeout(flashTimer.current);
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    flush();
    onClose();
  }

  function changeStatus(next) {
    if (next === status) return;
    setStatus(next);
    const patch = { status: next };
    if (next !== 'watched') {
      patch.watched_at = null;
      setWatchedDate('');
    }
    saveNow(patch)?.then((u) => {
      if (u && u.watched_at) setWatchedDate(fmtDateInput(u.watched_at));
      if (!u) setStatus(watch.status);
    });
  }

  function changeRating(r) {
    setRating(r);
    saveNow({ rating: r || null });
  }

  function changeTags(t) {
    setTags(t);
    saveNow({ tags: t });
  }

  function changeShared(shared) {
    setIsPrivate(!shared);
    saveNow({ is_private: !shared });
  }

  function changeDate(v) {
    setWatchedDate(v);
    if (v) saveNow({ watched_at: new Date(v + 'T20:00:00').toISOString() });
  }

  async function recheckUnseen() {
    setMenuOpen(false);
    setErr(null);
    setInfo(null);
    setSaving((n) => n + 1);
    try {
      const result = await api.recheckUnseen(watch.id);
      onUpdated(result.watch);
      if (result.resolved) setInfo(`Found it: “${result.title}”`);
      else setInfo(`No reveal yet. ${result.reason || 'The megathread has not been updated.'}`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving((n) => n - 1);
    }
  }

  async function pickTmdb(r) {
    const u = await persist({ tmdb_id: r.tmdb_id });
    if (u) setShowOverride(false);
  }

  async function del() {
    if (!confirm(`Delete "${watch.title}" from your diary?`)) return;
    clearTimeout(timer.current);
    pending.current = {};
    try {
      await api.deleteWatch(watch.id);
      onDeleted(watch.id);
    } catch (e) {
      setErr(e.message);
    }
  }

  const tmdb = watch.tmdb || {};
  const title = watchDisplayTitle(watch);
  const tag = specialTag(watch);
  const when = [fmtWhen(watch.showtime), watch.theater_name].filter(Boolean).join(' · ');
  const seatText = [
    watch.auditorium ? `Auditorium ${watch.auditorium}` : null,
    watch.seats?.length ? watch.seats.join(', ') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Every film is queued for Trakt whether or not it is connected, so only a
  // sync that happened, or failed, says anything.
  const trakt = watch.trakt_sync_error ? `Failed: ${watch.trakt_sync_error}` : watch.trakt_synced_at ? 'Synced' : null;

  const watched = status === 'watched';
  const saveLabel = saving > 0 ? 'Saving' : savedFlash ? 'Saved' : '';

  return (
    <>
      <div className="sheet-backdrop" onClick={close}>
        <div className="sheet film-sheet" role="dialog" aria-modal="true" onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}>
          <Backdrop posterUrl={tmdb.poster_url || null} intensity="hero" />

          <span className="fs-saved" aria-live="polite">{saveLabel}</span>
          <button
            type="button"
            className="fs-more"
            aria-label="More"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
          >
            ⋯
          </button>
          <button className="sheet-close" onClick={close} aria-label="Close">
            ✕
          </button>

          {menuOpen && (
            <div className="fs-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setShowOverride(true);
                }}
              >
                Assign a different movie
                <small>When the match is wrong</small>
              </button>
              {isUnseen && (
                <button type="button" role="menuitem" onClick={recheckUnseen}>
                  Re-check the Unseen reveal
                  <small>Look again on r/AMCsAList</small>
                </button>
              )}
            </div>
          )}

          <header className="sheet-hero">
            <div className="sheet-poster">
              {tmdb.poster_url ? (
                <img src={tmdb.poster_url} alt="" />
              ) : (
                <div className="sheet-poster-blank">{(title || '?').slice(0, 2).toUpperCase()}</div>
              )}
            </div>

            <div className="sheet-headline">
              {tag && <span className="sheet-tag">{tag}</span>}
              <h2 className="sheet-title">{title}</h2>
              <div className="sheet-meta">
                {[
                  tmdb.release_year,
                  tmdb.runtime_minutes ? `${Math.floor(tmdb.runtime_minutes / 60)}h ${tmdb.runtime_minutes % 60}m` : null,
                  tmdb.genres?.slice(0, 2).join(' · '),
                  rewatchLabel(watch),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {when && <div className="fs-when">{when}</div>}
              {tmdb.director && (
                <div className="sheet-director">
                  Directed by{' '}
                  {onFilterDirector ? (
                    <button
                      type="button"
                      className="link-inline"
                      onClick={() => {
                        onFilterDirector(tmdb.director);
                        close();
                      }}
                    >
                      {tmdb.director}
                    </button>
                  ) : (
                    <span>{tmdb.director}</span>
                  )}
                </div>
              )}
              {seatText && (
                <div className="fs-seat">
                  <span className="fs-seat-text">
                    <span className="fs-seat-k">{watch.seats?.length > 1 ? 'Your seats' : 'Your seat'}</span>
                    <span className="fs-seat-v">{seatText}</span>
                  </span>
                  <button type="button" className="fs-seat-btn" onClick={() => setSeatsOpen(true)}>
                    See seat map
                  </button>
                </div>
              )}
            </div>
          </header>

          {showOverride && (
            <div className="override">
              <div className="fs-override-head">
                <span className="fs-label">Assign a different movie</span>
                <button type="button" className="link-inline" onClick={() => setShowOverride(false)}>
                  Cancel
                </button>
              </div>
              <input
                className="override-search"
                value={overrideQ}
                onChange={(e) => setOverrideQ(e.target.value)}
                placeholder="Search TMDB"
                autoFocus
              />
              <div className="override-results">
                {overrideResults.map((r) => (
                  <button key={r.tmdb_id} type="button" className="override-item" onClick={() => pickTmdb(r)}>
                    {r.poster_url ? <img src={r.poster_url} alt="" /> : <div className="override-thumb-blank" />}
                    <div>
                      <div>{r.title}</div>
                      <div className="dim">{r.release_year || ''}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="sheet-body fs-body">
            {err && <div className="form-error">{err}</div>}
            {info && <div className="form-info">{info}</div>}

            <section className="fs-sec">
              <span className="fs-label">Status</span>
              <div className="fs-status" role="radiogroup" aria-label="Status">
                {STATUSES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={status === s.value}
                    className={status === s.value ? 'is-on' : ''}
                    onClick={() => changeStatus(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </section>

            {watched && (
              <section className="fs-sec">
                <span className="fs-label">Your rating</span>
                <StarRating value={rating} onChange={changeRating} size={28} />
              </section>
            )}

            <section className="fs-sec">
              <span className="fs-label">Note</span>
              <textarea
                className="fs-note"
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  saveSoon({ notes: e.target.value.trim() || null });
                }}
                onBlur={flush}
                rows={3}
                placeholder={watched ? 'What did you think?' : 'Anything to remember?'}
              />
            </section>

            <section className="fs-sec">
              <span className="fs-label">Tags</span>
              <TagEditor tags={tags} onChange={changeTags} />
            </section>

            <section className="fs-sec">
              <span className="fs-label">Details</span>
              <div className="fs-list">
                {watched && (
                  <div className="fs-row">
                    <span className="fs-row-k">Seen on</span>
                    {editRow === 'date' ? (
                      <input
                        type="date"
                        className="fs-row-input"
                        value={watchedDate}
                        onChange={(e) => changeDate(e.target.value)}
                        onBlur={() => setEditRow(null)}
                        autoFocus
                      />
                    ) : (
                      <button type="button" className="fs-row-v" onClick={() => setEditRow('date')}>
                        {fmtDay(watch.watched_at) || 'Add a date'}
                        <span className="fs-chev" aria-hidden="true">›</span>
                      </button>
                    )}
                  </div>
                )}
                <div className="fs-row">
                  <span className="fs-row-k">Theatre</span>
                  {editRow === 'theatre' ? (
                    <input
                      className="fs-row-input"
                      value={theater}
                      onChange={(e) => {
                        setTheater(e.target.value);
                        saveSoon({ theater_name: e.target.value.trim() || null });
                      }}
                      onBlur={() => {
                        flush();
                        setEditRow(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      placeholder="AMC …"
                      autoFocus
                    />
                  ) : (
                    <button type="button" className="fs-row-v" onClick={() => setEditRow('theatre')}>
                      {theater ? theater.replace(/^AMC\s+/i, '') : 'Add a theatre'}
                      <span className="fs-chev" aria-hidden="true">›</span>
                    </button>
                  )}
                </div>
                <label className="fs-row fs-row-toggle">
                  <span className="fs-row-k">
                    Show friends
                    <small>{watched ? 'It appears in their feed' : 'They see you have booked it'}</small>
                  </span>
                  <input
                    type="checkbox"
                    className="fs-switch"
                    checked={!isPrivate}
                    onChange={(e) => changeShared(e.target.checked)}
                  />
                </label>
                {trakt && (
                  <div className="fs-row">
                    <span className="fs-row-k">Trakt</span>
                    <span className={`fs-row-v is-static ${watch.trakt_sync_error ? 'is-bad' : ''}`}>{trakt}</span>
                  </div>
                )}
              </div>
            </section>

            {comments.length > 0 && (
              <section className="fs-sec">
                <span className="fs-label">Comments</span>
                <SocialBar item={{ host_own_watch_id: watch.id, comments }} onChanged={loadComments} defaultOpen />
              </section>
            )}

            <button type="button" className="fs-delete" onClick={del}>
              Delete from diary
            </button>
          </div>
        </div>
      </div>

      {seatsOpen && (
        <BookingSeatSheet
          watch={watch}
          title={title}
          onClose={() => setSeatsOpen(false)}
          onOpenNowPlaying={
            onOpenNowPlaying
              ? (focus) => {
                  flush();
                  onOpenNowPlaying(focus);
                }
              : null
          }
        />
      )}
    </>
  );
}
