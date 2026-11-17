import { useState } from 'react';
import QrCode from './QrCode';

const KINDS = {
  web: { tab: 'Web link', hint: 'Works for any friend.' },
  tailcat: {
    tab: 'Tailcat link',
    hint: 'For a friend with Tailcat turned on. Neither of you needs a public address.',
  },
};

// Shown-once capability URL: QR to scan, the raw URL, and a copy button. With
// both a web and a Tailcat URL, a switch picks which one to show.
export default function UrlReveal({ url, urls, label }) {
  const kinds = urls ? Object.keys(KINDS).filter((k) => urls[k]) : [];
  const [kind, setKind] = useState(kinds[0] || null);
  const [copied, setCopied] = useState(false);
  const shown = kind ? urls[kind] : url;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="friends-form">
      {label && <span className="friends-label">{label}</span>}
      {kinds.length > 1 && (
        <div className="link-kind" role="tablist">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`link-kind-tab${kind === k ? ' is-active' : ''}`}
              onClick={() => { setKind(k); setCopied(false); }}
            >
              {KINDS[k].tab}
            </button>
          ))}
        </div>
      )}
      {kinds.length > 1 && <span className="friends-label">{KINDS[kind].hint}</span>}
      <div className="qr-wrap"><QrCode value={shown} /></div>
      <textarea className="friends-textarea" rows={kind === 'tailcat' ? 4 : 2} readOnly value={shown} />
      <button type="button" className="friends-primary" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy URL'}
      </button>
    </div>
  );
}
