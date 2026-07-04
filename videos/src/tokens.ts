/**
 * Brand tokens for the video system — mirrored from
 * website/src/styles/tokens.css (dark theme) and website/src/brand/yantra.ts
 * so every frame is unmistakably alchemy.
 */
export const t = {
  // ground (dark theme)
  bg: "#14110d",
  bgElev1: "#221e18",
  bgElev2: "#2a251d",
  fg1: "#faf6ec",
  fg2: "#e2d7bc",
  fg4: "#85714f",
  hairline: "rgba(250, 246, 236, 0.08)",
  hairline2: "rgba(250, 246, 236, 0.14)",
  accent: "#7a9a5e",
  accentBright: "#b3d188",
  accentDeep: "#5c7a3e",
  success: "#8fb15e",
  danger: "#e06c5b",

  // code palette (tokens.css --alc-code-*)
  code: {
    keyword: "#d4f26a",
    string: "#ffe38a",
    fn: "#ffb968",
    comment: "#b3a27a",
    variable: "#faf5e3",
    literal: "#ff9a6b",
    punct: "#a89572",
  },

  // type (site stacks with safe fallbacks; no webfont loading in v1)
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif:
    '"Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Brand mark geometry — verbatim from website/src/brand/yantra.ts. */
export const YANTRA = {
  viewBox: "0 0 24 24",
  trianglePath: "M12 21.5 L3.7272 7.25 L20.2728 7.25 Z",
  circle: { cx: 12, cy: 12, r: 9.5 },
  dot: { cx: 12, cy: 12, r: 1.1 },
} as const;
