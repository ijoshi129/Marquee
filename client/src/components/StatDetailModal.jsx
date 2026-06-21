import { useState } from 'react';
import { fmtRuntime, MONTH_NAMES } from '../format';

const TITLES = {
  films: 'Films Logged',
  runtime: 'Total Runtime',
  rating: 'Mean Rating',
  genre: 'Signature Genre',
};

function Explain({ open, onToggle, className = '', children, note }) {
  return (
    <div className={`alv-x ${className} ${open ? 'open' : ''}`} onClick={onToggle}>
      {children}
      <div className="alv-explain">{note}</div>
    </div>
  );
}

function Row({ k, open, onToggle, label, sub, val, note, className }) {
  return (
    <Explain className={className} open={open === k} onToggle={() => onToggle(k)} note={note}>
      <div className="alv-row">
        <div className="alv-row-label">
          {label}
          {sub && <span className="alv-row-sub">{sub}</span>}
        </div>
        <div className="alv-row-val">{val}</div>
      </div>
    </Explain>
  );
}

export default function StatDetailModal({ stat, stats, periodLabel, isAllTime, onClose }) {
  const [open, setOpen] = useState(null);
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));
  const s = stats || {};

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet alv-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="alv-pad">
          <div className="alv-eyebrow">{TITLES[stat]}</div>
          <div className="alv-period">{periodLabel}</div>
          <div className="alv-hint">tap any figure for what it means</div>

          {stat === 'films' && <FilmsBody s={s} isAllTime={isAllTime} open={open} toggle={toggle} />}
          {stat === 'runtime' && <RuntimeBody s={s} isAllTime={isAllTime} open={open} toggle={toggle} />}
          {stat === 'rating' && <RatingBody s={s} open={open} toggle={toggle} />}
          {stat === 'genre' && <GenreBody s={s} open={open} toggle={toggle} />}
        </div>
      </div>
    </div>
  );
}

function YearList({ rows, open, toggle, fmt, note }) {
  return (
    <>
      <div className="alv-section-eyebrow">By year</div>
      {rows.map((y) => (
        <Explain
          key={y.year}
          className="alv-yr"
          open={open === `y${y.year}`}
          onToggle={() => toggle(`y${y.year}`)}
          note={note(y)}
        >
          <div className="alv-yr-row">
            <div className="alv-yr-name">{y.year}</div>
            <div className="alv-yr-val">{fmt(y)}</div>
          </div>
        </Explain>
      ))}
    </>
  );
}

function FilmsBody({ s, isAllTime, open, toggle }) {
  const monthly = s.monthly_breakdown || [];
  const active = monthly.filter((m) => m.count > 0);
  const pace = active.length ? s.count / active.length : 0;
  const busiest = monthly.reduce((best, m) => (!best || m.count > best.count ? m : best), null);
  const busiestLabel = busiest
    ? `${MONTH_NAMES[parseInt(busiest.month.slice(5, 7), 10) - 1]} ${busiest.month.slice(0, 4)}`
    : '—';
  const rewatches = s.rewatches?.length || 0;
  const day = s.superlatives?.busiest_day;
  const years = (s.years || []).filter((y) => y.films > 0);

  return (
    <>
      <Explain className="alv-hero" open={open === 'h'} onToggle={() => toggle('h')}
        note="Every watched film in this period — reservations you attended, walk-ups, and ones you logged by hand.">
        <div className="alv-hero-num">{s.count}</div>
        <div className="alv-hero-sub">films logged</div>
      </Explain>

      <div className="alv-receipt">
        <Row k="pace" open={open} onToggle={toggle} label="Pace"
          sub={`across ${active.length} active ${active.length === 1 ? 'month' : 'months'}`}
          val={`${pace.toFixed(1)} / mo`}
          note="Films divided by the months you actually went — your typical moviegoing cadence." />
        {busiest && busiest.count > 0 && (
          <Row k="busy" open={open} onToggle={toggle} label="Busiest month" sub={busiestLabel}
            val={`${busiest.count} films`} note="The single month you logged the most films." />
        )}
        {day && day.count >= 2 && (
          <Row k="day" open={open} onToggle={toggle} label="Best day" sub={day.date}
            val={`${day.count} films`} note="Your biggest single day — a double or triple feature." />
        )}
        <Row k="re" open={open} onToggle={toggle} label="First-watches vs rewatches"
          val={`${s.count - rewatches} · ${rewatches}`}
          note="How many films were new to you versus ones you'd already seen before." />
      </div>

      {isAllTime && years.length > 1 && (
        <YearList rows={years} open={open} toggle={toggle}
          fmt={(y) => `${y.films} ${y.films === 1 ? 'film' : 'films'}`}
          note={(y) => `Films logged in ${y.year}.`} />
      )}
    </>
  );
}

function RuntimeBody({ s, isAllTime, open, toggle }) {
  const total = s.total_runtime_minutes || 0;
  const days = (total / 1440).toFixed(1);
  const avg = s.count ? Math.round(total / s.count) : 0;
  const longest = s.superlatives?.longest_film;
  const years = (s.years || []).filter((y) => y.runtime_minutes > 0);

  return (
    <>
      <Explain className="alv-hero" open={open === 'h'} onToggle={() => toggle('h')}
        note="Combined runtime of every film you've logged — total time in a theatre seat.">
        <div className="alv-hero-num">{Math.round(total / 60)}h</div>
        <div className="alv-hero-sub">≈ {days} days in the dark</div>
      </Explain>

      <div className="alv-tiles">
        <Explain className="alv-tile" open={open === 'avg'} onToggle={() => toggle('avg')}
          note="Total runtime divided by films seen — your typical movie length.">
          <div className="alv-tile-num accent">{fmtRuntime(avg)}</div>
          <div className="alv-tile-cap">average film</div>
        </Explain>
        <Explain className="alv-tile" open={open === 'long'} onToggle={() => toggle('long')}
          note="Your longest single film this period.">
          <div className="alv-tile-num accent">{longest ? fmtRuntime(longest.runtime_minutes) : '—'}</div>
          <div className="alv-tile-cap">longest</div>
        </Explain>
      </div>

      {longest && (
        <>
          <div className="alv-section-eyebrow">Longest sit</div>
          <Explain open={open === 'lf'} onToggle={() => toggle('lf')}
            note="The single longest film you sat through this period.">
            <div className="alv-posters">
              <div className="alv-poster">
                {longest.poster_url ? <img src={longest.poster_url} alt="" loading="lazy" /> : <div className="alv-poster-blank" />}
                <div className="alv-poster-cap">{longest.title} · {fmtRuntime(longest.runtime_minutes)}</div>
              </div>
            </div>
          </Explain>
        </>
      )}

      {isAllTime && years.length > 1 && (
        <YearList rows={years} open={open} toggle={toggle}
          fmt={(y) => `${(y.runtime_minutes / 60).toFixed(1)} h`}
          note={(y) => `Hours watched in ${y.year}.`} />
      )}
    </>
  );
}

function RatingBody({ s, open, toggle }) {
  const rb = s.rating_breakdown || { counts: [0, 0, 0, 0, 0], rated: 0, unrated: 0 };
  const max = Math.max(1, ...rb.counts);
  const picks = (s.top_rated || []).slice(0, 8);

  if (!rb.rated) {
    return (
      <>
        <div className="alv-hero"><div className="alv-hero-num">—</div><div className="alv-hero-sub">no ratings yet</div></div>
        <div className="alv-excluded">Rate films from the diary and your average and distribution show up here.</div>
      </>
    );
  }

  return (
    <>
      <Explain className="alv-hero" open={open === 'h'} onToggle={() => toggle('h')}
        note="The average of the star ratings you've given. Unrated films don't count toward it.">
        <div className="alv-hero-num">{s.average_rating}<span className="alv-hero-star"> ★</span></div>
        <div className="alv-hero-sub">across {rb.rated} rated {rb.rated === 1 ? 'film' : 'films'}</div>
      </Explain>

      <div className="alv-section-eyebrow">Distribution</div>
      <Explain open={open === 'dist'} onToggle={() => toggle('dist')} note="How your ratings split across the five stars.">
        {[5, 4, 3, 2, 1].map((star) => (
          <div key={star} className="alv-bar">
            <div className="alv-bar-key">{star} ★</div>
            <div className="alv-bar-track"><div className="alv-bar-fill" style={{ width: `${(rb.counts[star - 1] / max) * 100}%` }} /></div>
            <div className="alv-bar-val">{rb.counts[star - 1]}</div>
          </div>
        ))}
      </Explain>

      <Row k="rated" open={open} onToggle={toggle} label="Rated" val={`${rb.rated} of ${s.count}`}
        note={`You've rated ${rb.rated} of your ${s.count} logged films; the rest are unrated.`} />

      {picks.length > 0 && (
        <>
          <div className="alv-section-eyebrow">Five-Star Picks</div>
          <Explain open={open === 'picks'} onToggle={() => toggle('picks')} note="The films you rated five stars.">
            <div className="alv-posters">
              {picks.map((p) => (
                <div key={p.id} className="alv-poster">
                  {p.poster_url ? <img src={p.poster_url} alt="" loading="lazy" /> : <div className="alv-poster-blank">{p.title.slice(0, 2).toUpperCase()}</div>}
                  <div className="alv-poster-cap">{p.title}</div>
                </div>
              ))}
            </div>
          </Explain>
        </>
      )}
    </>
  );
}

function GenreBody({ s, open, toggle }) {
  const genres = s.genres || [];
  const top = genres[0];
  const max = top ? top.count : 1;
  const total = s.count || 0;
  const share = (n) => (total ? Math.round((n / total) * 100) : 0);

  if (!top) {
    return (
      <>
        <div className="alv-hero"><div className="alv-hero-num">—</div><div className="alv-hero-sub">no genres yet</div></div>
      </>
    );
  }

  return (
    <>
      <Explain className="alv-hero" open={open === 'h'} onToggle={() => toggle('h')}
        note="The genre tag on more of your films than any other. A film can carry several, so shares can add past 100%.">
        <div className="alv-hero-num alv-hero-text">{top.name}</div>
        <div className="alv-hero-sub">your most-seen genre — {top.count} films ({share(top.count)}%)</div>
      </Explain>

      <div className="alv-section-eyebrow">All genres</div>
      <Explain open={open === 'all'} onToggle={() => toggle('all')} note="Every genre across your films, ranked by how many carry it.">
        {genres.map((g) => (
          <div key={g.name} className="alv-bar alv-bar-genre">
            <div className="alv-bar-key">{g.name}</div>
            <div className="alv-bar-track"><div className="alv-bar-fill" style={{ width: `${(g.count / max) * 100}%` }} /></div>
            <div className="alv-bar-val">{g.count}</div>
          </div>
        ))}
      </Explain>
    </>
  );
}
