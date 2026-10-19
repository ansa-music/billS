import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code as crisp SVG: dark modules on white, with the quiet zone scanners need. */
export function QrCode({ value, size = 200, label }: { value: string; size?: number; label?: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { count: n + 8, path: d };
  }, [value]);
  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label ?? value}
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
