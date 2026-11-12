import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtAgo } from './FriendsView';

export function statusHeadline(s) {
  if (!s) return 'Checking…';
  if (s.failing) return s.failing === 1 ? '1 job is failing' : `${s.failing} jobs are failing`;
  if (s.warnings) return s.warnings === 1 ? '1 thing needs a look' : `${s.warnings} things need a look`;
  return 'Everything is running';
}

function when(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The line under a job's name: what is wrong if anything is, otherwise what it
// last did.
function subline(j) {
  if (j.problem) return j.problem;
  if (!j.summary) return j.level === 'idle' ? 'Has not run yet' : j.schedule;
  return j.summary_at ? `${j.summary} ${fmtAgo(j.summary_at)}` : j.summary;
}

function aside(j) {
  if (j.level === 'off') return 'Off';
  if (!j.last_run_at) return 'Waiting';
  return fmtAgo(j.last_run_at);
}

// One row per background job. Opened from the bell, and by the alert that fires
// when a job has been failing for a day.
export default function StatusSheet({ onClose, focus }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(focus || null);

  useEffect(() => {
    const load = () =>
      api
        .status()
        .then((d) => {
          setData(d);
          setErr(null);
        })
        .catch((e) => setErr(e.message));
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div
        className="fmenu-card status-card"
        role="dialog"
        aria-modal="true"
        aria-label="Status"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fmenu-grab" />
        <div className="notif-head">
          <span className="picker-title" style={{ margin: 0 }}>Status</span>
          <button type="button" className="notif-action" onClick={onClose}>
            Done
          </button>
        </div>

        <div className={`status-banner ${data ? data.overall : 'idle'}`}>
          <span className="status-dot" aria-hidden="true" />
          <span className="status-banner-text">{err ? 'Could not load status' : statusHeadline(data)}</span>
        </div>

        {data &&
          // Jobs that are switched off sink to the bottom as single lines, so
          // the ones doing work are not spread out between them.
          [...data.jobs.filter((j) => j.level !== 'off'), ...data.jobs.filter((j) => j.level === 'off')].map((j) => {
            const expanded = open === j.key;
            return (
              <div key={j.key} className={`status-item ${j.level}`}>
                <button
                  type="button"
                  className="status-main"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : j.key)}
                >
                  <span className="status-dot" aria-hidden="true" />
                  <span className="status-text">
                    <span className="status-name">{j.name}</span>
                    {(j.level !== 'off' || expanded) && <span className="status-sub">{subline(j)}</span>}
                  </span>
                  <span className="status-aside">{aside(j)}</span>
                </button>
                {expanded && (
                  <dl className="status-detail">
                    <div>
                      <dt>Runs</dt>
                      <dd>{j.schedule}</dd>
                    </div>
                    <div>
                      <dt>Last success</dt>
                      <dd>{when(j.last_ok_at) || 'Not yet'}</dd>
                    </div>
                    {j.failing_since && (
                      <div>
                        <dt>Failing since</dt>
                        <dd>{when(j.failing_since)}</dd>
                      </div>
                    )}
                    {j.last_error && (
                      <div>
                        <dt>Last error</dt>
                        <dd>
                          {j.last_error}
                          <span className="status-detail-when">{when(j.last_error_at)}</span>
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
