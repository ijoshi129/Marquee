import { useEffect, useState } from 'react';
import { api } from '../api';
import SeatMapSheet from './SeatMapSheet';

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

// The seat map for one diary film: the live map when the showing is still to
// come, otherwise the auditorium's layout with where you sat.
export default function BookingSeatSheet({ watch, title, onClose, onOpenNowPlaying }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .npBookingSeats(watch.id)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [watch.id]);

  const when = watch.showtime ? [fmtDate(watch.showtime), fmtTime(watch.showtime)].filter(Boolean).join(' · ') : null;

  if (data && data.mode === 'live') {
    return (
      <SeatMapSheet
        film={data.film}
        group={{ format: data.format }}
        showtime={data.showtime}
        theatre={data.theatre}
        mine={data.mine}
        onClose={onClose}
        extra={
          onOpenNowPlaying && (
            <button
              type="button"
              className="seat-np-link"
              onClick={() => onOpenNowPlaying({ theatre: data.theatre.id, date: data.date })}
            >
              Open in Now Playing
            </button>
          )
        }
      />
    );
  }

  if (data && data.mode === 'layout') {
    return (
      <SeatMapSheet
        film={{ title }}
        layout={data.layout}
        subtitle={[when, `Screen ${data.layout.auditorium}`].filter(Boolean).join(' · ')}
        theatre={data.theatre}
        mine={data.mine}
        note="The auditorium’s layout, from a showing there now. Who else was in that night isn’t kept."
        onClose={onClose}
      />
    );
  }

  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div className="fmenu-card seat-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="fmenu-grab" />
        <div className="notif-head">
          <span className="seat-head">
            <span className="seat-title">{title}</span>
            {when && <span className="seat-sub">{when}</span>}
          </span>
          <button type="button" className="notif-action" onClick={onClose}>
            Done
          </button>
        </div>
        {err ? (
          <div className="error-banner">{err}</div>
        ) : data ? (
          <div className="seat-loading">{data.reason}</div>
        ) : (
          <div className="seat-loading">Finding your seat…</div>
        )}
      </div>
    </div>
  );
}
