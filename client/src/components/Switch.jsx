// iOS-style toggle shared by the settings sheets.
export default function Switch({ on, onClick, label }) {
  return (
    <button
      type="button"
      className={`fed-toggle ${on ? '' : 'off'}`}
      role="switch"
      aria-checked={on}
      onClick={onClick}
      aria-label={label}
    />
  );
}
