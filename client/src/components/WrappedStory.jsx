import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fmtRuntime, MONTH_NAMES_LONG } from '../format';

function monthLabel(month) {
  const year = month.slice(0, 4);
  const mi = parseInt(month.slice(5, 7), 10) - 1;
  return `${MONTH_NAMES_LONG[mi]} ${year}`;
}

function stepMonth(month, dir) {
  const year = parseInt(month.slice(0, 4), 10);
  const mi = parseInt(month.slice(5, 7), 10) - 1 + dir;
  const d = new Date(Date.UTC(year, mi, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// A month with no films shouldn't trap the user. The cover/outro carry a
// stepper, but the deepest a story ever goes when empty is one card.
function buildCards(data) {
  const cards = [{ key: 'cover', kind: 'cover' }];

  if (!data || data.count === 0) {
    cards.push({ key: 'empty', kind: 'empty' });
    cards.push({ key: 'outro', kind: 'outro' });
    return cards;
  }

  cards.push({ key: 'totals', kind: 'totals' });
  if (data.films?.length) cards.push({ key: 'films', kind: 'films' });
  if (data.genres?.length) cards.push({ key: 'genres', kind: 'genres' });
  if (data.top_directors?.length) cards.push({ key: 'directors', kind: 'directors' });
  if (data.theaters?.length) cards.push({ key: 'theaters', kind: 'theaters' });
  if (data.formats?.length > 1) cards.push({ key: 'formats', kind: 'formats' });

  const s = data.superlatives || {};
  const hasRatings =
    data.average_rating != null || s.five_star_count > 0 || data.top_rated?.length;
  if (hasRatings) cards.push({ key: 'ratings', kind: 'ratings' });
  // A "busiest day" of 1 is the norm and says nothing — only surface it when
  // it's an actual multi-film day (a double/triple feature).
  const multiFilmDay = s.busiest_day && s.busiest_day.count >= 2;
  if (multiFilmDay || s.longest_film) cards.push({ key: 'super', kind: 'super' });

  cards.push({ key: 'outro', kind: 'outro' });
  return cards;
}

export default function WrappedStory({ period, onClose }) {
  const [month, setMonth] = useState(period.month);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [idx, setIdx] = useState(0);
  const touchX = useRef(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    api
      .stats({ period: 'month', month })
      .then((d) => {
        if (!live) return;
        setData(d);
        setIdx(0);
      })
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [month]);

  const cards = useMemo(() => buildCards(data), [data]);
  const label = monthLabel(month);

  const next = useCallback(() => {
    setIdx((i) => {
      if (i >= cards.length - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [cards.length, onClose]);

  const prev = useCallback(() => {
    setIdx((i) => Math.max(0, i - 1));
  }, []);

  const step = useCallback((dir) => setMonth((m) => stepMonth(m, dir)), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  const onTouchStart = (e) => {
    touchX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e) => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (dx <= -50) next();
    else if (dx >= 50) prev();
  };

  const card = cards[Math.min(idx, cards.length - 1)];

  return (
    <div className="wrapped-overlay" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="wrapped-progress">
        {cards.map((c, i) => (
          <span
            key={c.key}
            className={`wrapped-progress-seg ${i < idx ? 'is-filled' : ''} ${
              i === idx ? 'is-active' : ''
            }`}
          />
        ))}
      </div>

      <button type="button" className="wrapped-close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      <div className="wrapped-stage">
        <button
          type="button"
          className="wrapped-tap wrapped-tap-left"
          onClick={prev}
          aria-label="Previous"
          tabIndex={-1}
        />
        <button
          type="button"
          className="wrapped-tap wrapped-tap-right"
          onClick={next}
          aria-label="Next"
          tabIndex={-1}
        />

        {loading ? (
          <div className="wrapped-card">
            <div className="wrapped-loading">Wrapping…</div>
          </div>
        ) : err ? (
          <div className="wrapped-card">
            <div className="wrapped-eyebrow">Hmm</div>
            <div className="wrapped-headline">{err}</div>
          </div>
        ) : (
          <CardBody card={card} data={data} label={label} month={month} onStep={step} />
        )}
      </div>
    </div>
  );
}

function CardBody({ card, data, label, month, onStep }) {
  const s = data?.superlatives || {};

  switch (card.kind) {
    case 'cover':
      return (
        <div className="wrapped-card wrapped-cover">
          <div className="wrapped-eyebrow">Marquee</div>
          <div className="wrapped-headline">{label}</div>
          <div className="wrapped-sub">in review</div>
          <div className="wrapped-hint">tap to begin →</div>
        </div>
      );

    case 'empty':
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">Nothing here</div>
          <div className="wrapped-headline">No films logged in {label}.</div>
          <PeriodNav month={month} onStep={onStep} />
        </div>
      );

    case 'totals':
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">You watched</div>
          <div className="wrapped-big-num">{data.count}</div>
          <div className="wrapped-sub">{data.count === 1 ? 'film' : 'films'}</div>
          <div className="wrapped-line">
            that's <strong>{fmtRuntime(data.total_runtime_minutes)}</strong> in the dark
          </div>
        </div>
      );

    case 'films':
      return (
        <div className="wrapped-card wrapped-card-wide">
          <div className="wrapped-eyebrow">The lineup</div>
          <PosterWall films={data.films} />
        </div>
      );

    case 'genres':
      return <RankCard eyebrow="Your top genres" items={data.genres} />;

    case 'directors':
      return <RankCard eyebrow="On repeat" title="Top directors" items={data.top_directors} />;

    case 'theaters':
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">Your home theatre</div>
          <div className="wrapped-headline">{data.theaters[0].name}</div>
          <div className="wrapped-sub">
            {data.theaters[0].count} {data.theaters[0].count === 1 ? 'visit' : 'visits'}
          </div>
          {data.theaters.length > 1 && (
            <ul className="wrapped-rank">
              {data.theaters.slice(1, 5).map((t) => (
                <li key={t.name}>
                  <span>{t.name}</span>
                  <span className="wrapped-rank-count">{String(t.count).padStart(2, '0')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'formats': {
      const fmax = Math.max(...data.formats.map((f) => f.count));
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">How you saw them</div>
          <div className="wrapped-formats">
            {data.formats.slice(0, 6).map((f) => (
              <div key={f.name} className="wrapped-format">
                <div className="wrapped-format-head">
                  <span>{f.name}</span>
                  <span className="wrapped-rank-count">{f.count}</span>
                </div>
                <div className="wrapped-format-bar">
                  <div
                    className="wrapped-format-fill"
                    style={{ width: `${(f.count / fmax) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'ratings':
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">Your taste</div>
          <div className="wrapped-big-num">{data.average_rating ?? '—'}</div>
          <div className="wrapped-sub">average ★</div>
          {s.five_star_count > 0 && (
            <div className="wrapped-line">
              <strong>{s.five_star_count}</strong> five-star{' '}
              {s.five_star_count === 1 ? 'film' : 'films'}
            </div>
          )}
          {data.top_rated?.length > 0 && <PosterWall films={data.top_rated} />}
        </div>
      );

    case 'super':
      return (
        <div className="wrapped-card">
          <div className="wrapped-eyebrow">For the record</div>
          {s.busiest_day && s.busiest_day.count >= 2 && (
            <div className="wrapped-line">
              <strong>{featureLabel(s.busiest_day.count)}</strong> on{' '}
              <strong>{fmtDate(s.busiest_day.date)}</strong>
            </div>
          )}
          {s.longest_film && (
            <div className="wrapped-line">
              Longest sit: <strong>{s.longest_film.title}</strong> —{' '}
              {fmtRuntime(s.longest_film.runtime_minutes)}
            </div>
          )}
          {s.longest_film?.poster_url && (
            <div className="wrapped-poster-single">
              <img src={s.longest_film.poster_url} alt={s.longest_film.title} loading="lazy" />
            </div>
          )}
        </div>
      );

    case 'outro':
      return (
        <div className="wrapped-card wrapped-cover">
          <div className="wrapped-eyebrow">{label}</div>
          <div className="wrapped-headline">That's a wrap.</div>
        </div>
      );

    default:
      return null;
  }
}

function PosterWall({ films }) {
  return (
    <div className="wrapped-film-wall">
      {films.map((f) => (
        <div key={f.id} className="wrapped-poster" title={f.title}>
          {f.poster_url ? (
            <img src={f.poster_url} alt={f.title} loading="lazy" />
          ) : (
            <div className="wrapped-poster-blank">{f.title.slice(0, 2).toUpperCase()}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function RankCard({ eyebrow, title, items }) {
  return (
    <div className="wrapped-card">
      <div className="wrapped-eyebrow">{eyebrow}</div>
      {title && <div className="wrapped-sub">{title}</div>}
      <ol className="wrapped-rank wrapped-rank-ordered">
        {items.slice(0, 5).map((it) => (
          <li key={it.name}>
            <span>{it.name}</span>
            <span className="wrapped-rank-count">{String(it.count).padStart(2, '0')}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PeriodNav({ month, onStep }) {
  return (
    <div className="wrapped-period-nav">
      <button type="button" onClick={() => onStep(-1)} aria-label="Earlier month">
        ‹
      </button>
      <span>{monthLabel(month)}</span>
      <button type="button" onClick={() => onStep(1)} aria-label="Later month">
        ›
      </button>
    </div>
  );
}

function featureLabel(n) {
  if (n === 2) return 'Double feature';
  if (n === 3) return 'Triple feature';
  return `${n} films in one day`;
}

function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTH_NAMES_LONG[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}
