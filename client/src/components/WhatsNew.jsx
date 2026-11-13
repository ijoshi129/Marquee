import { useState } from 'react';

// Bump this string whenever the SECTIONS below change. Existing users will
// see the card again on next launch when their stored version doesn't match.
const WHATS_NEW_VERSION = '2.7';
const STORAGE_KEY = `marquee.whatsNew.v${WHATS_NEW_VERSION}`;

// Newest release first. Each release keeps its own sections so older notes stay
// visible under their version tag rather than being overwritten.
const RELEASES = [
  {
    version: '2.7',
    sections: [
      {
        title: 'A Status page',
        items: [
          'Marquee does a lot in the background: reading your AMC emails, naming Screen Unseens, matching films, syncing friends, taking backups. Until now there was no way to tell whether any of it had stopped. Open the bell and tap Status at the bottom to see each job, when it last ran, and whether it worked.',
          'Green is fine, amber needs a look (a film with no match, a friend who can’t be reached), red is failing. Tap any row for its schedule and the last error.',
        ],
      },
      {
        title: 'It tells you when something breaks',
        items: [
          'If a job has been failing or silent for over a day, you get a notification that opens straight to it. One per outage, so a long one doesn’t nag.',
        ],
      },
    ],
  },
  {
    version: '2.6',
    sections: [
      {
        title: 'Insider Screenings get their poster',
        items: [
          'AMC sells early showings as the film’s title plus “Insider Screenings”, which found nothing when Marquee looked the film up. It now searches on the film’s own title. A reservation that had already given up needs Assign movie in the film sheet.',
        ],
      },
    ],
  },
  {
    version: '2.5',
    sections: [
      {
        title: 'Screen Unseens stop slipping through',
        items: [
          'Reddit closed off the search Marquee used to find each week’s reveal thread, so new Unseens had stopped being named. It now finds the thread a sturdier way, with two fallbacks behind it.',
          'Some reveals are posted days after the screening, and Marquee used to give up looking after two. It now keeps checking for about three weeks.',
        ],
      },
      {
        title: 'A nudge when a title can’t be found',
        items: [
          'If an Unseen is still unnamed after a couple of days, you’ll get a notification asking what you saw. Tap it to open the film and pick the title yourself. Marquee keeps checking in the background either way.',
        ],
      },
    ],
  },
  {
    version: '2.4',
    sections: [
      {
        title: 'Screen Unseen reveals work again',
        items: [
          'Reddit stopped serving its pages to logged-out visitors, which quietly broke the lookup that names your Screen and Scream Unseens. They were staying blank with no explanation. Marquee now reads the megathread a different way and fills them in as before.',
          'A separate slip meant reveals posted from August onward weren’t being read at all, so a couple of recent Unseens stayed blank longer than they should have. Both are fixed.',
        ],
      },
    ],
  },
  {
    version: '2.3',
    sections: [
      {
        title: 'One card when you went together',
        items: [
          'A film several of you saw at the same showing is now a single entry ("You, Alice & Bob saw") instead of the same poster three times down the feed. Shared screenings span the full width, since they don’t belong to any one person.',
          'The conversation merges too: one thread per screening rather than a separate one on each person’s copy.',
        ],
      },
      {
        title: 'Unseens stand out in the feed',
        items: [
          'A film that came from a Screen Unseen now carries its tag in the Friends feed, so you can tell at a glance who went in blind, on your films and your friends’ alike. Scream Unseen keeps its red.',
        ],
      },
      {
        title: 'A tidier feed',
        items: [
          'Coming up now shows a date for anything more than a week out, instead of a weekday that could mean any of three weeks.',
          'Films nobody has rated yet no longer say so. The line just isn’t there.',
        ],
      },
      {
        title: 'Change the name friends see',
        items: [
          'Your instance name is now editable under Friends → Sharing. It used to be fixed the first time Marquee started up, so a name set later never took. Now you can just type a new one and friends pick it up on their next sync.',
        ],
      },
    ],
  },
  {
    version: '2.2',
    sections: [
      {
        title: 'The Friends feed reads like a conversation',
        items: [
          'Everything you and your friends have seen now shares one timeline, newest at the bottom, grouped by day. Your films sit on the right, theirs on the left with their avatar, so a week of moviegoing reads top to bottom like a thread.',
          'Coming up stays pinned above it, so what’s booked never gets buried under what’s been seen.',
        ],
      },
      {
        title: 'Comments look like messages',
        items: [
          'Threads are chat bubbles now: your replies on the right, your friend’s on the left.',
          'Conversations about your own films live on the film itself. Open any film you’ve seen to catch up on what people said, and comment alerts take you straight there.',
        ],
      },
      {
        title: 'One paste connects you both ways',
        items: [
          'Paste a friend’s secret URL and yours travels back to them automatically. No more sending links in both directions and hoping they both land.',
          'If a connection breaks, pasting a fresh URL repairs both ends at once.',
        ],
      },
      {
        title: 'Easier updates',
        items: [
          'Marquee is now published as a ready-built image, so updating pulls it down instead of rebuilding from scratch. That’s quicker, and much lighter on small home servers.',
        ],
      },
    ],
  },
  {
    version: '2.1',
    sections: [
      {
        title: 'Connecting is now just a URL swap',
        items: [
          'Adding a friend gives you a secret URL to text them, or show it as a QR code to scan; paste the one they send back and you’re connected. No invite codes, no expiry windows, no VPN between you.',
          'Each friend gets their own URL, so you can cut one off (or rotate a leaked link) without touching anyone else. Tap a friend in Manage friends for their connection details and controls.',
        ],
      },
      {
        title: 'Coming up, up top',
        items: [
          'Friends’ upcoming reservations now live in their own rail at the top of the Friends tab. Tap a poster for details and the shared comment thread. The feed below starts at today.',
        ],
      },
      {
        title: 'Friend bookings',
        items: [
          'Get a heads-up when a friend books a showing. If it matches one of yours, it arrives as a “seeing it together” alert instead.',
        ],
      },
      {
        title: 'Alerts via ntfy',
        items: [
          'Notifications can now reach any device through ntfy. Tap the gear in the bell panel, point it at ntfy.sh or your own server, and pick which alerts to send.',
          'Tapping a comment alert now jumps straight to that film’s conversation.',
        ],
      },
      {
        title: 'Simpler under the hood',
        items: [
          'Connections no longer get stuck in a “disconnected” state. If a friend’s URL stops working, the app says so and keeps trying until you paste a fresh one.',
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
          'Marquee can now connect to a friend’s Marquee. Pair once with an invite code and you’ll each see what the other is watching. There’s no middleman; the two instances talk straight to each other.',
          'A new Friends tab gathers their activity into a single feed.',
        ],
      },
      {
        title: 'Seeing it together',
        items: [
          'When you and a friend have booked the same showtime, it shows up as one card, with a comment thread you both share.',
          'Once a film starts, friends headed to that showing show as “Watching now”.',
        ],
      },
      {
        title: 'Recommendations',
        items: [
          'Send a film to a friend and it lands in their watchlist with a “Recommended by you” badge, and the other way around.',
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
          'A bell for recommendations, comments, and “seeing it together” alerts. Mark them read, dismiss, or clear.',
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
          'The A-List membership editor now goes month by month, not just year by year. Open it from “Edit A-List membership” under the In Review header.',
          'Turn off the months you weren’t a member and films from those months drop out of your savings, so a partial year counts only the months it should.',
        ],
      },
      {
        title: 'Tap any stat for the full story',
        items: [
          'Every number in the In Review overview now opens a detail sheet: A-List savings (what you paid vs. what tickets were worth), films, runtime, ratings distribution, and your full genre ranking.',
          'Tap any figure inside for a plain-English note on what it means.',
        ],
      },
      {
        title: 'Showtimes',
        items: [
          'Upcoming films in Now Playing show their release date right on the poster.',
          'A booked reservation now wears its showtime on the card: date and time, not just “Upcoming”.',
        ],
      },
      {
        title: 'Screen Unseen',
        items: [
          'Mystery screenings stay a mystery. The title and any “Identify?” prompt stay hidden until a couple hours after showtime, so nothing spoils what you’re about to see.',
        ],
      },
      {
        title: 'Filters that show their work',
        items: [
          'Tap a director’s name and the filter panel opens to show exactly who you’re filtering by: a chip you can tap to clear, so it’s never a mystery why the grid shrank.',
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
          'A film you reserved and then cancelled no longer shows as “Seen” in Now Playing, so you can add it back to your watchlist.',
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
          'Mark which years you actually had A-List, with a small toggle tucked into the In Review header.',
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
          'A new Watchlist tab for films to catch later. Search to add, or pull from a Now Playing feed.',
          'Tap the ✓ on a poster to log it as watched; the ✕ drops it.',
          'A reservation or walk-up for a listed film clears it automatically.',
        ],
      },
      {
        title: 'Wrapped',
        items: [
          'A full-screen monthly recap. Tap any month in the In Review chart.',
          'It surfaces on its own in the last days of the month, then tucks into a chip.',
        ],
      },
      {
        title: 'A-List value',
        items: [
          'See what your tickets would have cost against the flat A-List fee, in the overview and in Wrapped.',
          'Premium formats (IMAX, Dolby, RealD 3D) count for a little more.',
        ],
      },
      {
        title: 'Details',
        items: [
          'Rewatch badges: “2nd watch” on the poster, plus an On Repeat card in Wrapped.',
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
