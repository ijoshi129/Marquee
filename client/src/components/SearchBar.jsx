import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const STATUS_OPTIONS = [
  { key: 'active', label: 'Active' },
  { key: 'watched', label: 'Watched' },
  { key: 'pending', label: 'Upcoming' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'no_show', label: 'No-show' },
];

const SORT_OPTIONS = [
  { value: 'date:desc', label: 'Most recent' },
  { value: 'date:asc', label: 'Oldest first' },
  { value: 'rating:desc', label: 'Highest rated' },
  { value: 'rating:asc', label: 'Lowest rated' },
  { value: 'runtime:desc', label: 'Longest first' },
  { value: 'runtime:asc', label: 'Shortest first' },
  { value: 'title:asc', label: 'A → Z' },
];

const RATING_OPTIONS = [
  { key: 'any', label: 'Any', value: null },
  { key: 'r3', label: '★3+', value: 3 },
  { key: 'r4', label: '★4+', value: 4 },
  { key: 'r5', label: '★5', value: 5 },
];

const FORMAT_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'regular', label: 'Regular' },
  { key: 'screen_unseen', label: 'Screen Unseen' },
  { key: 'scream_unseen', label: 'Scream Unseen' },
];

export default function SearchBar({
  q,
  onQ,
  statusKey,
  onStatusKey,
  sortKey,
  onSortKey,
  genre,
  onGenre,
  minRating,
  onMinRating,
  format,
  onFormat,
  onGenreClick,
}) {
  const [text, setText] = useState(q);
  const [suggest, setSuggest] = useState(null);
  const [showSuggest, setShowSuggest] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [genreOptions, setGenreOptions] = useState(null);
  const blurTimeout = useRef(null);

  useEffect(() => setText(q), [q]);

  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => onQ(text), 250);
    return () => clearTimeout(t);
  }, [text, q, onQ]);

  useEffect(() => {
    if (!showSuggest || text.trim().length < 2) {
      setSuggest(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const data = await api.searchSuggest(text);
        if (!cancelled) setSuggest(data);
      } catch {}
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, showSuggest]);

  useEffect(() => {
    if (!filtersOpen || genreOptions !== null) return;
    api
      .stats({ period: 'all' })
      .then((s) => setGenreOptions((s.genres || []).map((g) => g.name)))
      .catch(() => setGenreOptions([]));
  }, [filtersOpen, genreOptions]);

  function pickSuggestion(value) {
    setText(value);
    onQ(value);
    setSuggest(null);
    setShowSuggest(false);
  }

  function pickGenre(value) {
    setText('');
    setSuggest(null);
    setShowSuggest(false);
    if (onGenreClick) onGenreClick(value);
    else onGenre(value);
  }

  function onBlur() {
    blurTimeout.current = setTimeout(() => setShowSuggest(false), 150);
  }
  function onFocus() {
    clearTimeout(blurTimeout.current);
    setShowSuggest(true);
  }

  function clearSearch() {
    setText('');
    onQ('');
    setSuggest(null);
    setShowSuggest(false);
  }

  function clearFilters() {
    onGenre(null);
    onMinRating(null);
    onFormat('all');
  }

  const filtersActive =
    !!genre || !!minRating || (format && format !== 'all');

  const showSuggestionList =
    showSuggest &&
    suggest &&
    (suggest.movies.length ||
      suggest.directors.length ||
      suggest.theaters.length ||
      (suggest.genres || []).length);

  return (
    <div className="searchbar-wrap">
      <div className="searchbar-eyebrow">Browse</div>
      <div className="searchbar">
        <div className="search-input-wrap">
          <svg
            className="search-icon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            className="search-input"
            type="search"
            placeholder="Search films, directors, genres, theatres…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={onFocus}
            onBlur={onBlur}
          />
          {text.length > 0 && (
            <button
              type="button"
              className="search-clear"
              // preventDefault on mousedown keeps focus on the input so the
              // suggest popup doesn't blur-collapse before onClick fires.
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearSearch}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}

          {showSuggestionList && (
            <div className="suggest-pop">
              {suggest.movies.length > 0 && (
                <SuggestGroup title="Films">
                  {suggest.movies.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="suggest-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSuggestion(m.title)}
                    >
                      {m.poster_url ? (
                        <img src={m.poster_url} alt="" />
                      ) : (
                        <div className="suggest-thumb" />
                      )}
                      <span>{m.title}</span>
                    </button>
                  ))}
                </SuggestGroup>
              )}
              {suggest.directors.length > 0 && (
                <SuggestGroup title="Directors">
                  {suggest.directors.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="suggest-item terse"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSuggestion(d)}
                    >
                      {d}
                    </button>
                  ))}
                </SuggestGroup>
              )}
              {suggest.theaters.length > 0 && (
                <SuggestGroup title="Theatres">
                  {suggest.theaters.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="suggest-item terse"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSuggestion(t)}
                    >
                      {t}
                    </button>
                  ))}
                </SuggestGroup>
              )}
              {(suggest.genres || []).length > 0 && (
                <SuggestGroup title="Genres">
                  {suggest.genres.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className="suggest-item terse"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickGenre(g)}
                    >
                      {g}
                    </button>
                  ))}
                </SuggestGroup>
              )}
            </div>
          )}
        </div>

        <div className="searchbar-tools">
          <select
            className="select-naked"
            value={sortKey}
            onChange={(e) => onSortKey(e.target.value)}
            aria-label="Sort"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`pill-btn ${filtersOpen ? 'open' : ''} ${filtersActive ? 'active' : ''}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            Filters
            {filtersActive && <span className="pill-dot" />}
          </button>
        </div>
      </div>

      <div className="status-rail" role="radiogroup" aria-label="Status">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={statusKey === s.key}
            className={`rail-chip ${statusKey === s.key ? 'on' : ''}`}
            onClick={() => statusKey !== s.key && onStatusKey(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {filtersOpen && (
        <div className="filters-panel">
          <div className="filter-row">
            <label className="filter-label">Genre</label>
            <select
              className="select-naked"
              value={genre || ''}
              onChange={(e) => onGenre(e.target.value || null)}
            >
              <option value="">Any</option>
              {(genreOptions || []).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-row">
            <label className="filter-label">Rating</label>
            <div className="status-rail compact">
              {RATING_OPTIONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`rail-chip ${(minRating || null) === r.value ? 'on' : ''}`}
                  onClick={() => onMinRating(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-row">
            <label className="filter-label">Format</label>
            <div className="status-rail compact">
              {FORMAT_OPTIONS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`rail-chip ${(format || 'all') === f.key ? 'on' : ''}`}
                  onClick={() => onFormat(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {filtersActive && (
            <button type="button" className="link-quiet" onClick={clearFilters}>
              ✕ Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestGroup({ title, children }) {
  return (
    <div className="suggest-group">
      <div className="suggest-group-title">{title}</div>
      {children}
    </div>
  );
}
