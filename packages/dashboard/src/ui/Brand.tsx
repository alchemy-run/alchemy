/**
 * Alchemy brand mark — a Sri-Yantra-style downward water triangle
 * inscribed in a circle, with the centroid dot (bindu).
 *
 * Geometry is copied from website/src/brand/yantra.ts (viewBox 24×24;
 * circle cx=12 cy=12 r=9.5; triangle vertices exactly on the circle) —
 * KEEP IN SYNC. The dashboard is a standalone published package, so it
 * must not import across packages.
 *
 * Stroke follows `currentColor` (set text color on the parent or via
 * className); the bindu fills `--alc-yantra-dot`, which tokens.css flips
 * to terracotta in dark mode.
 */
export const YANTRA_VIEWBOX = "0 0 24 24";

/** Inscribed equilateral triangle (apex down), vertices on the circle. */
export const YANTRA_TRIANGLE_PATH = "M12 21.5 L3.7272 7.25 L20.2728 7.25 Z";

export function Yantra({
  size = 18,
  strokeWidth = 1.4,
  className,
}: {
  /** Pixel size of the rendered SVG (square). Default 18. */
  size?: number;
  /** Stroke width in viewBox units. Default 1.4 (legible at small sizes). */
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={YANTRA_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      // Round joins are critical: at a 60° vertex a mitered join projects
      // past the geometric tip by ~1 stroke width and pokes through the
      // circle. Round keeps the tips flush with the circle's outer edge.
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx={12} cy={12} r={9.5} />
      <path d={YANTRA_TRIANGLE_PATH} />
      <circle
        cx={12}
        cy={12}
        r={1.1}
        fill="var(--alc-yantra-dot)"
        stroke="none"
      />
    </svg>
  );
}
