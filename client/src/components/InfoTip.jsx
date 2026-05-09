import { useRef, useState } from 'react';

// Small ⓘ trigger that reveals an in-app tooltip on hover/focus.
// Auto-flips horizontal anchor when the bubble would clip the viewport.
export default function InfoTip({ children, label = 'More info' }) {
  const triggerRef = useRef(null);
  const [side, setSide] = useState('center'); // 'left' | 'center' | 'right'
  const BUBBLE_MAX = 260;
  const EDGE_PAD = 16;

  function probe() {
    const node = triggerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const half = BUBBLE_MAX / 2;
    const cx = rect.left + rect.width / 2;
    if (cx - half < EDGE_PAD) setSide('left');
    else if (cx + half > window.innerWidth - EDGE_PAD) setSide('right');
    else setSide('center');
  }

  return (
    <span
      className={`info-tip side-${side}`}
      onMouseEnter={probe}
      onFocus={probe}
    >
      <button
        ref={triggerRef}
        type="button"
        className="info-tip-trigger"
        aria-label={label}
        tabIndex={0}
      >
        ⓘ
      </button>
      <span className="info-tip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}
