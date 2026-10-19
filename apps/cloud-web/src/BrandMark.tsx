/**
 * Neutral «TS» monogram — the product mark (sidebar, top bar, boot screen,
 * login). Inline SVG so it needs no asset and renders the same everywhere;
 * the favicon in index.html is the same drawing.
 */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <svg className={`brand-mark ${className}`.trim()} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#14211b" />
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7.25" fill="none" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="1.5" />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
        fontSize="14"
        fontWeight="800"
        letterSpacing="-0.5"
        fill="#ffffff"
      >
        TS
      </text>
    </svg>
  );
}
