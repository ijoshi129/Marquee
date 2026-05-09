export default function StarRating({ value, onChange, size = 22, readOnly = false }) {
  const stars = [1, 2, 3, 4, 5];
  return (
    <div
      className="stars"
      style={{ '--star-size': `${size}px` }}
      role={readOnly ? undefined : 'radiogroup'}
      aria-label="Rating"
    >
      {stars.map((n) => {
        const active = value && n <= value;
        return (
          <button
            key={n}
            type="button"
            className={`star ${active ? 'on' : ''}`}
            onClick={() => !readOnly && onChange?.(value === n ? null : n)}
            disabled={readOnly}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            aria-checked={readOnly ? undefined : active ? 'true' : 'false'}
            role={readOnly ? undefined : 'radio'}
          >
            <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
              <path
                d="M12 2.4l2.94 6.36 6.92.74-5.18 4.7 1.49 6.83L12 17.6l-6.17 3.43 1.49-6.83-5.18-4.7 6.92-.74L12 2.4z"
                fill={active ? 'currentColor' : 'transparent'}
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
