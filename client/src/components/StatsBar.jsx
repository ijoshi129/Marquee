import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtMoney, fmtRuntime, MONTH_NAMES } from '../format';

const CURRENT_YEAR = new Date().getUTCFullYear();

export default function StatsBar({
  refreshKey,
  year,
  onYearChange,
  onDirectorClick,
  onGenreClick,
  onMonthClick,
}) {
  const [allStats, setAllStats] = useState(null);
  const [yearStats, setYearStats] = useState(null);
  const [err, setErr] = useState(null);

  // Year stops: every year with at least one watch (plus the current calendar
  // year), then 'All time' (null) on the far right. Stepping right from the
  // current year lands on null = the all-time view.
  const yearStops = (() => {
    const ys = new Set(
      (allStats?.monthly_breakdown || [])
        .filter((m) => m.count > 0)
        .map((m) => parseInt(m.month.slice(0, 4), 10))
    );
    ys.add(CURRENT_YEAR);
    return [...[...ys].sort((a, b) => a - b), null];
  })();
  const yIdx = yearStops.indexOf(year);
  const prevStop = yIdx > 0 ? yearStops[yIdx - 1] : undefined;
  const nextStop =
    yIdx >= 0 && yIdx < yearStops.length - 1 ? yearStops[yIdx + 1] : undefined;

  useEffect(() => {
    api.stats({ period: 'all' }).then(setAllStats).catch((e) => setErr(e.message));
  }, [refreshKey]);

  useEffect(() => {
    if (year === null) {
      setYearStats(null);
      return;
    }
    api
      .stats({ period: 'year', month: `${year}-01` })
      .then(setYearStats)
      .catch((e) => setErr(e.message));
  }, [year, refreshKey]);

  // When viewing 'All time', the YIR body uses the all-stats payload — same
  // data the overview row already reads. Saves a redundant fetch.
  const yirStats = year === null ? allStats : yearStats;

  return (
    <section className="stats">
      {err && <div className="error-banner">Stats failed: {err}</div>}

      <div className="overview">
        <Overview label="Films Logged" value={allStats?.count} />
        <Overview label="Total Runtime" value={allStats ? fmtRuntime(allStats.total_runtime_minutes) : '—'} />
        <Overview label="Mean Rating" value={allStats?.average_rating ?? '—'} />
        <Overview
          label="A-List Saved"
          value={allStats?.value ? fmtMoney(allStats.value.savings) : '—'}
        />
        <Overview
          label="Signature Genre"
          value={allStats?.genres?.[0]?.name || '—'}
          isText
        />
      </div>

      {yirStats && (
        <YearInReview
          stats={yirStats}
          year={year}
          onPrev={prevStop !== undefined ? () => onYearChange(prevStop) : null}
          onNext={nextStop !== undefined ? () => onYearChange(nextStop) : null}
          onDirectorClick={onDirectorClick}
          onGenreClick={onGenreClick}
          onMonthClick={onMonthClick}
        />
      )}
    </section>
  );
}

function Overview({ label, value, isText }) {
  return (
    <div className="overview-cell">
      <div className={`overview-value ${isText ? 'is-text' : ''}`}>
        {value === undefined ? <span className="skel" /> : value}
      </div>
      <div className="overview-label">{label}</div>
    </div>
  );
}

function YearInReview({ stats, year, onPrev, onNext, onDirectorClick, onGenreClick, onMonthClick }) {
  const max = Math.max(1, ...(stats.monthly_breakdown || []).map((m) => m.count));
  const isEmpty = stats.count === 0;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('yir.collapsed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('yir.collapsed', collapsed ? '1' : '0');
    } catch {}
  }, [collapsed]);

  return (
    <div className="yir">
      <div className="yir-header">
        <button
          type="button"
          className="yir-arrow"
          onClick={onPrev || undefined}
          disabled={!onPrev}
          aria-label="Previous year"
        >
          ←
        </button>

        <button
          type="button"
          className="yir-year-button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <span className="yir-eyebrow">In Review</span>
          <span className="yir-year">{year === null ? 'All time' : year}</span>
          <span className={`yir-chevron ${collapsed ? 'collapsed' : ''}`} aria-hidden="true">
            ▾
          </span>
        </button>

        <button
          type="button"
          className="yir-arrow"
          onClick={onNext || undefined}
          disabled={!onNext}
          aria-label="Next year"
        >
          →
        </button>
      </div>

      {collapsed ? null : isEmpty ? (
        <div className="yir-empty">
          {year === null ? 'No films logged yet.' : `No films logged in ${year}.`}
        </div>
      ) : (
        <div className="yir-body">
          {/* The pulse stats duplicate the top overview row when viewing the
              all-time view — same count / runtime / avg★. Hide it there. */}
          {year !== null && (
            <div className="yir-pulse">
              <div className="yir-pulse-stat">
                <span className="num">{stats.count}</span>
                <span className="lbl">films</span>
              </div>
              <div className="yir-pulse-stat">
                <span className="num">{fmtRuntime(stats.total_runtime_minutes)}</span>
                <span className="lbl">in the dark</span>
              </div>
              <div className="yir-pulse-stat">
                <span className="num">{stats.average_rating ?? '—'}</span>
                <span className="lbl">avg ★</span>
              </div>
            </div>
          )}

          <YIRSection title="Cadence">
            <CadenceChart breakdown={stats.monthly_breakdown} max={max} onMonthClick={onMonthClick} />
          </YIRSection>

          <div className="yir-cols">
            {stats.genres?.length > 0 && (
              <YIRSection title="Genres">
                <RankList items={stats.genres} onItemClick={onGenreClick} />
              </YIRSection>
            )}
            {stats.top_directors?.length > 0 && (
              <YIRSection title="Directors">
                <RankList items={stats.top_directors} onItemClick={onDirectorClick} />
              </YIRSection>
            )}
            {stats.theaters?.length > 0 && (
              <YIRSection title="Theatres">
                <RankList items={stats.theaters} />
              </YIRSection>
            )}
          </div>

          {stats.top_rated?.length > 0 && (
            <YIRSection title="Five-Star Picks">
              <div className="yir-poster-row">
                {stats.top_rated.map((r) => (
                  <div key={r.id} className="yir-poster" title={r.title}>
                    {r.poster_url ? (
                      <img src={r.poster_url} alt={r.title} loading="lazy" />
                    ) : (
                      <div className="yir-poster-blank">
                        {r.title.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="yir-poster-cap">{r.title}</div>
                  </div>
                ))}
              </div>
            </YIRSection>
          )}
        </div>
      )}
    </div>
  );
}

function CadenceChart({ breakdown, max, onMonthClick }) {
  // Group monthly entries by year. Server returns entries Jan-aligned for
  // period='all', so each year's chunk starts in January (zero-counts for
  // unlogged months at the start of the earliest year, trailing empties for
  // unfinished current year).
  const grouped = [];
  for (const m of breakdown) {
    const yr = m.month.slice(0, 4);
    const last = grouped[grouped.length - 1];
    if (!last || last[0] !== yr) grouped.push([yr, [m]]);
    else last[1].push(m);
  }
  // Hide year rows with zero watches across all months. With multiple
  // populated years separated by an empty year, the empty row would just be
  // dead space — user explicitly wants only years with activity.
  const byYear = grouped.filter(([, months]) => months.some((m) => m.count > 0));
  const showYearLabels = byYear.length > 1;
  return (
    <div className="yir-bars-stack">
      {byYear.map(([yr, months]) => (
        <div
          key={yr}
          className={`yir-bars-row ${showYearLabels ? 'with-year' : ''}`}
        >
          {showYearLabels && <div className="yir-bars-year">{yr}</div>}
          <div className="yir-bars">
            {months.map((m) => {
              const idx = parseInt(m.month.slice(5, 7), 10) - 1;
              const tall = m.count === max && max > 0;
              return (
                <button
                  type="button"
                  key={m.month}
                  className={`yir-bar-cell ${onMonthClick ? 'clickable' : ''}`}
                  title={`${MONTH_NAMES[idx]} ${yr}: ${m.count}`}
                  onClick={onMonthClick ? () => onMonthClick(m.month) : undefined}
                  disabled={!onMonthClick}
                >
                  <div className="yir-bar-axis">
                    <div
                      className={`yir-bar-fill ${tall ? 'peak' : ''}`}
                      style={{ height: `${(m.count / max) * 100}%` }}
                    />
                  </div>
                  <div className="yir-bar-month">{MONTH_NAMES[idx]}</div>
                  <div className="yir-bar-count">{m.count || ''}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function YIRSection({ title, children }) {
  return (
    <div className="yir-section">
      <div className="yir-section-eyebrow">{title}</div>
      {children}
    </div>
  );
}

function RankList({ items, onItemClick }) {
  return (
    <ul className="rank-list">
      {items.slice(0, 8).map((it, i) => (
        <li key={it.name + i}>
          {onItemClick ? (
            <button
              type="button"
              className="rank-button"
              onClick={() => onItemClick(it.name)}
            >
              <span className="rank-name">{it.name}</span>
              <span className="rank-count">{String(it.count).padStart(2, '0')}</span>
            </button>
          ) : (
            <div className="rank-static">
              <span className="rank-name">{it.name}</span>
              <span className="rank-count">{String(it.count).padStart(2, '0')}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
