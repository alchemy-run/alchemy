export const theme = {
  color: {
    /**
     * Brand terracotta — the yantra bindu (see website/src/brand/yantra.ts,
     * dark-theme `dot`). Marks brand identity: the logo dot, the wordmark
     * bullet, active-profile markers. Never used for errors — that is
     * `danger`'s job.
     */
    brand: "#d8835a",
    accent: "#a3c473",
    accentBright: "#b3d188",
    accentMuted: "#7a9a5e",
    success: "#8fb15e",
    warning: "#e8b04a",
    danger: "#d76a4e",
    info: "#6da4b4",
    /** Reserved for non-text decoration (borders, gutter bars, idle glyphs). Muted TEXT uses `tone="muted"`. */
    muted: "#85714f",
    surface: "#3a352c",
    onSurface: "#f5f0e6",
    onAccent: "#14110d",
    /** High-emphasis foreground text (headings, command names). */
    emphasis: "#f5f0e6",
  },
  glyph: {
    section: "▽",
    active: "◆",
    success: "✓",
    warning: "▲",
    error: "✖",
    info: "●",
    pointer: "❯",
    selected: "●",
    unselected: "○",
    checked: "◉",
    unchecked: "○",
    add: "✚",
    edit: "✎",
    refresh: "↻",
    delete: "−",
    replace: "↻",
    run: "▶",
    bar: "│",
    mask: "▪",
    bullet: "•",
    overflowUp: "↑",
    overflowDown: "↓",
  },
  /**
   * Key-hint labels for KeyBar footers. Resolve through `useKeyGlyphs()`
   * (components/Environment.tsx) so ASCII terminals get readable fallbacks
   * instead of mojibake.
   */
  keyHint: {
    enter: "↵",
    upDown: "↑/↓",
    leftRight: "←/→",
    escape: "esc",
    space: "space",
    tab: "tab",
    yesNo: "y/n",
  },
} as const;

export type KeyHint = { readonly [Key in keyof typeof theme.keyHint]: string };
export type GlyphName = keyof typeof theme.glyph;

export const asciiGlyphs: { readonly [Key in GlyphName]: string } = {
  section: "v",
  active: ">",
  success: "+",
  warning: "!",
  error: "x",
  info: "i",
  pointer: ">",
  selected: "*",
  unselected: "o",
  checked: "x",
  unchecked: "o",
  add: "+",
  edit: "~",
  refresh: "r",
  delete: "-",
  replace: "r",
  run: ">",
  bar: "|",
  mask: "*",
  bullet: "*",
  overflowUp: "^",
  overflowDown: "v",
};

export const glyphsFor = (unicode: boolean) =>
  unicode ? theme.glyph : asciiGlyphs;

export type StatusVariant = "info" | "success" | "warning" | "error";

export const statusColor = (variant: StatusVariant): string =>
  variant === "error" ? theme.color.danger : theme.color[variant];
