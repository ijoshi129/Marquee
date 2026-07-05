import { useState } from 'react';

// Bump this string whenever the SECTIONS below change. Existing users will
// see the card again on next launch when their stored version doesn't match.
const WHATS_NEW_VERSION = '2.1';
const STORAGE_KEY = `marquee.whatsNew.v${WHATS_NEW_VERSION}`;

// Newest release first. Each release keeps its own sections so older notes stay
// visible under their version tag rather than being overwritten.
const RELEASES = [
  {
    version: '2.1',
    sections: [
      {
        title: 'Connecting is now just a URL swap',
        items: [
          'Adding a friend gives you a secret URL to text them — or show it as a QR code to scan; paste the one they send back and you’re connected. No invite codes, no expiry windows, no VPN between you.',
          'Each friend gets their own URL, so you can cut one off — or rotate a leaked link — without touching anyone else. Tap a friend in Manage friends for their connection details and controls.',
        ],
      },
      {
        title: 'Coming up, up top',
        items: [
          'Friends’ upcoming reservations now live in their own rail at the top of the Friends tab — tap a poster for details and the shared comment thread. The feed below starts at today.',
        ],
      },
      {
        title: 'Friend bookings',
        items: [
          'Get a heads-up when a friend books a showing — and if it matches one of yours, it arrives as a “seeing it together” alert instead.',
        ],
      },
      {
        title: 'Alerts via ntfy',
        items: [
          'Notifications can now reach any device through ntfy — tap the gear in the bell panel, point it at ntfy.sh or your own server, and pick which alerts to send.',
          'Tapping a comment alert now jumps straight to that film’s conversation.',
        ],
      },
      {
        title: 'Simpler under the hood',
        items: [
          'Connections no longer get stuck in a “disconnected” state — if a friend’s URL stops working, the app says so and keeps trying until you paste a fresh one.',
        ],
      },
    ],
  },
  {
    version: '2.0',
    sections: [
      {
        title: 'Friends',
        items: [
          'Marquee can now connect to a friend’s Marquee — pair once with an invite code and you’ll each see what the other is watching. There’s no middleman; the two instances talk straight to each other.',
          'A new Friends tab gathers their activity into a single feed.',
        ],
      },
      {
        title: 'Seeing it together',
        items: [
          'When you and a friend have booked the same showtime, it shows up as one card — with a comment thread you both share.',
          'Once a film starts, friends headed to that showing show as “Watching now”.',
        ],
      },
      {
        title: 'Recommendations',
        items: [
          'Send a film to a friend and it lands in their watchlist with a “Recommended by you” badge — and the other way around.',
        ],
      },
      {
        title: 'Taste-match',
        items: [
          'Open a friend’s profile to see how often your ratings agree and which films you’ve both seen.',
        ],
      },
      {
        title: 'Notifications',
        items: [
          'A bell for recommendations, comments, and “seeing it together” alerts — mark them read, dismiss, or clear.',
          'On an installed iPhone, these can arrive as push notifications.',
        ],
      },
      {
        title: 'Yours stays yours',
        items: [
          'Sharing is off until you turn it on, and a passcode keeps your diary private even when a friend can reach your instance.',
          'Choose exactly what friends see, and mark any single entry private so it never leaves your Marquee.',
        ],
      },
    ],
  },
  {
    version: '1.5',
    sections: [
      {
        title: 'A-List by month',
        items: [
          'The A-List membership editor now goes month by month, not just year by year — open it from “Edit A-List membership” under the In Review header.',
          'Turn off the months you weren’t a member and films from those months drop out of your savings, so a partial year counts only the months it should.',
        ],
      },
      {
        title: 'Tap any stat for the full story',
        items: [
          'Every number in the In Review overview now opens a detail sheet — A-List savings (what you paid vs. what tickets were worth), films, runtime, ratings distribution, and your full genre ranking.',
          'Tap any figure inside for a plain-English note on what it means.',
        ],
      },
      {
        title: 'Showtimes',
        items: [
          'Upcoming films in Now Playing show their release date right on the poster.',
          'A booked reservation now wears its showtime on the card — date and time, not just “Upcoming”.',
        ],
      },
      {
        title: 'Screen Unseen',
        items: [
          'Mystery screenings stay a mystery — the title and any “Identify?” prompt stay hidden until a couple hours after showtime, so nothing spoils what you’re about to see.',
        ],
      },
      {
        title: 'Filters that show their work',
        items: [
          'Tap a director’s name and the filter panel opens to show exactly who you’re filtering by — a chip you can tap to clear, so it’s never a mystery why the grid shrank.',
        ],
      },
      {
        title: 'Jump from Five-Star Picks',
        items: [
          'Tap any poster in Five-Star Picks to open that film’s details, straight from your year in review.',
        ],
      },
    ],
  },
  {
    version: '1.4',
    sections: [
      {
        title: 'Fixes',
        items: [
          'A film you reserved and then cancelled no longer shows as “Seen” in Now Playing — you can add it back to your watchlist.',
        ],
      },
    ],
  },
  {
    version: '1.3',
    sections: [
      {
        title: 'A-List by year',
        items: [
          'Mark which years you actually had A-List — a small toggle tucked into the In Review header.',
          'Years you weren’t a member drop out of your savings, so an early year with a film or two no longer drags down the all-time total.',
        ],
      },
      {
        title: 'Polish',
        items: [
          'Five-Star Picks shows one tile per film, even when you rated it five stars on more than one visit.',
          'Long titles no longer stretch a poster out of line.',
        ],
      },
    ],
  },
  {
    version: '1.2',
    sections: [
      {
        title: 'Watchlist',
        items: [
          'A new Watchlist tab for films to catch later — search to add, or pull from a Now Playing feed.',
          'Tap the ✓ on a poster to log it as watched; the ✕ drops it.',
          'A reservation or walk-up for a listed film clears it automatically.',
        ],
      },
      {
        title: 'Wrapped',
        items: [
          'A full-screen monthly recap — tap any month in the In Review chart.',
          'It surfaces on its own in the last days of the month, then tucks into a chip.',
        ],
      },
      {
        title: 'A-List value',
        items: [
          'See what your tickets would have cost against the flat A-List fee — in the overview and in Wrapped.',
          'Premium formats (IMAX, Dolby, RealD 3D) count for a little more.',
        ],
      },
      {
        title: 'Details',
        items: [
          'Rewatch badges — “2nd watch” on the poster, plus an On Repeat card in Wrapped.',
          'The overview stats now follow the year you pick in In Review.',
          'Anniversary and re-release titles match the original film, and matches favour the year you saw it.',
        ],
      },
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
        {RELEASES.map((rel) => (
          <div key={rel.version} className="whats-new-release">
            <div className="whats-new-version">v{rel.version}</div>
            {rel.sections.map((s) => (
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
