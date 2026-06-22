import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtShortDate, isUpcoming } from '../format';

export default function WatchlistView({ onWatched }) {
  const [items, setItems] = useState(null);
  const [nowPlaying, setNowPlaying] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const blurTimer = useRef(null);

  async function load() {
    try {
      const [list, np] = await Promise.all([api.listWatchlist(), api.nowPlaying()]);
      setItems(list);
      setNowPlaying(np);
    } catch (e) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setResults(await api.searchTmdb(query));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const onList = new Set((items || []).map((i) => i.tmdb_id));

  async function add(tmdbId) {
    if (onList.has(tmdbId)) return;
    setBusy(true);
    try {
      await api.addWatchlist(tmdbId);
      setQuery('');
      setResults([]);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    setItems((xs) => xs.filter((i) => i.id !== id));
    try {
      await api.removeWatchlist(id);
      load();
    } catch (e) {
      setErr(e.message);
      load();
    }
  }

  async function markWatched(id) {
    setItems((xs) => xs.filter((i) => i.id !== id));
    try {
      await api.markWatchlistWatched(id, {});
      await load();
      onWatched?.();
    } catch (e) {
      setErr(e.message);
      load();
    }
  }

  return (
    <section className="watchlist-view">
      <div className="watchlist-add">
        <input
          className="input-naked input-display"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setResults([]), 150);
          }}
          onFocus={() => clearTimeout(blurTimer.current)}
          placeholder="Search a film to add…"
          autoComplete="off"
        />
        {results.length > 0 && (
          <div className="override-results inline">
            {results.slice(0, 8).map((r) => (
              <button
                key={r.tmdb_id}
                type="button"
                className="override-item"
                disabled={busy || onList.has(r.tmdb_id)}
                onClick={() => add(r.tmdb_id)}
              >
                {r.poster_url ? (
                  <img src={r.poster_url} alt="" />
                ) : (
                  <div className="override-thumb-blank">{r.title.slice(0, 2).toUpperCase()}</div>
                )}
                <div>
                  <div>{r.title}</div>
                  <div className="dim">
                    {r.release_year || ''}
                    {onList.has(r.tmdb_id) ? ' · on list' : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="error-banner">{err}</div>}

      {items === null ? null : items.length === 0 ? (
        <div className="empty">
          <div className="empty-glyph">✦</div>
          <div className="empty-headline">Nothing on your watchlist yet.</div>
          <div className="empty-sub">Search above, or add from Now Playing below.</div>
        </div>
      ) : (
        <div className="watch-grid">
          {items.map((it) => {
            const tmdb = it.tmdb || {};
            const title = tmdb.title || it.title;
            return (
              <div key={it.id} className="wl-card">
                <div className="poster-frame">
                  {tmdb.poster_url ? (
                    <img src={tmdb.poster_url} alt="" loading="lazy" />
                  ) : (
                    <div className="poster-blank">
                      <span>{title.slice(0, 2).toUpperCase()}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="wl-watched"
                    onClick={() => markWatched(it.id)}
                    aria-label="Mark watched"
                    title="Mark watched"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="wl-remove"
                    onClick={() => remove(it.id)}
                    aria-label="Remove from watchlist"
                    title="Remove"
                  >
                    ✕
                  </button>
                  {it.recommended_by && (
                    <span className="poster-status pending">Recommended by {it.recommended_by}</span>
                  )}
                </div>
                <div className="wl-title">{title}</div>
                <div className="wl-year">{tmdb.release_year || ''}</div>
              </div>
            );
          })}
        </div>
      )}

      <section className="now-playing">
        <h2 className="now-playing-title">Now Playing</h2>
        <div className="now-playing-row">
          {nowPlaying.map((m) => {
            const added = onList.has(m.tmdb_id);
            const upcoming = isUpcoming(m.release_date);
            return (
              <button
                key={m.tmdb_id}
                type="button"
                className={`np-poster ${added || m.seen ? 'is-dim' : ''}`}
                disabled={added || m.seen || busy}
                onClick={() => add(m.tmdb_id)}
                title={
                  m.seen
                    ? 'Already in your diary'
                    : added
                    ? 'On your watchlist'
                    : upcoming
                    ? `In theaters ${fmtShortDate(m.release_date)}`
                    : 'Add to watchlist'
                }
              >
                {m.poster_url ? (
                  <img src={m.poster_url} alt={m.title} loading="lazy" />
                ) : (
                  <div className="poster-blank">{m.title.slice(0, 2).toUpperCase()}</div>
                )}
                {upcoming && <span className="np-date">{fmtShortDate(m.release_date)}</span>}
                <span className="np-badge">{m.seen ? 'Seen' : added ? 'On list' : '+ Add'}</span>
              </button>
            );
          })}
        </div>
      </section>
    </section>
  );
}
