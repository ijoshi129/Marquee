import { useEffect, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES } from '../format';

// Edit which years and months counted toward A-List. A month override wins over
// its year's flag; anything left untouched defaults to "had A-List". Off months
// drop out of the savings math entirely.
export default function AListMembershipModal({ breakdown, onClose, onChanged }) {
  const [membership, setMembership] = useState(null); // { years, months }
  const [expanded, setExpanded] = useState(() => new Set());
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.alistMembership().then(setMembership).catch((e) => setErr(e.message));
  }, []);

  // Years that actually have logged films, newest first, each carrying a
  // month -> film-count map so the grid can show where activity was.
  const years = (() => {
    const counts = new Map();
    for (const m of breakdown || []) {
      const yr = parseInt(m.month.slice(0, 4), 10);
      const mo = parseInt(m.month.slice(5, 7), 10);
      if (!counts.has(yr)) counts.set(yr, new Map());
      if (m.count > 0) counts.get(yr).set(mo, m.count);
    }
    return [...counts.entries()]
      .filter(([, mm]) => mm.size > 0)
      .map(([year, mm]) => ({ year, months: mm }))
      .sort((a, b) => b.year - a.year);
  })();

  const yearOn = (yr) => membership?.years?.[yr] !== false;
  const monthOn = (yr, mo) => {
    const key = `${yr}-${String(mo).padStart(2, '0')}`;
    if (membership?.months && key in membership.months) return membership.months[key];
    return yearOn(yr);
  };

  const toggleYear = async (yr) => {
    const next = !yearOn(yr);
    // The year flag is authoritative — drop any month overrides for it so the
    // whole year follows the toggle (the server clears them too).
    setMembership((m) => {
      const months = { ...m.months };
      for (const k of Object.keys(months)) {
        if (k.startsWith(`${yr}-`)) delete months[k];
      }
      return { ...m, years: { ...m.years, [yr]: next }, months };
    });
    try {
      await api.setAlistMembership(yr, next);
      onChanged?.();
    } catch (e) {
      setErr(e.message);
      api.alistMembership().then(setMembership).catch(() => {});
    }
  };

  const toggleMonth = async (yr, mo) => {
    const key = `${yr}-${String(mo).padStart(2, '0')}`;
    const next = !monthOn(yr, mo);
    setMembership((m) => ({ ...m, months: { ...m.months, [key]: next } }));
    try {
      await api.setAlistMembershipMonth(yr, mo, next);
      onChanged?.();
    } catch (e) {
      setErr(e.message);
      setMembership((m) => {
        const months = { ...m.months };
        delete months[key];
        return { ...m, months };
      });
    }
  };

  const toggleExpand = (yr) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(yr) ? n.delete(yr) : n.add(yr);
      return n;
    });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet alist-sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <header className="alist-modal-head">
          <h2 className="alist-modal-title">A-List membership</h2>
          <p className="alist-modal-sub">
            Turn off any year or month you weren&rsquo;t an A-Lister. Off months drop out of
            your savings.
          </p>
        </header>

        {err && <div className="error-banner">{err}</div>}

        {!membership ? (
          <div className="alist-modal-empty">Loading&hellip;</div>
        ) : years.length === 0 ? (
          <div className="alist-modal-empty">No films logged yet.</div>
        ) : (
          <ul className="alist-year-list">
            {years.map(({ year, months }) => {
              const on = yearOn(year);
              const isOpen = expanded.has(year);
              return (
                <li key={year} className="alist-year">
                  <div className="alist-year-row">
                    <button
                      type="button"
                      className="alist-year-toggle"
                      onClick={() => toggleExpand(year)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} months for ${year}`}
                    >
                      <span className={`alist-expand ${isOpen ? 'open' : ''}`} aria-hidden="true">
                        ▾
                      </span>
                      <span className="alist-year-name">{year}</span>
                    </button>
                    <Switch on={on} onClick={() => toggleYear(year)} label={`A-List in ${year}`} />
                  </div>

                  {isOpen && (
                    <div className="alist-month-grid">
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => {
                        const seen = months.get(mo) || 0;
                        const mon = monthOn(year, mo);
                        return (
                          <button
                            key={mo}
                            type="button"
                            className={`alist-month ${mon ? 'on' : 'off'} ${seen ? '' : 'is-empty'}`}
                            onClick={() => toggleMonth(year, mo)}
                            aria-pressed={mon}
                            title={`${MONTH_NAMES[mo - 1]} ${year}: ${seen} film${
                              seen === 1 ? '' : 's'
                            }`}
                          >
                            <span className="alist-month-name">{MONTH_NAMES[mo - 1]}</span>
                            <span className="alist-month-count">{seen || ''}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Switch({ on, onClick, label }) {
  return (
    <button
      type="button"
      className={`alist-switch ${on ? 'on' : 'off'}`}
      role="switch"
      aria-checked={on}
      onClick={onClick}
      aria-label={label}
    >
      <span className="alist-switch-track">
        <span className="alist-switch-thumb" />
      </span>
      <span className="alist-switch-state">{on ? 'yes' : 'no'}</span>
    </button>
  );
}
