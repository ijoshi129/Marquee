import { useState } from 'react';
import { api } from '../api';

const where = (t) => [t.city, t.state].filter(Boolean).join(', ');

// Home theatre plus the others you follow. Search is by place, because that is
// how the showtimes source finds theatres: a ZIP, or a city and state.
export default function TheatrePicker({ theatres, current, onClose, onSave, onSelect }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const { home, saved } = theatres;
  const visited = theatres.visited || [];
  const mine = [home, ...saved].filter(Boolean);
  const has = (id) => mine.some((t) => t.id === id);
  const fromDiary = visited.filter((t) => !has(t.id));
  const visits = (id) => {
    const v = visited.find((t) => t.id === id);
    return v ? `${v.visits} ${v.visits === 1 ? 'visit' : 'visits'}` : null;
  };

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResults(await api.npSearchTheatres(q.trim()));
    } catch (ex) {
      setResults(null);
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(next, select) {
    setErr(null);
    try {
      await onSave(next, select);
    } catch (ex) {
      setErr(ex.message);
    }
  }

  const slim = (t) => ({ id: t.id, name: t.name, city: t.city, state: t.state });
  // The first theatre added becomes home; after that, new ones join the list.
  const add = (t) => (home ? save({ home, saved: [...saved, slim(t)] }, t.id) : save({ home: slim(t), saved }, t.id));
  const makeHome = (t) => save({ home: slim(t), saved: [home, ...saved.filter((s) => s.id !== t.id)].filter(Boolean) });
  const remove = (t) => save({ home, saved: saved.filter((s) => s.id !== t.id) }, current === t.id && home ? home.id : undefined);

  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div
        className="fmenu-card theatre-card"
        role="dialog"
        aria-modal="true"
        aria-label="Theatres"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fmenu-grab" />
        <div className="notif-head">
          <span className="picker-title" style={{ margin: 0 }}>Theatres</span>
          <button type="button" className="notif-action" onClick={onClose}>
            Done
          </button>
        </div>

        {mine.map((t) => {
          const isHome = home && t.id === home.id;
          return (
            <div key={t.id} className={`theatre-row ${current === t.id ? 'is-current' : ''}`}>
              <button type="button" className="theatre-main" onClick={() => onSelect(t.id)}>
                <span className="theatre-name">{t.name}</span>
                <span className="theatre-sub">
                  {[where(t), isHome ? 'Home' : null, visits(t.id)].filter(Boolean).join(' · ')}
                </span>
              </button>
              {!isHome && (
                <span className="theatre-actions">
                  <button type="button" className="notif-action" onClick={() => makeHome(t)}>
                    Make home
                  </button>
                  <button type="button" className="notif-action danger" onClick={() => remove(t)} aria-label={`Remove ${t.name}`}>
                    Remove
                  </button>
                </span>
              )}
            </div>
          );
        })}

        {fromDiary.length > 0 && <div className="theatre-section">From your diary</div>}
        {fromDiary.map((t) => (
          <div key={t.id} className={`theatre-row ${current === t.id ? 'is-current' : ''}`}>
            <button type="button" className="theatre-main" onClick={() => onSelect(t.id)}>
              <span className="theatre-name">{t.name}</span>
              <span className="theatre-sub">{[where(t), visits(t.id)].filter(Boolean).join(' · ')}</span>
            </button>
            <span className="theatre-actions">
              <button type="button" className="notif-action" onClick={() => makeHome(t)}>
                Make home
              </button>
            </span>
          </div>
        ))}

        <form className="theatre-search" onSubmit={search}>
          <input
            className="input-naked"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ZIP, or city and state (Austin, TX)"
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="search"
            aria-label="Find AMC theatres near"
          />
          <button type="submit" className="theatre-find" disabled={busy || !q.trim()}>
            {busy ? 'Looking…' : 'Find'}
          </button>
        </form>

        {err && <div className="error-banner">{err}</div>}

        {results && results.length === 0 && <div className="theatre-none">No AMC theatres near there.</div>}
        {results &&
          results.map((t) => (
            <div key={t.id} className="theatre-row">
              <div className="theatre-main is-static">
                <span className="theatre-name">{t.name}</span>
                <span className="theatre-sub">
                  {[t.address, where(t)].filter(Boolean).join(', ')}
                  {t.distance_miles != null ? ` · ${t.distance_miles} mi` : ''}
                </span>
              </div>
              <span className="theatre-actions">
                {has(t.id) || visited.some((v) => v.id === t.id) ? (
                  <span className="theatre-added">{has(t.id) ? 'Added' : 'In your diary'}</span>
                ) : (
                  <button type="button" className="theatre-add" onClick={() => add(t)}>
                    {home ? 'Add' : 'Set as home'}
                  </button>
                )}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
