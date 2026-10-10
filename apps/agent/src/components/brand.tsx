import clsx from "clsx";

/** The Tatvam mark: a point held inside a rhombus, drawn on the accent tile. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={clsx("brand-mark", className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="9" className="brand-mark__tile" />
      <path
        d="M16 7.5 24.5 16 16 24.5 7.5 16Z"
        fill="none"
        className="brand-mark__glyph"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="2.6" className="brand-mark__dot" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <BrandMark size={26} />
      <span className="wordmark__text">Tatvam</span>
    </span>
  );
}
