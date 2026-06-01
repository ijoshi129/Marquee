import { useState } from 'react';
import { MONTH_NAMES_LONG } from '../format';

function readMinimized(month) {
  try {
    return localStorage.getItem(`marquee.wrapped.${month}`) === 'min';
  } catch {
    return false;
  }
}

export default function WrappedPrompt({ month, onOpen }) {
  const label = MONTH_NAMES_LONG[parseInt(month.slice(5, 7), 10) - 1];
  // Seeded from storage so the chip/card state survives the remount that
  // happens whenever the story opens and closes over the prompt.
  const [minimized, setMinimized] = useState(() => readMinimized(month));

  function minimize() {
    setMinimized(true);
    try {
      localStorage.setItem(`marquee.wrapped.${month}`, 'min');
    } catch {}
  }

  if (minimized) {
    return (
      <button
        type="button"
        className="wrapped-chip"
        onClick={() => onOpen(month)}
        aria-label={`${label} Wrapped`}
      >
        ✦ {label}
      </button>
    );
  }

  return (
    <aside className="wrapped-prompt" role="dialog" aria-label={`${label} Wrapped`}>
      <button
        type="button"
        className="wrapped-prompt-close"
        onClick={minimize}
        aria-label="Minimize"
      >
        ✕
      </button>
      <button type="button" className="wrapped-prompt-body" onClick={() => onOpen(month)}>
        <span className="wrapped-prompt-eyebrow">✦ Wrapped</span>
        <span className="wrapped-prompt-title">{label} in review</span>
        <span className="wrapped-prompt-cta">Tap to view →</span>
      </button>
    </aside>
  );
}
