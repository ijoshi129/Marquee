import { useState } from 'react';

// Bump this string whenever the SECTIONS below change. Existing users will
// see the card again on next launch when their stored version doesn't match.
const WHATS_NEW_VERSION = '0.3';
const STORAGE_KEY = `marquee.whatsNew.v${WHATS_NEW_VERSION}`;

const SECTIONS = [
  {
    title: 'Bulletin',
    items: [
      'Undo any action — I went, No-show, I cancelled it, dismiss — for 8 seconds.',
      'Edit card flips status both ways: Watched ↔ Cancelled ↔ No-show.',
    ],
  },
  {
    title: 'Self-healing',
    items: [
      'Unresolved Unseens and missed TMDB matches retry on their own every 6 hours.',
      'Each row stops after 8 tries — no infinite hammering on permanently stuck titles.',
    ],
  },
  {
    title: 'Browsing',
    items: [
      'All time now sits on the right end of the YIR year selector — step past the current year to reach it.',
      'Click a director or genre in YIR to filter the grid; year scope is preserved.',
    ],
  },
  {
    title: 'Tags',
    items: [
      'IMAX, Dolby, RealD 3D, Screen Unseen — auto-extracted from AMC emails.',
      'Click the Tags bar in the edit card for a palette, or type a custom tag.',
      'Filter the grid by tag from the Filters panel.',
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
