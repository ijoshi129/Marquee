import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

// Renders a value as a QR code. White quiet zone kept so scanners cope with
// the app's dark background.
export default function QrCode({ value, size = 180 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) {
      QRCode.toCanvas(ref.current, value, { width: size, margin: 2 }).catch(() => {});
    }
  }, [value, size]);
  return <canvas ref={ref} className="qr-canvas" aria-label="QR code" />;
}
