import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import StatsBar from './components/StatsBar';
import WatchList from './components/WatchList';
import AddWatchModal from './components/AddWatchModal';
import EditWatchModal from './components/EditWatchModal';
import SearchBar from './components/SearchBar';
import Notifications from './components/Notifications';
import Backdrop from './components/Backdrop';

const DEFAULT_STATUS_KEY = 'active';

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
  const [minRating, setMinRating] = useState(null);
  const [format, setFormat] = useState('all');

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
      if (minRating) params.min_rating = minRating;
      if (format && format !== 'all') params.format = format;
      const rows = await api.listWatches(params);
      setWatches(rows);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [q, statusKey, sortKey, genre, minRating, format]);

  // Used by clickable director names (in YIR or the edit modal) — fills the
  // search box and ensures the result set is broad enough to find them.
  const searchFor = useCallback((term) => {
    setQ(term);
    setStatusKey('active');
    setGenre(null);
    setMinRating(null);
    setFormat('all');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Click a genre (in YIR Top Genres or in the search-suggest dropdown) →
  // set the precise genre filter rather than a fuzzy text search.
  const filterByGenre = useCallback((name) => {
    setQ('');
    setStatusKey('active');
    setGenre(name);
    setMinRating(null);
    setFormat('all');
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          onDirectorClick={searchFor}
          onGenreClick={filterByGenre}
        />

        <SearchBar
          q={q}
          onQ={setQ}
          statusKey={statusKey}
          onStatusKey={setStatusKey}
          sortKey={sortKey}
          onSortKey={setSortKey}
          genre={genre}
          onGenre={setGenre}
          minRating={minRating}
          onMinRating={setMinRating}
          format={format}
          onFormat={setFormat}
          onGenreClick={filterByGenre}
        />

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
          onSearchFor={searchFor}
        />
      )}
    </div>
  );
}
