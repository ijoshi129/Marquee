import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Renders a value as a QR code — as an SVG data URI rather than a canvas so it
// can't silently fail on browsers with quirky canvas support. White quiet zone
// kept so scanners cope with the app's dark background.
export default function QrCode({ value, size = 180 }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!value) return;
    QRCode.toString(value, { type: 'svg', margin: 2 })
      .then((svg) => {
        if (alive) setSrc(`data:image/svg+xml;base64,${btoa(svg)}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [value]);
  if (!src) return null;
  return <img className="qr-canvas" src={src} width={size} height={size} alt="QR code" />;
}
