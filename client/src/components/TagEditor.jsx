import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Built-in palette of common AMC formats. Surfaced alongside whatever tags
// are actually in use so the user can pick a brand-new tag like "IMAX" the
// first time without having to type it. Niche formats (D-Box, Prime, XD,
// MX4D) intentionally aren't here — they only surface if AMC's email
// extracted one for a real watch.
const KNOWN_FORMATS = [
  'IMAX',
  'Dolby Cinema',
  'Dolby Atmos',
  'RealD 3D',
  '3D',
  '2D',
  'Screen Unseen',
  'Scream Unseen',
];

// Chip-style tag editor reused by Add + Edit modals. Tags render as pills
// with a ✕. Clicking the bar opens a palette of available tags (in-use +
// built-in known formats) as clickable bubbles. Typing filters the palette;
// Enter or comma commits as a custom new tag. Backspace on an empty input
// removes the last chip.
export default function TagEditor({ tags, onChange }) {
  const [text, setText] = useState('');
  const [allTags, setAllTags] = useState(null);
  const [open, setOpen] = useState(false);
  const blurTimeout = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api
      .tags()
      .then((rows) => setAllTags((rows || []).map((r) => r.name)))
      .catch(() => setAllTags([]));
  }, []);

  function add(raw) {
    const v = (raw ?? text).trim();
    if (!v) return;
    if (tags.some((t) => t.toLowerCase() === v.toLowerCase())) {
      setText('');
      return;
    }
    onChange([...tags, v]);
    setText('');
  }

  function remove(t) {
    onChange(tags.filter((x) => x !== t));
  }

  function onKey(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && text === '' && tags.length > 0) {
      remove(tags[tags.length - 1]);
    }
  }

  function openPalette() {
    clearTimeout(blurTimeout.current);
    setOpen(true);
    inputRef.current?.focus();
  }

  // Click on a chip's ✕ shouldn't bubble up and re-open / focus the input
  // right after we've removed the chip.
  function stopBubble(e) {
    e.stopPropagation();
  }

  const term = text.trim().toLowerCase();
  const selectedLower = new Set(tags.map((t) => t.toLowerCase()));
  const palette = Array.from(
    new Set([...(allTags || []), ...KNOWN_FORMATS])
  )
    .filter((name) => !selectedLower.has(name.toLowerCase()))
    .filter((name) => !term || name.toLowerCase().includes(term))
    .sort((a, b) => a.localeCompare(b));

  return (
    <div className="tag-editor">
      <div className="tag-chip-row" onClick={openPalette}>
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            <span>{t}</span>
            <button
              type="button"
              className="tag-chip-remove"
              onClick={(e) => {
                stopBubble(e);
                remove(t);
              }}
              aria-label={`Remove ${t}`}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tag-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => {
            clearTimeout(blurTimeout.current);
            setOpen(true);
          }}
          onBlur={() => {
            blurTimeout.current = setTimeout(() => setOpen(false), 150);
          }}
          placeholder={tags.length === 0 ? 'Add tag…' : ''}
        />
      </div>
      {open && palette.length > 0 && (
        <div className="tag-palette">
          {palette.map((name) => (
            <button
              key={name}
              type="button"
              className="tag-palette-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
