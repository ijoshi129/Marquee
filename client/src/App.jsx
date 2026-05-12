import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import StatsBar from './components/StatsBar';
import WatchList from './components/WatchList';
import AddWatchModal from './components/AddWatchModal';
import EditWatchModal from './components/EditWatchModal';
import SearchBar from './components/SearchBar';
import Notifications from './components/Notifications';
import Backdrop from './components/Backdrop';

const DEFAULT_STATUS_KEY = 'active';
const CURRENT_YEAR = new Date().getUTCFullYear();

// Map the single-select chip key to the comma-list the server expects.
function statusKeyToParam(key) {
  if (key === 'active') return 'watched,pending';
  return key;
}

export default function App() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [q, setQ] = useState('');
  const [statusKey, setStatusKey] = useState(DEFAULT_STATUS_KEY);
  const [sortKey, setSortKey] = useState('date:desc');
  const [genre, setGenre] = useState(null);
  const [director, setDirector] = useState(null);
  const [tag, setTag] = useState(null);
  const [minRating, setMinRating] = useState(null);
  // null = "All time" view (grid spans every year). YIR's prev/next steps
  // control this; typing in the search bar silently overrides to all-time.
  const [year, setYear] = useState(CURRENT_YEAR);

  // Scroll anchor for filter clicks — clicking a director/genre in YIR pulls
  // the page down to the SearchBar so the user lands on the filtered results,
  // not the top of the page.
  const filterAnchorRef = useRef(null);
  const scrollToFilteredResults = useCallback(() => {
    filterAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [sort, dir] = sortKey.split(':');
      const params = {
        limit: 200,
        sort,
        dir,
        status: statusKeyToParam(statusKey),
      };
      if (q) params.q = q;
      if (genre) params.genre = genre;
      if (director) params.director = director;
      if (tag) params.tag = tag;
      if (minRating) params.min_rating = minRating;
      // Apply year scope only when not searching. Search silently spans all
      // years so a user can find an old film without having to step the year.
      // include_pending=1 lets pending rows escape the year filter — your
      // upcoming reservations show on the active view regardless of year.
      if (year !== null && !q.trim()) {
        params.from = `${year}-01-01`;
        params.to = `${year + 1}-01-01`;
        params.include_pending = 1;
      }
      const rows = await api.listWatches(params);
      setWatches(rows);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [q, statusKey, sortKey, genre, director, tag, minRating, year]);

  // Click a genre (in YIR Top Genres or in the search-suggest dropdown) →
  // set the precise genre filter rather than a fuzzy text search. Year scope
  // is intentionally preserved so the user stays within the year they were
  // exploring.
  const filterByGenre = useCallback((name) => {
    setQ('');
    setStatusKey('active');
    setGenre(name);
    setDirector(null);
    setTag(null);
    setMinRating(null);
    scrollToFilteredResults();
  }, []);

  // Same shape as filterByGenre — preserves the selected year so clicking a
  // director in YIR shows that director's films within the year currently
  // in view, not all-time.
  const filterByDirector = useCallback((name) => {
    setQ('');
    setStatusKey('active');
    setGenre(null);
    setDirector(name);
    setTag(null);
    setMinRating(null);
    scrollToFilteredResults();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleCreated(watch) {
    setAdding(false);
    setRefreshKey((k) => k + 1);
    load();
  }

  function handleUpdated(watch) {
    if (editing && editing.id === watch.id) setEditing(watch);
    setRefreshKey((k) => k + 1);
    // Re-fetch so server-side filters (status, search, period) are reapplied —
    // a row whose new status no longer matches the current filter should drop out.
    load();
  }

  function handleDeleted(id) {
    setEditing(null);
    setRefreshKey((k) => k + 1);
    load();
  }

  // Pick a backdrop poster: prefer the row currently being edited, otherwise
  // the most recent watched film with artwork.
  const featuredPoster = useMemo(() => {
    if (editing?.tmdb?.poster_url) return editing.tmdb.poster_url;
    const row = watches.find((w) => w.tmdb?.poster_url);
    return row?.tmdb?.poster_url || null;
  }, [editing, watches]);

  return (
    <div className="app">
      <Backdrop posterUrl={featuredPoster} intensity="ambient" />

      <header className="topbar">
        <div className="wordmark">
          <h1 className="wordmark-name">Marquee</h1>
          <span className="wordmark-tag">Cinema Diary</span>
        </div>
      </header>

      <main>
        <Notifications
          refreshKey={refreshKey}
          onWatchUpdated={handleUpdated}
          onSelectWatch={setEditing}
        />
        <StatsBar
          refreshKey={refreshKey}
          year={year}
          onYearChange={setYear}
          onDirectorClick={filterByDirector}
          onGenreClick={filterByGenre}
        />

        <div ref={filterAnchorRef}>
          <SearchBar
            q={q}
            onQ={setQ}
            statusKey={statusKey}
            onStatusKey={setStatusKey}
            sortKey={sortKey}
            onSortKey={setSortKey}
            genre={genre}
            onGenre={setGenre}
            director={director}
            onDirector={setDirector}
            tag={tag}
            onTag={setTag}
            minRating={minRating}
            onMinRating={setMinRating}
            onGenreClick={filterByGenre}
          />
        </div>

        {err && <div className="error-banner">{err}</div>}

        {loading && watches.length === 0 ? (
          <div className="empty">
            <div className="empty-glyph">◌</div>
            <div className="empty-headline">Lights up…</div>
          </div>
        ) : (
          <WatchList watches={watches} onSelect={setEditing} onWatchUpdated={handleUpdated} />
        )}
      </main>

      <button className="fab" onClick={() => setAdding(true)} aria-label="Add watch">
        +
      </button>

      {adding && <AddWatchModal onClose={() => setAdding(false)} onCreated={handleCreated} />}
      {editing && (
        <EditWatchModal
          key={editing.id}
          watch={editing}
          onClose={() => setEditing(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onFilterDirector={filterByDirector}
        />
      )}
    </div>
  );
}
