import { useEffect, useState } from 'react';
import { api } from '../api';

// Films you and a friend have both watched, with both ratings.
export default function CommonFilmsSheet({ friend, onClose }) {
  const [films, setFilms] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.commonFilms(friend.id).then(setFilms).catch((e) => setErr(e.message));
  }, [friend.id]);

  const stars = (n) => (n ? '★'.repeat(n) : '—');

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet friends-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <header className="friends-modal-head">
          <h2 className="friends-modal-title">Films in common</h2>
          <p className="friends-modal-sub">You and {friend.display_name} have both seen these.</p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {films === null ? (
          <div className="friends-empty">Loading&hellip;</div>
        ) : films.length === 0 ? (
          <div className="friends-empty">Nothing in common yet.</div>
        ) : (
          <ul className="common-list">
            {films.map((f) => (
              <li key={f.tmdb_id} className="common-row">
                {f.poster_url ? (
                  <img src={f.poster_url} alt="" loading="lazy" />
                ) : (
                  <span className="common-blank">{(f.title || '?').slice(0, 2).toUpperCase()}</span>
                )}
                <span className="common-text">
                  <span className="common-title">{f.title}{f.release_year ? ` · ${f.release_year}` : ''}</span>
                  <span className="common-ratings">
                    <span>You <b>{stars(f.my_rating)}</b></span>
                    <span>{friend.display_name} <b>{stars(f.their_rating)}</b></span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
