import { useState } from 'react';

// Bump this string whenever the SECTIONS below change. Existing users will
// see the card again on next launch when their stored version doesn't match.
const WHATS_NEW_VERSION = '0.2';
const STORAGE_KEY = `marquee.whatsNew.v${WHATS_NEW_VERSION}`;

const SECTIONS = [
  {
    title: 'Lifecycle',
    items: [
      'Past-showtime reservations auto-flip to Watched the day after — no more "Upcoming" badges lingering on old shows.',
      'If a thank-you email never arrives after 4 days, the bulletin asks "did you actually go?" with three buttons: I went · No-show · I cancelled it.',
      'Did-you-go prompts stay in the bulletin until you click one of the three — no auto-resolve.',
    ],
  },
  {
    title: 'Browsing',
    items: [
      'Main grid is now scoped to the selected year. Step ←/→ in the Year-in-Review header; left of the earliest year is "All time".',
      'Pending reservations always show regardless of which year you are viewing.',
      "Click a director's name in YIR → filter the grid to their films, year preserved.",
      'Click a genre in YIR → filter to it, year preserved.',
      'Clicking a filter smoothly scrolls to the filter row instead of jumping to the top.',
      'Search bar has a ✕ to clear in one tap; typing silently spans all years.',
    ],
  },
  {
    title: 'Tags',
    items: [
      'Every watch can carry presentation tags — IMAX, Dolby Cinema, RealD 3D, Screen Unseen, etc.',
      'Tags auto-extract from AMC emails (title suffixes + thank-you body badges).',
      'Click the Tags bar in the edit modal — a curated palette opens with click-to-add bubbles, or type to create a new custom tag.',
      'Filter the grid by tag from the Filters panel.',
      'Late thank-you emails (1-4 days after the show) now correctly attach to your reservation instead of creating duplicates.',
    ],
  },
  {
    title: 'Visual',
    items: [
      'Year-in-Review cadence on "All time" groups months into per-year rows with labels.',
      'Duplicate stats removed on "All time" (the overview row already covers them).',
      "Unseen rows without a resolved TMDB match now show AMC's actual Screen / Scream Unseen artwork.",
      'Setting a Screen/Scream Unseen tag on any watch triggers the right placeholder or banner.',
    ],
  },
];

function readState() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dismissed') return 'dismissed';
    if (v === 'collapsed') return 'collapsed';
  } catch {}
  return 'fresh';
}

export default function WhatsNew() {
  // 'fresh': user has never seen this version → show expanded card.
  // 'collapsed': user closed it once → show the bottom-left icon.
  // 'dismissed': user clicked "don't show again" → render nothing.
  const [persistent, setPersistent] = useState(readState);
  // Separate from persistent so re-opening from the icon doesn't reset storage.
  const [expanded, setExpanded] = useState(() => readState() === 'fresh');

  if (persistent === 'dismissed') return null;

  function close() {
    setExpanded(false);
    setPersistent('collapsed');
    try {
      localStorage.setItem(STORAGE_KEY, 'collapsed');
    } catch {}
  }

  function open() {
    setExpanded(true);
  }

  function dismissForever() {
    setExpanded(false);
    setPersistent('dismissed');
    try {
      localStorage.setItem(STORAGE_KEY, 'dismissed');
    } catch {}
  }

  if (!expanded) {
    return (
      <button
        className="whats-new-icon"
        type="button"
        onClick={open}
        aria-label="What's new in Marquee"
      >
        <span className="whats-new-icon-pulse" aria-hidden="true" />
        New
      </button>
    );
  }

  // "Don't show again" only surfaces on the re-opened view (after the user
  // has already closed once). The first-launch view has only close ✕.
  const showDontShowAgain = persistent === 'collapsed';

  return (
    <aside className="whats-new-card" role="dialog" aria-label="What's new">
      <button
        type="button"
        className="whats-new-close"
        onClick={close}
        aria-label="Close"
      >
        ✕
      </button>
      <header className="whats-new-head">
        <span className="whats-new-eyebrow">What's New</span>
        <h2 className="whats-new-title">Marquee v{WHATS_NEW_VERSION}</h2>
      </header>
      <div className="whats-new-body">
        {SECTIONS.map((s) => (
          <section key={s.title} className="whats-new-section">
            <div className="whats-new-section-title">{s.title}</div>
            <ul className="whats-new-list">
              {s.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {showDontShowAgain && (
        <footer className="whats-new-foot">
          <button
            type="button"
            className="whats-new-dismiss"
            onClick={dismissForever}
          >
            Don't show again
          </button>
        </footer>
      )}
    </aside>
  );
}
