import { useEffect, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES, fmtRuntime } from '../format';

function released(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${MONTH_NAMES[m - 1]} ${d}, ${y}` : null;
}

// More about a film on the board. The listing's own details show at once; the
// synopsis, cast, score and trailer arrive from TMDB a moment later.
export default function FilmInfoSheet({ film, onClose }) {
  // undefined while loading, null when nothing was found.
  const [info, setInfo] = useState(undefined);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (film.unseen) {
      setInfo(null);
      return undefined;
    }
    let alive = true;
    api
      .npFilm(film.title, film.year)
      .then((r) => alive && setInfo(r.info))
      .catch((e) => {
        if (!alive) return;
        setErr(e.message);
        setInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [film.title, film.year, film.unseen]);

  const runtime = film.runtime || (info && info.runtime_minutes);
  const genres = info && info.genres.length ? info.genres : film.genres;
  const meta = [film.rating, runtime ? fmtRuntime(runtime) : null, film.year || (info && info.release_date ? info.release_date.slice(0, 4) : null)]
    .filter(Boolean)
    .join(' · ');
  const poster = film.poster_url || (info && info.poster_url);

  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div
        className="fmenu-card film-card"
        role="dialog"
        aria-modal="true"
        aria-label={film.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fmenu-grab" />
        <div className="notif-head">
          <span className="picker-title" style={{ margin: 0 }}>About the film</span>
          <button type="button" className="notif-action" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="film-hero">
          <div className="film-poster">
            {poster ? <img src={poster} alt="" /> : <div className="poster-blank">{film.title.slice(0, 2).toUpperCase()}</div>}
          </div>
          <div className="film-headline">
            <h2 className="film-title">{film.title}</h2>
            {meta && <div className="film-meta">{meta}</div>}
            {genres.length > 0 && <div className="film-genres">{genres.slice(0, 4).join(', ')}</div>}
            {info && info.score != null && (
              <div className="film-score">
                <b>{info.score.toFixed(1)}</b> / 10 on TMDB
              </div>
            )}
          </div>
        </div>

        {film.unseen && (
          <p className="film-overview">
            A mystery screening: AMC does not say what the film is until it starts. The rating above is all there is to
            go on.
          </p>
        )}

        {info === undefined && <div className="film-loading">Finding out more…</div>}

        {info && (
          <>
            {info.tagline && <p className="film-tagline">{info.tagline}</p>}
            {info.overview && <p className="film-overview">{info.overview}</p>}
            <dl className="film-facts">
              {info.directors.length > 0 && (
                <div>
                  <dt>{info.directors.length > 1 ? 'Directors' : 'Director'}</dt>
                  <dd>{info.directors.join(', ')}</dd>
                </div>
              )}
              {info.cast.length > 0 && (
                <div>
                  <dt>Cast</dt>
                  <dd>{info.cast.map((c) => c.name).join(', ')}</dd>
                </div>
              )}
              {released(info.release_date) && (
                <div>
                  <dt>Released</dt>
                  <dd>{released(info.release_date)}</dd>
                </div>
              )}
            </dl>
            <div className="film-links">
              {info.trailer_url && (
                <a className="film-trailer" href={info.trailer_url} target="_blank" rel="noopener noreferrer">
                  Watch trailer
                </a>
              )}
              <a className="film-more" href={info.tmdb_url} target="_blank" rel="noopener noreferrer">
                More on TMDB
              </a>
            </div>
          </>
        )}

        {info === null && !film.unseen && (
          <p className="film-none">{err ? `Could not load more: ${err}` : 'Nothing more could be found for this one.'}</p>
        )}
      </div>
    </div>
  );
}
