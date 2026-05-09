import { useEffect, useState } from 'react';
import { api } from '../api';

function fmtRuntime(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const CURRENT_YEAR = new Date().getUTCFullYear();
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function StatsBar({ refreshKey, onDirectorClick, onGenreClick }) {
  const [allStats, setAllStats] = useState(null);
  const [yearStats, setYearStats] = useState(null);
  const [year, setYear] = useState(CURRENT_YEAR);
  const [err, setErr] = useState(null);

  // Years with at least one watch, plus current calendar year.
  const populatedYears = (() => {
    const ys = new Set(
      (allStats?.monthly_breakdown || [])
        .filter((m) => m.count > 0)
        .map((m) => parseInt(m.month.slice(0, 4), 10))
    );
    ys.add(CURRENT_YEAR);
    return [...ys].sort((a, b) => a - b);
  })();
  const yIdx = populatedYears.indexOf(year);
  const prevYear = yIdx > 0 ? populatedYears[yIdx - 1] : null;
  const nextYear =
    yIdx >= 0 && yIdx < populatedYears.length - 1 ? populatedYears[yIdx + 1] : null;

  useEffect(() => {
    api.stats({ period: 'all' }).then(setAllStats).catch((e) => setErr(e.message));
  }, [refreshKey]);

  useEffect(() => {
    api
      .stats({ period: 'year', month: `${year}-01` })
      .then(setYearStats)
      .catch((e) => setErr(e.message));
  }, [year, refreshKey]);

  return (
    <section className="stats">
      {err && <div className="error-banner">Stats failed: {err}</div>}

      <div className="overview">
        <Overview label="Films Logged" value={allStats?.count} />
        <Overview label="Total Runtime" value={allStats ? fmtRuntime(allStats.total_runtime_minutes) : '—'} />
        <Overview label="Mean Rating" value={allStats?.average_rating ?? '—'} />
        <Overview
          label="Signature Genre"
          value={allStats?.genres?.[0]?.name || '—'}
          isText
        />
      </div>

      {yearStats && (
        <YearInReview
          stats={yearStats}
          year={year}
          onPrev={prevYear !== null ? () => setYear(prevYear) : null}
          onNext={nextYear !== null ? () => setYear(nextYear) : null}
          onDirectorClick={onDirectorClick}
          onGenreClick={onGenreClick}
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

function YearInReview({ stats, year, onPrev, onNext, onDirectorClick, onGenreClick }) {
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
          <span className="yir-year">{year}</span>
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
        <div className="yir-empty">No films logged in {year}.</div>
      ) : (
        <div className="yir-body">
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

          <YIRSection title="Cadence">
            <div className="yir-bars">
              {stats.monthly_breakdown.map((m) => {
                const idx = parseInt(m.month.slice(5, 7), 10) - 1;
                const tall = m.count === max && max > 0;
                return (
                  <div key={m.month} className="yir-bar-cell" title={`${MONTH_NAMES[idx]}: ${m.count}`}>
                    <div className="yir-bar-axis">
                      <div
                        className={`yir-bar-fill ${tall ? 'peak' : ''}`}
                        style={{ height: `${(m.count / max) * 100}%` }}
                      />
                    </div>
                    <div className="yir-bar-month">{MONTH_NAMES[idx]}</div>
                    <div className="yir-bar-count">{m.count || ''}</div>
                  </div>
                );
              })}
            </div>
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
