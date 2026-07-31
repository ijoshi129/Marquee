// Bottom-sheet opened by the Friends settings cog. Holds the federation
// controls: add a friend, manage connections, and choose what you share.

const ICON = {
  stroke: 'currentColor',
  fill: 'none',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
};

function AddIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.3 2.5-5.6 5.5-5.6s5.5 2.3 5.5 5.6" />
      <path d="M18.5 8v5M16 10.5h5" />
    </svg>
  );
}
function PeopleIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="3" />
      <path d="M2.8 19c0-3 2.5-5 5.7-5s5.7 2 5.7 5" />
      <path d="M15.5 6.4a3 3 0 0 1 0 5.6" />
      <path d="M16.8 14.2c2.3.5 3.9 2.3 3.9 4.8" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export default function FriendsMenu({ onClose, onAdd, onManage, onSharing }) {
  return (
    <div className="fmenu-backdrop" onClick={onClose}>
      <div className="fmenu-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="fmenu-grab" />
        <button type="button" className="fmenu-row" onClick={onAdd}>
          <span className="fmenu-ico"><AddIcon /></span>
          <span className="fmenu-text">
            <span className="fmenu-t">Add a friend</span>
            <span className="fmenu-h">Swap URLs to connect</span>
          </span>
          <span className="fmenu-chev">›</span>
        </button>
        <button type="button" className="fmenu-row" onClick={onManage}>
          <span className="fmenu-ico"><PeopleIcon /></span>
          <span className="fmenu-text">
            <span className="fmenu-t">Manage friends</span>
            <span className="fmenu-h">See connections or remove a friend</span>
          </span>
          <span className="fmenu-chev">›</span>
        </button>
        <button type="button" className="fmenu-row" onClick={onSharing}>
          <span className="fmenu-ico"><EyeIcon /></span>
          <span className="fmenu-text">
            <span className="fmenu-t">Sharing</span>
            <span className="fmenu-h">Your name and what friends see</span>
          </span>
          <span className="fmenu-chev">›</span>
        </button>
      </div>
    </div>
  );
}
