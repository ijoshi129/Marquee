import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import StarRating from './StarRating';
import Backdrop from './Backdrop';

function todayLocalDate() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

export default function AddWatchModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [tmdbId, setTmdbId] = useState(null);
  const [tmdbResults, setTmdbResults] = useState([]);
  const [tmdbHidden, setTmdbHidden] = useState(false);
  const [pickedPoster, setPickedPoster] = useState(null);
  const [theater, setTheater] = useState('');
  const [theaterSuggest, setTheaterSuggest] = useState([]);
  const [theaterHidden, setTheaterHidden] = useState(false);
  const theaterBlurTimeout = useRef(null);
  const [watchedDate, setWatchedDate] = useState(todayLocalDate());
  const [rating, setRating] = useState(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const titleRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!title.trim() || tmdbHidden) {
      setTmdbResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const rows = await api.searchTmdb(title);
        if (!cancelled) setTmdbResults(rows);
      } catch {}
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [title, tmdbHidden]);

  function handleTitleChange(e) {
    setTitle(e.target.value);
    setTmdbId(null);
    setTmdbHidden(false);
    setPickedPoster(null);
  }

  function pickTmdb(r) {
    setTitle(r.title);
    setTmdbId(r.tmdb_id);
    setTmdbResults([]);
    setTmdbHidden(true);
    setPickedPoster(r.poster_url || null);
  }

  useEffect(() => {
    let cancelled = false;
    if (theater.length < 1 || theaterHidden) {
      setTheaterSuggest([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const rows = await api.searchTheaters(theater);
        if (!cancelled) setTheaterSuggest(rows);
      } catch {}
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [theater, theaterHidden]);

  function handleTheaterChange(e) {
    setTheater(e.target.value);
    setTheaterHidden(false);
  }

  function pickTheater(name) {
    setTheater(name);
    setTheaterSuggest([]);
    setTheaterHidden(true);
  }

  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) {
      setErr('Title required');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const watched_at = watchedDate ? new Date(watchedDate + 'T20:00:00').toISOString() : null;
      const created = await api.createWatch({
        title: title.trim(),
        tmdb_id: tmdbId || undefined,
        theater_name: theater.trim() || undefined,
        watched_at,
        rating: rating || undefined,
        notes: notes.trim() || undefined,
        status: 'watched',
      });
      onCreated(created);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet sheet-add"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
      >
        <Backdrop posterUrl={pickedPoster} intensity="hero" />

        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <header className="sheet-add-head">
          <span className="sheet-eyebrow">New Entry</span>
          <h2 className="sheet-title">Log a film</h2>
        </header>

        <div className="sheet-body">
          <div className="sheet-field">
            <label className="sheet-label">Title</label>
            <input
              ref={titleRef}
              className="input-naked input-display"
              value={title}
              onChange={handleTitleChange}
              placeholder="e.g. Dune: Part Two"
              autoComplete="off"
              required
            />
            {tmdbResults.length > 0 && (
              <div className="override-results inline">
                {tmdbResults.slice(0, 8).map((r) => (
                  <button
                    key={r.tmdb_id}
                    type="button"
                    className="override-item"
                    onClick={() => pickTmdb(r)}
                  >
                    {r.poster_url ? (
                      <img src={r.poster_url} alt="" />
                    ) : (
                      <div className="override-thumb-blank">
                        {r.title.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div>{r.title}</div>
                      <div className="dim">{r.release_year || ''}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="sheet-field">
            <label className="sheet-label">Theatre</label>
            <input
              className="input-naked"
              value={theater}
              onChange={handleTheaterChange}
              placeholder="e.g. AMC Lincoln Square 13"
              autoComplete="off"
              onFocus={() => {
                clearTimeout(theaterBlurTimeout.current);
                setTheaterHidden(false);
              }}
              onBlur={() => {
                // Grace period so an onClick on a suggestion fires before we hide.
                theaterBlurTimeout.current = setTimeout(
                  () => setTheaterHidden(true),
                  150
                );
              }}
            />
            {theaterSuggest.length > 0 && !theaterHidden && (
              <div className="override-results inline">
                {theaterSuggest.slice(0, 8).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="override-item terse"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickTheater(t.name)}
                  >
                    <div>{t.name}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

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
            <label className="sheet-label">Rating</label>
            <StarRating value={rating} onChange={setRating} size={28} />
          </div>

          <div className="sheet-field">
            <label className="sheet-label">Notes</label>
            <textarea
              className="textarea-naked"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="optional"
            />
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>

        <footer className="sheet-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="solid-btn" disabled={saving}>
            {saving ? 'Logging…' : 'Log it'}
          </button>
        </footer>
      </form>
    </div>
  );
}
