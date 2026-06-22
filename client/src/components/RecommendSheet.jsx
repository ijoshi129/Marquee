import { useEffect, useState } from 'react';
import { api } from '../api';

// Pick one of your watched films to recommend to a friend — it lands in their
// watchlist with a notification.
export default function RecommendSheet({ friend, onClose }) {
  const [films, setFilms] = useState(null);
  const [q, setQ] = useState('');
  const [sent, setSent] = useState(() => new Set());
  const [err, setErr] = useState(null);

  useEffect(() => {
    api
      .listWatches({ status: 'watched', limit: 300, sort: 'date', dir: 'desc' })
      .then((rows) => setFilms(rows.filter((w) => w.tmdb_id)))
      .catch((e) => setErr(e.message));
  }, []);

  const seen = new Set();
  const list = (films || [])
    .filter((w) => {
      const t = (w.tmdb?.title || w.title || '').toLowerCase();
      return !q.trim() || t.includes(q.trim().toLowerCase());
    })
    .filter((w) => (seen.has(w.tmdb_id) ? false : (seen.add(w.tmdb_id), true)));

  async function send(w) {
    if (sent.has(w.tmdb_id)) return;
    setErr(null);
    try {
      await api.recommendFilm(friend.id, w.tmdb_id, w.tmdb?.title || w.title);
      setSent((s) => new Set(s).add(w.tmdb_id));
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <header className="friends-modal-head">
          <h2 className="friends-modal-title">Recommend to {friend.display_name}</h2>
          <p className="friends-modal-sub">Pick a film you&rsquo;ve seen — it lands in their watchlist.</p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        <input
          className="cmt-input rec-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your films…"
        />

        {films === null ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : (
          <ul className="rec-pick">
            {list.slice(0, 60).map((w) => {
              const done = sent.has(w.tmdb_id);
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    className="rec-pick-row"
                    onClick={() => send(w)}
                    disabled={done}
                  >
                    {w.tmdb?.poster_url ? (
                      <img src={w.tmdb.poster_url} alt="" loading="lazy" />
                    ) : (
                      <span className="rec-pick-blank">{(w.tmdb?.title || w.title || '?').slice(0, 2).toUpperCase()}</span>
                    )}
                    <span className="rec-pick-text">
                      <span className="rec-pick-title">{w.tmdb?.title || w.title}</span>
                      <span className="rec-pick-year">{w.tmdb?.release_year || ''}</span>
                    </span>
                    <span className={`rec-pick-send ${done ? 'done' : ''}`}>
                      {done ? 'Recommended ✓' : 'Send'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
