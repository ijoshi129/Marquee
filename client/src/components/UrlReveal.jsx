import { useState } from 'react';
import QrCode from './QrCode';

// Shown-once capability URL: QR to scan, the raw URL, and a copy button.
export default function UrlReveal({ url, label }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="friends-form">
      {label && <span className="friends-label">{label}</span>}
      <div className="qr-wrap"><QrCode value={url} /></div>
      <textarea className="friends-textarea" rows={2} readOnly value={url} />
      <button type="button" className="friends-primary" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy URL'}
      </button>
    </div>
  );
}
