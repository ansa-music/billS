/**
 * «TS» monogram — the product mark (sidebar, top bar, boot screen, login).
 * Inline SVG so it needs no asset and renders the same everywhere: an espresso
 * tile with a crema-coloured «TS».
 */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <svg className={`brand-mark ${className}`.trim()} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ts-mark-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4a2c18" />
          <stop offset="1" stopColor="#1e120a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#ts-mark-bg)" />
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8.25" fill="none" stroke="#ffe2bf" strokeOpacity="0.18" strokeWidth="1.5" />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fontFamily="'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
        fontSize="14"
        fontWeight="800"
        letterSpacing="-0.5"
        fill="#f6d3a6"
      >
        TS
      </text>
    </svg>
  );
}
