import { useEffect, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES, fmtRuntime } from '../format';

function longDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? `${MONTH_NAMES[m - 1]} ${d}, ${y}` : null;
}

function shortDate(iso) {
  const [, m, d] = String(iso || '').split('-').map(Number);
  return m && d ? `${MONTH_NAMES[m - 1]} ${d}` : '';
}

const FIT = { strong: 'Strong fit', possible: 'Possible', long: 'Long shot' };

// Guesses at what a mystery screening is. Nothing is fetched or shown until
// the owner asks: for someone who likes the surprise, even a shortlist is a
// spoiler.
function UnseenGuesses({ film, date, guess, setGuess, onOpen }) {
  const { state, data, err } = guess;

  function reveal() {
    setGuess({ state: 'loading' });
    api
      .npUnseenGuesses(date, film.unseen, film.rating)
      .then((d) => setGuess({ state: 'shown', data: d }))
      .catch((e) => setGuess({ state: 'failed', err: e.message }));
  }

  if (state === 'hidden') {
    return (
      <div className="guess-gate">
        <button type="button" className="guess-reveal" onClick={reveal}>
          Show likely candidates
        </button>
        <p className="guess-note">
          Guesses worked out from the rating, AMC&rsquo;s stated runtime and what opens soon. Leave it closed to keep
          the surprise.
        </p>
      </div>
    );
  }
  if (state === 'loading') return <div className="film-loading">Working it out…</div>;
  if (state === 'failed') return <p className="film-none">Could not work out candidates: {err}</p>;

  const { basis, revealed, candidates } = data;
  const clues = [basis.rating ? `rated ${basis.rating}` : null, basis.runtime_minutes ? `${fmtRuntime(basis.runtime_minutes)} long` : null]
    .filter(Boolean)
    .join(' and ');

  return (
    <div className="guess">
      <div className="guess-title">Likely candidates</div>
      {revealed ? (
        <p className="guess-revealed">
          Reddit already has this one down as <b>{revealed}</b>.
        </p>
      ) : (
        <>
          <p className="guess-basis">
            {clues ? `AMC says it is ${clues}. ` : 'AMC has published nothing about this one yet. '}
            Most Unseens open in cinemas 4 or 11 days later
            {basis.runtime_minutes ? ', and AMC’s runtime is usually a few minutes longer than the real one' : ''}. These
            are guesses, not a leak.
          </p>
          {data.needs_key && <p className="film-none">Candidates need a TMDB key, and none is set.</p>}
          {!data.needs_key && candidates.length === 0 && (
            <p className="film-none">Nothing opening soon fits what AMC has said.</p>
          )}
          {candidates.map((c) => (
            <button key={c.tmdb_id} type="button" className="guess-row" onClick={() => onOpen(c)}>
              <span className="guess-poster">
                {c.poster_url ? <img src={c.poster_url} alt="" loading="lazy" /> : <span>{c.title.slice(0, 2).toUpperCase()}</span>}
              </span>
              <span className="guess-text">
                <span className="guess-name">{c.title}</span>
                <span className="guess-why">{c.reasons.join(' · ')}</span>
              </span>
              <span className={`guess-fit ${c.fit}`}>{FIT[c.fit]}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// More about a film on the board. The listing's own details show at once; the
// synopsis, cast, score and trailer arrive from TMDB a moment later.
export default function FilmInfoSheet({ film: listed, date, onClose }) {
  // A candidate opened from an Unseen's guesses, shown in place of the Unseen.
  const [candidate, setCandidate] = useState(null);
  // Held here so the list is still open after looking at one candidate.
  // 'hidden' until asked for, then 'loading', then 'shown' or 'failed'.
  const [guess, setGuess] = useState({ state: 'hidden' });
  const film = candidate || listed;
  // undefined while loading, null when nothing was found.
  const [info, setInfo] = useState(undefined);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setErr(null);
    if (film.unseen) {
      setInfo(null);
      return undefined;
    }
    setInfo(undefined);
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
          {candidate ? (
            <button type="button" className="notif-action" onClick={() => setCandidate(null)}>
              ‹ Back to the Unseen
            </button>
          ) : (
            <span className="picker-title" style={{ margin: 0 }}>About the film</span>
          )}
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
            {candidate && <div className="film-candidate">A guess: opens {shortDate(candidate.opens)}</div>}
            {info && info.score != null && (
              <div className="film-score">
                <b>{info.score.toFixed(1)}</b> / 10 on TMDB
              </div>
            )}
          </div>
        </div>

        {film.unseen && (
          <>
            <p className="film-overview">
              A mystery screening: AMC does not say what the film is until it starts. The rating above is all it gives
              away here.
            </p>
            {date && (
              <UnseenGuesses
                film={film}
                date={date}
                guess={guess}
                setGuess={setGuess}
                onOpen={(c) => setCandidate({ ...c, genres: [], rating: null })}
              />
            )}
          </>
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
              {longDate(info.release_date) && (
                <div>
                  <dt>Released</dt>
                  <dd>{longDate(info.release_date)}</dd>
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
