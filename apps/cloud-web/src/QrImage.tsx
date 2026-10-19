import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code drawn in the browser (no network): owner-key login, ntfy subscription. */
export function QrImage({ text, alt }: { text: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(text, { width: 640, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return <div className="qr">{src ? <img src={src} alt={alt} /> : <span className="hint">QR…</span>}</div>;
}
