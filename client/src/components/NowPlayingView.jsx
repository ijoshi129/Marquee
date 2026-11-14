import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES, fmtRuntime, fmtShowtime } from '../format';
import SeatMapSheet from './SeatMapSheet';
import TheatrePicker from './TheatrePicker';

const THEATRE_KEY = 'marquee.nowPlaying.theatre';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// A card has to stay on screen this long before its seat counts are fetched,
// so flicking through the list does not ask for every showing in the building.
const SETTLE_MS = 500;
const COUNTS_PER_CALL = 16;

function storedTheatre() {
  try {
    return localStorage.getItem(THEATRE_KEY);
  } catch {
    return null;
  }
}

function dateLabel(iso, today) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const diff = today ? Math.round((day - new Date(`${today}T00:00:00Z`)) / 86400000) : null;
  if (diff === 0) return { top: 'Today', bottom: `${MONTH_NAMES[m - 1]} ${d}` };
  if (diff === 1) return { top: 'Tomorrow', bottom: `${MONTH_NAMES[m - 1]} ${d}` };
  return { top: DAY_NAMES[day.getUTCDay()], bottom: `${MONTH_NAMES[m - 1]} ${d}` };
}

function seatsLabel(c) {
  if (!c) return null;
  if (c.available <= 0) return 'Full';
  return `${c.available} left`;
}

function FilmCard({ film, counts, onNeedCounts, onPick, onOpenWatch }) {
  const ref = useRef(null);
  // 'own' is the listing's poster, a string is the stand-in found after that
  // one failed to load, 'none' means there is nothing to show but initials.
  const [poster, setPoster] = useState('own');

  function posterBroke() {
    if (poster !== 'own') return setPoster('none');
    api
      .npPoster(film.title, film.year)
      .then((r) => setPoster(r.poster_url && r.poster_url !== film.poster_url ? r.poster_url : 'none'))
      .catch(() => setPoster('none'));
  }

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    let timer = null;
    const io = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer);
        if (!entry.isIntersecting) return;
        timer = setTimeout(() => {
          onNeedCounts(film);
          io.disconnect();
        }, SETTLE_MS);
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [film, onNeedCounts]);

  const meta = [film.rating, film.runtime ? fmtRuntime(film.runtime) : null, film.genres.slice(0, 2).join(', ')]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="np-film" ref={ref}>
      <div className="np-film-head">
        <div className="np-film-poster">
          {film.poster_url && poster !== 'none' ? (
            <img src={poster === 'own' ? film.poster_url : poster} alt="" loading="lazy" onError={posterBroke} />
          ) : (
            <div className="poster-blank">{film.title.slice(0, 2).toUpperCase()}</div>
          )}
        </div>
        <div className="np-film-info">
          <h3 className="np-film-title">{film.title}</h3>
          {meta && <div className="np-film-meta">{meta}</div>}
          {(film.booked || film.seen_watch_id) && (
            <div className="np-flags">
              {film.booked && (
                <button type="button" className="np-flag booked" onClick={() => onOpenWatch(film.booked.watch_id)}>
                  Booked{film.booked.showtime ? ` · ${fmtShowtime(film.booked.showtime)}` : ''}
                </button>
              )}
              {film.seen_watch_id && (
                <button type="button" className="np-flag seen" onClick={() => onOpenWatch(film.seen_watch_id)}>
                  Seen
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {film.formats.map((g) => (
        <div key={`${g.format}|${g.notes.join(',')}`} className="np-group">
          <div className="np-group-label">
            <span className={g.format === 'Standard' ? '' : 'is-premium'}>{g.format}</span>
            {g.notes.length > 0 && <span className="np-group-notes">{g.notes.join(' · ')}</span>}
          </div>
          <div className="np-times">
            {g.showtimes.map((s) => {
              const c = s.hash ? counts[s.hash] : null;
              const full = s.sold_out || (c && c.available <= 0);
              const low = !full && c && c.total > 0 && c.available / c.total <= 0.15;
              return (
                <button
                  key={s.starts_at + (s.hash || '')}
                  type="button"
                  className={`np-time ${full ? 'is-full' : ''} ${low ? 'is-low' : ''}`}
                  disabled={!s.hash}
                  onClick={() => onPick(film, g, s)}
                >
                  <span className="np-time-clock">{s.label}</span>
                  <span className="np-time-seats">
                    {s.sold_out ? 'Sold out' : seatsLabel(c) || (s.reserved ? 'Seats' : 'Open seating')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </article>
  );
}

// What is showing at one AMC theatre on one day, with a seat map behind every
// showtime. The home theatre opens first; the picker holds the rest.
export default function NowPlayingView({ onOpenWatch }) {
  const [theatres, setTheatres] = useState(null);
  const [theatreId, setTheatreId] = useState(storedTheatre);
  const [date, setDate] = useState(null);
  const [today, setToday] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [format, setFormat] = useState('All');
  const [counts, setCounts] = useState({});
  const [picking, setPicking] = useState(false);
  const [seat, setSeat] = useState(null);
  const asked = useRef(new Set());

  useEffect(() => {
    api
      .npTheatres()
      .then(setTheatres)
      .catch((e) => setErr(e.message));
  }, []);

  // Home first, then the diary's theatres by visits, then any others saved.
  const all = useMemo(() => {
    if (!theatres) return [];
    const out = [];
    for (const t of [theatres.home, ...(theatres.visited || []), ...theatres.saved]) {
      if (t && !out.some((o) => o.id === t.id)) out.push(t);
    }
    return out;
  }, [theatres]);
  const theatre = all.find((t) => t.id === theatreId) || (theatres && theatres.home) || all[0] || null;

  const chooseTheatre = useCallback((id) => {
    setTheatreId(id);
    setDate(null);
    setToday(null);
    setBoard(null);
    setFormat('All');
    try {
      localStorage.setItem(THEATRE_KEY, id);
    } catch {}
  }, []);

  const activeId = theatre ? theatre.id : null;
  useEffect(() => {
    if (!activeId) return undefined;
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .npShowtimes(activeId, date)
      .then((b) => {
        if (!alive) return;
        setBoard(b);
        // The first, dateless request answers for the theatre's own today.
        if (!date && b.date) setToday(b.date);
      })
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [activeId, date]);

  const needCounts = useCallback((film) => {
    const hashes = [];
    for (const g of film.formats) {
      for (const s of g.showtimes) {
        if (s.hash && !s.past && !s.sold_out && s.reserved && !asked.current.has(s.hash)) hashes.push(s.hash);
      }
    }
    for (let i = 0; i < hashes.length; i += COUNTS_PER_CALL) {
      const batch = hashes.slice(i, i + COUNTS_PER_CALL);
      batch.forEach((h) => asked.current.add(h));
      api
        .npSeatCounts(batch)
        .then((c) => setCounts((prev) => ({ ...prev, ...c })))
        .catch(() => batch.forEach((h) => asked.current.delete(h)));
    }
  }, []);

  const films = useMemo(() => {
    if (!board) return [];
    return board.films
      .map((f) => ({
        ...f,
        formats: f.formats
          .filter((g) => format === 'All' || g.format.startsWith(format))
          .map((g) => ({ ...g, showtimes: g.showtimes.filter((s) => !s.past) }))
          .filter((g) => g.showtimes.length),
      }))
      .filter((f) => f.formats.length);
  }, [board, format]);

  const formats = useMemo(() => {
    if (!board) return [];
    const found = new Set();
    for (const f of board.films) {
      for (const g of f.formats) {
        if (g.format !== 'Standard' && g.showtimes.some((s) => !s.past)) found.add(g.format.replace(/ 3D$/, ''));
      }
    }
    return [...found];
  }, [board]);

  const dates = useMemo(() => {
    if (!board) return [];
    const list = (board.dates || []).filter((d) => !today || d >= today);
    if (today && !list.includes(today)) list.unshift(today);
    return list;
  }, [board, today]);
  const shownDate = date || today;

  async function saveTheatres(next, select) {
    const hadHome = Boolean(theatres && theatres.home);
    const saved = await api.setNpTheatres(next);
    setTheatres(saved);
    if (select) chooseTheatre(select);
    // Choosing the first theatre is the whole errand, so show its board.
    if (!hadHome && saved.home) setPicking(false);
    return saved;
  }

  const firstRun = Boolean(theatres) && !theatre;

  return (
    <section className="np-view">
      {firstRun && (
        <div className="empty">
          <div className="empty-glyph">✦</div>
          <div className="empty-headline">Pick your home theatre.</div>
          <div className="empty-sub">Showtimes and open seats for the AMC you go to most.</div>
          <button type="button" className="np-cta" onClick={() => setPicking(true)}>
            Find a theatre
          </button>
        </div>
      )}

      {theatre && (
        <button type="button" className="np-theatre" onClick={() => setPicking(true)}>
          <span className="np-theatre-name">{theatre.name}</span>
          <span className="np-theatre-sub">
            {[theatre.city, theatre.state].filter(Boolean).join(', ')}
            {theatres.home && theatre.id === theatres.home.id ? ' · Home' : ''}
            <span className="np-theatre-chev" aria-hidden="true">
              Change
            </span>
          </span>
        </button>
      )}

      {all.length > 1 && (
        <div className="np-switch" role="tablist" aria-label="Your theatres">
          {all.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === activeId}
              className={`np-switch-chip ${t.id === activeId ? 'is-on' : ''}`}
              onClick={() => t.id !== activeId && chooseTheatre(t.id)}
            >
              {t.name.replace(/^AMC\s+/i, '')}
            </button>
          ))}
        </div>
      )}

      {dates.length > 0 && (
        <div className="np-dates">
          {dates.map((d) => {
            const l = dateLabel(d, today);
            return (
              <button
                key={d}
                type="button"
                className={`np-date-pill ${d === shownDate ? 'is-on' : ''}`}
                onClick={() => setDate(d === today ? null : d)}
              >
                <span className="np-date-top">{l.top}</span>
                <span className="np-date-bottom">{l.bottom}</span>
              </button>
            );
          })}
        </div>
      )}

      {formats.length > 0 && (
        <div className="np-formats">
          {['All', ...formats].map((f) => (
            <button
              key={f}
              type="button"
              className={`np-format ${format === f ? 'is-on' : ''}`}
              onClick={() => setFormat(f)}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {err && <div className="error-banner">{err}</div>}

      {!board && loading && (
        <div className="empty">
          <div className="empty-glyph">◌</div>
          <div className="empty-headline">Lights up…</div>
        </div>
      )}

      {board && films.length === 0 && !err && (
        <div className="empty">
          <div className="empty-glyph">◌</div>
          <div className="empty-headline">
            {format !== 'All' ? `No ${format} showings left.` : shownDate === today ? 'Nothing left today.' : 'Nothing showing.'}
          </div>
          <div className="empty-sub">Try another day.</div>
        </div>
      )}

      <div className={`np-films ${loading ? 'is-loading' : ''}`}>
        {films.map((f) => (
          <FilmCard
            key={`${activeId}:${shownDate}:${f.id}`}
            film={f}
            counts={counts}
            onNeedCounts={needCounts}
            onPick={(film, group, showtime) => setSeat({ film, group, showtime })}
            onOpenWatch={onOpenWatch}
          />
        ))}
      </div>

      {seat && (
        <SeatMapSheet
          film={seat.film}
          group={seat.group}
          showtime={seat.showtime}
          theatre={theatre}
          onCounts={(c) => setCounts((prev) => ({ ...prev, [seat.showtime.hash]: c }))}
          onClose={() => setSeat(null)}
        />
      )}

      {picking && (
        <TheatrePicker
          theatres={theatres}
          current={activeId}
          onClose={() => setPicking(false)}
          onSave={saveTheatres}
          onSelect={(id) => {
            chooseTheatre(id);
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}
