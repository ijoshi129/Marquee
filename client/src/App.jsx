import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import StatsBar from './components/StatsBar';
import WatchList from './components/WatchList';
import AddWatchModal from './components/AddWatchModal';
import EditWatchModal from './components/EditWatchModal';
import SearchBar from './components/SearchBar';
import Notifications from './components/Notifications';
import Backdrop from './components/Backdrop';
import WhatsNew from './components/WhatsNew';
import WrappedStory from './components/WrappedStory';
import WrappedPrompt from './components/WrappedPrompt';
import WatchlistView from './components/WatchlistView';
import FriendsView from './components/FriendsView';
import NotificationsBell from './components/NotificationsBell';
import FriendsMenu from './components/FriendsMenu';
import AddFriendModal from './components/AddFriendModal';
import ManageFriendsModal from './components/ManageFriendsModal';
import SharingSettingsModal from './components/SharingSettingsModal';
import Unlock from './components/Unlock';

const DEFAULT_STATUS_KEY = 'active';
const CURRENT_YEAR = new Date().getUTCFullYear();

// Map the single-select chip key to the comma-list the server expects.
function statusKeyToParam(key) {
  if (key === 'active') return 'watched,pending';
  return key;
}

export default function App() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [wrapped, setWrapped] = useState(null);
  const [wrappedPrompt, setWrappedPrompt] = useState(null);
  const [wrappedAutoMonth, setWrappedAutoMonth] = useState(null);
  const [view, setView] = useState('diary');
  const [refreshKey, setRefreshKey] = useState(0);
  // null = still checking; true = show unlock gate; false = unlocked/no lock.
  const [locked, setLocked] = useState(null);
  const [friendsMenu, setFriendsMenu] = useState(false);
  const [addFriend, setAddFriend] = useState(false);
  const [manageFriends, setManageFriends] = useState(false);
  const [sharing, setSharing] = useState(false);

  const [q, setQ] = useState('');
  const [statusKey, setStatusKey] = useState(DEFAULT_STATUS_KEY);
  const [sortKey, setSortKey] = useState('date:desc');
  const [genre, setGenre] = useState(null);
  const [director, setDirector] = useState(null);
  const [tag, setTag] = useState(null);
  const [minRating, setMinRating] = useState(null);
  // null = "All time" view (grid spans every year). YIR's prev/next steps
  // control this; typing in the search bar silently overrides to all-time.
  const [year, setYear] = useState(CURRENT_YEAR);

  // Scroll anchor for filter clicks — clicking a director/genre in YIR pulls
  // the page down to the SearchBar so the user lands on the filtered results,
  // not the top of the page.
  const filterAnchorRef = useRef(null);
  const scrollToFilteredResults = useCallback(() => {
    filterAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [sort, dir] = sortKey.split(':');
      const params = {
        limit: 200,
        sort,
        dir,
        status: statusKeyToParam(statusKey),
      };
      if (q) params.q = q;
      if (genre) params.genre = genre;
      if (director) params.director = director;
      if (tag) params.tag = tag;
      if (minRating) params.min_rating = minRating;
      // Apply year scope only when not searching. Search silently spans all
      // years so a user can find an old film without having to step the year.
      // include_pending=1 lets pending rows escape the year filter — your
      // upcoming reservations show on the active view regardless of year.
      if (year !== null && !q.trim()) {
        params.from = `${year}-01-01`;
        params.to = `${year + 1}-01-01`;
        params.include_pending = 1;
      }
      const rows = await api.listWatches(params);
      setWatches(rows);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [q, statusKey, sortKey, genre, director, tag, minRating, year]);

  // Click a genre (in YIR Top Genres or in the search-suggest dropdown) →
  // set the precise genre filter rather than a fuzzy text search. Year scope
  // is intentionally preserved so the user stays within the year they were
  // exploring.
  const filterByGenre = useCallback((name) => {
    setQ('');
    setStatusKey('active');
    setGenre(name);
    setDirector(null);
    setTag(null);
    setMinRating(null);
    scrollToFilteredResults();
  }, []);

  // Same shape as filterByGenre — preserves the selected year so clicking a
  // director in YIR shows that director's films within the year currently
  // in view, not all-time.
  const filterByDirector = useCallback((name) => {
    setQ('');
    setStatusKey('active');
    setGenre(null);
    setDirector(name);
    setTag(null);
    setMinRating(null);
    scrollToFilteredResults();
  }, []);

  const openMonthWrapped = useCallback((month) => {
    setWrapped({ kind: 'month', month });
  }, []);

  const openWatchById = useCallback(async (id) => {
    try {
      const w = await api.getWatch(id);
      setEditing(w);
    } catch {}
  }, []);

  // In the last 4 days of a month, surface that month's Wrapped — without
  // nagging. Stage per month in localStorage: absent → auto-open the story
  // once; 'shown' → show the side prompt; 'min' → show the minimized chip.
  // Only the current month is ever surfaced, so it clears when the month rolls.
  useEffect(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    if (now.getDate() < daysInMonth - 3) return;
    const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
    let stage = null;
    try {
      stage = localStorage.getItem(`marquee.wrapped.${ym}`);
    } catch {}
    if (!stage) {
      try {
        localStorage.setItem(`marquee.wrapped.${ym}`, 'shown');
      } catch {}
      setWrappedAutoMonth(ym);
      setWrapped({ kind: 'month', month: ym });
    } else {
      setWrappedPrompt(ym);
    }
  }, []);

  // Closing the auto-opened story drops to the side prompt for the same month;
  // a manually opened month (autoMonth null) just closes.
  const closeWrapped = useCallback(() => {
    setWrapped(null);
    setWrappedAutoMonth((am) => {
      if (am) setWrappedPrompt(am);
      return null;
    });
  }, []);

  const openWrappedFromPrompt = useCallback((month) => {
    setWrapped({ kind: 'month', month });
  }, []);

  // Decide on load whether the instance is locked and this device needs to
  // unlock. Until resolved we render nothing, so we never flash the diary.
  useEffect(() => {
    let alive = true;
    api
      .authStatus()
      .then((s) => alive && setLocked(s.required && !s.unlocked))
      .catch(() => alive && setLocked(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (locked === false) load();
  }, [load, locked]);

  function handleCreated(watch) {
    setAdding(false);
    setRefreshKey((k) => k + 1);
    load();
  }

  function handleUpdated(watch) {
    if (editing && editing.id === watch.id) setEditing(watch);
    setRefreshKey((k) => k + 1);
    // Re-fetch so server-side filters (status, search, period) are reapplied —
    // a row whose new status no longer matches the current filter should drop out.
    load();
  }

  function handleDeleted(id) {
    setEditing(null);
    setRefreshKey((k) => k + 1);
    load();
  }

  // Pick a backdrop poster: prefer the row currently being edited, otherwise
  // the most recent watched film with artwork.
  const featuredPoster = useMemo(() => {
    if (editing?.tmdb?.poster_url) return editing.tmdb.poster_url;
    const row = watches.find((w) => w.tmdb?.poster_url);
    return row?.tmdb?.poster_url || null;
  }, [editing, watches]);

  if (locked === null) return null;
  if (locked) return <Unlock onUnlocked={() => setLocked(false)} />;

  return (
    <div className="app">
      <Backdrop posterUrl={featuredPoster} intensity="ambient" />

      <header className="topbar">
        <div className="wordmark">
          <h1 className="wordmark-name">Marquee</h1>
          <span className="wordmark-tag">Cinema Diary</span>
        </div>
        <nav className="topnav">
          <button
            type="button"
            className={`topnav-tab ${view === 'diary' ? 'is-on' : ''}`}
            onClick={() => setView('diary')}
          >
            Diary
          </button>
          <button
            type="button"
            className={`topnav-tab ${view === 'watchlist' ? 'is-on' : ''}`}
            onClick={() => setView('watchlist')}
          >
            Watchlist
          </button>
          <button
            type="button"
            className={`topnav-tab ${view === 'friends' ? 'is-on' : ''}`}
            onClick={() => setView('friends')}
          >
            Friends
          </button>
          <NotificationsBell onOpen={() => setView('friends')} />
          {view === 'friends' && (
            <button
              type="button"
              className="friends-cog"
              onClick={() => setFriendsMenu(true)}
              aria-label="Friends settings"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              </svg>
            </button>
          )}
        </nav>
      </header>

      <main>
        {view === 'friends' ? (
          <FriendsView onAddFriend={() => setAddFriend(true)} />
        ) : view === 'watchlist' ? (
          <WatchlistView
            onWatched={() => {
              setRefreshKey((k) => k + 1);
              load();
            }}
          />
        ) : (
          <>
            <Notifications
              refreshKey={refreshKey}
              onWatchUpdated={handleUpdated}
              onSelectWatch={setEditing}
            />
            <StatsBar
              refreshKey={refreshKey}
              year={year}
              onYearChange={setYear}
              onDirectorClick={filterByDirector}
              onGenreClick={filterByGenre}
              onMonthClick={openMonthWrapped}
              onPickClick={openWatchById}
            />

            <div ref={filterAnchorRef}>
              <SearchBar
                q={q}
                onQ={setQ}
                statusKey={statusKey}
                onStatusKey={setStatusKey}
                sortKey={sortKey}
                onSortKey={setSortKey}
                genre={genre}
                onGenre={setGenre}
                director={director}
                onDirector={setDirector}
                tag={tag}
                onTag={setTag}
                minRating={minRating}
                onMinRating={setMinRating}
                onGenreClick={filterByGenre}
              />
            </div>

            {err && <div className="error-banner">{err}</div>}

            {loading && watches.length === 0 ? (
              <div className="empty">
                <div className="empty-glyph">◌</div>
                <div className="empty-headline">Lights up…</div>
              </div>
            ) : (
              <WatchList watches={watches} onSelect={setEditing} onWatchUpdated={handleUpdated} />
            )}
          </>
        )}
      </main>

      {view === 'diary' && (
        <button className="fab" onClick={() => setAdding(true)} aria-label="Add watch">
          +
        </button>
      )}

      <WhatsNew />

      {adding && <AddWatchModal onClose={() => setAdding(false)} onCreated={handleCreated} />}
      {editing && (
        <EditWatchModal
          key={editing.id}
          watch={editing}
          onClose={() => setEditing(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onFilterDirector={filterByDirector}
        />
      )}

      {wrappedPrompt && !wrapped && (
        <WrappedPrompt month={wrappedPrompt} onOpen={openWrappedFromPrompt} />
      )}

      {wrapped && <WrappedStory period={wrapped} onClose={closeWrapped} />}

      {friendsMenu && (
        <FriendsMenu
          onClose={() => setFriendsMenu(false)}
          onAdd={() => {
            setFriendsMenu(false);
            setAddFriend(true);
          }}
          onManage={() => {
            setFriendsMenu(false);
            setManageFriends(true);
          }}
          onSharing={() => {
            setFriendsMenu(false);
            setSharing(true);
          }}
        />
      )}
      {addFriend && <AddFriendModal onClose={() => setAddFriend(false)} />}
      {manageFriends && <ManageFriendsModal onClose={() => setManageFriends(false)} />}
      {sharing && <SharingSettingsModal onClose={() => setSharing(false)} />}
    </div>
  );
}
