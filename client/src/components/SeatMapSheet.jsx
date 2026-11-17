import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

const REFRESH_MS = 45000;
const PAD = 26;
const SCREEN_H = 70;
const GUTTER = 46;

function money(n) {
  return `$${n.toFixed(2)}`;
}

// The auditorium for one showing: every seat where it sits, lit if it is still
// open. Refreshes while it is up, since seats go as you look at them.
export default function SeatMapSheet({ film, group, showtime, theatre, mine, watching, onWatch, onCounts, onClose, layout, subtitle: subtitleText, note, extra }) {
  const [map, setMap] = useState(null);
  const [err, setErr] = useState(null);
  const [zoom, setZoom] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchErr, setWatchErr] = useState(null);
  const mySeats = new Set(mine ? mine.seats || [] : []);

  function toggleWatch() {
    setWatchBusy(true);
    setWatchErr(null);
    onWatch(!watching)
      .catch((e) => setWatchErr(e.message))
      .finally(() => setWatchBusy(false));
  }

  useEffect(() => {
    if (layout) {
      setMap(layout);
      return undefined;
    }
    let alive = true;
    const load = () =>
      api
        .npSeatMap(showtime.hash)
        .then((m) => {
          if (!alive) return;
          setMap(m);
          setErr(null);
          onCounts?.({ available: m.available, total: m.total });
        })
        .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // onCounts is a fresh closure every render; the showing is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, showtime && showtime.hash]);

  const rows = useMemo(() => {
    if (!map) return [];
    const by = new Map();
    for (const s of map.seats) {
      // Wheelchair spaces are numbered WC1, WC2 and sit in a lettered row.
      if (!s.row || s.kind === 'wheelchair') continue;
      const r = by.get(s.row) || { row: s.row, y: 0, n: 0 };
      r.y += s.y + s.h / 2;
      r.n += 1;
      by.set(s.row, r);
    }
    return [...by.values()].map((r) => ({ row: r.row, y: r.y / r.n }));
  }, [map]);

  const subtitle =
    subtitleText ||
    [showtime && showtime.label, group && group.format, map && map.auditorium ? `Screen ${map.auditorium}` : null]
      .filter(Boolean)
      .join(' · ');
  const hasAccessible = map && map.seats.some((s) => s.kind !== 'standard');

  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div
        className="fmenu-card seat-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Seats for ${film.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fmenu-grab" />
        <div className="notif-head">
          <span className="seat-head">
            <span className="seat-title">{film.title}</span>
            <span className="seat-sub">{subtitle}</span>
          </span>
          <button type="button" className="notif-action" onClick={onClose}>
            Done
          </button>
        </div>

        {err && !map && (/not on sale/i.test(err) ? <div className="seat-loading">{err}.</div> : <div className="error-banner">{err}</div>)}
        {!map && !err && <div className="seat-loading">Finding seats…</div>}

        {map && (
          <>
            {!layout && <div className="seat-count">
              <span className="seat-count-n">{map.available}</span>
              <span className="seat-count-rest">
                of {map.total} seats open
                {theatre ? <span className="seat-count-where">{theatre.name}</span> : null}
              </span>
              <button type="button" className="seat-zoom" onClick={() => setZoom((z) => !z)}>
                {zoom ? 'Fit' : 'Zoom'}
              </button>
            </div>}

            <div className={`seat-scroll ${zoom ? 'is-zoomed' : ''}`}>
              <svg
                className="seat-svg"
                viewBox={`${-PAD - GUTTER} ${-SCREEN_H - PAD} ${map.width + 2 * PAD + GUTTER} ${map.height + SCREEN_H + 2 * PAD}`}
                role="img"
                aria-label={layout ? 'Auditorium layout' : `${map.available} of ${map.total} seats open`}
              >
                <path
                  className="seat-screen"
                  d={`M 0 ${-PAD - 14} Q ${map.width / 2} ${-PAD - 52} ${map.width} ${-PAD - 14}`}
                />
                <text className="seat-screen-label" x={map.width / 2} y={-PAD + 8} textAnchor="middle">
                  SCREEN
                </text>
                {rows.map((r) => (
                  <text key={r.row} className="seat-row" x={-GUTTER + 6} y={r.y} dominantBaseline="middle">
                    {r.row}
                  </text>
                ))}
                {map.seats.map((s) => (
                  <rect
                    key={s.id}
                    className={`seat ${mySeats.has(s.id) ? 'is-mine' : layout ? 'is-layout' : s.open ? 'is-open' : 'is-taken'} ${s.kind !== 'standard' ? `is-${s.kind}` : ''}`}
                    x={s.x + s.w * 0.08}
                    y={s.y + s.h * 0.08}
                    width={s.w * 0.84}
                    height={s.h * 0.84}
                    rx={Math.min(s.w, s.h) * 0.22}
                  >
                    <title>{`${s.id}${mySeats.has(s.id) ? ' (yours)' : layout || s.open ? '' : ' (taken)'}`}</title>
                  </rect>
                ))}
              </svg>
            </div>

            {layout ? (
              <div className="seat-legend">
                {mySeats.size > 0 && <span><i className="seat-key is-mine" /> Where you sat</span>}
              </div>
            ) : (
              <div className="seat-legend">
                <span><i className="seat-key is-open" /> Open</span>
                <span><i className="seat-key is-taken" /> Taken</span>
                {mySeats.size > 0 && <span><i className="seat-key is-mine" /> Yours</span>}
                {hasAccessible && <span><i className="seat-key is-open is-wheelchair" /> Wheelchair and companion</span>}
              </div>
            )}
            {layout && mySeats.size > 0 && !map.seats.some((x) => mySeats.has(x.id)) && (
              <div className="seat-stale">Seat {[...mySeats].join(', ')} is not on this layout. The auditorium may have changed since.</div>
            )}
            {note && <div className="seat-note">{note}</div>}

            {mine && !layout && (
              <div className="seat-mine">
                You&rsquo;re booked for this one
                {mine.seats?.length ? `: ${mine.seats.length > 1 ? 'seats' : 'seat'} ${mine.seats.join(', ')}` : ''}
                {mine.auditorium ? `, auditorium ${mine.auditorium}` : ''}.
              </div>
            )}

            {!mine && onWatch && (
              <div className="seat-watch">
                <button type="button" className={`seat-watch-btn ${watching ? 'is-on' : ''}`} onClick={toggleWatch} disabled={watchBusy}>
                  {watching ? 'Watching this showing' : 'Tell me when it fills up'}
                </button>
                <span className="seat-watch-note">
                  {watching ? 'You’ll hear when a quarter of the seats are left, and if it sells out. Tap to stop.' : 'A notification when a quarter of the seats are left, and if it sells out.'}
                </span>
                {watchErr && <span className="seat-stale">Could not save: {watchErr}</span>}
              </div>
            )}

            {extra}
            {map.prices && map.prices.length > 0 && (
              <div className="seat-prices">{map.prices.map((p) => `${p.label} ${money(p.price)}`).join(' · ')}</div>
            )}
            {err && <div className="seat-stale">Could not refresh: {err}</div>}
          </>
        )}
      </div>
    </div>
  );
}
