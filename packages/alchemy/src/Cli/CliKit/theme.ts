export const theme = {
  color: {
    /**
     * Brand terracotta — the yantra bindu (see website/src/brand/yantra.ts,
     * dark-theme `dot`). Marks brand identity: the logo dot, the wordmark
     * bullet, active-profile markers. Never used for errors — that is
     * `danger`'s job.
     */
    brand: "#e28a5b",
    accent: "#acd17b",
    accentBright: "#c5e49b",
    accentMuted: "#587044",
    success: "#9acb69",
    warning: "#efb85a",
    danger: "#e1735b",
    info: "#75bfd0",
    /** Reserved for non-text decoration (borders, gutter bars, idle glyphs). Muted TEXT uses `tone="muted"`. */
    muted: "#8f887c",
    surface: "#36332e",
    onSurface: "#f5f0e6",
    onAccent: "#14110d",
    /** High-emphasis foreground text (headings, command names). */
    emphasis: "#f5f0e6",
  },
  glyph: {
    section: "●",
    active: "›",
    success: "✓",
    warning: "!",
    error: "×",
    info: "•",
    pointer: "›",
    selected: "◆",
    unselected: "·",
    checked: "✓",
    unchecked: "·",
    add: "+",
    edit: "✎",
    refresh: "↻",
    delete: "−",
    replace: "↔",
    run: "▶",
    bar: "┊",
    mask: "•",
    bullet: "·",
    overflowUp: "↑",
    overflowDown: "↓",
  },
  /**
   * Key-hint labels for KeyBar footers. Resolve through `useKeyGlyphs()`
   * (components/Environment.tsx) so ASCII terminals get readable fallbacks
   * instead of mojibake.
   */
  keyHint: {
    enter: "↩",
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
  section: "@",
  active: ">",
  success: "+",
  warning: "!",
  error: "x",
  info: "i",
  pointer: ">",
  selected: "*",
  unselected: ".",
  checked: "x",
  unchecked: ".",
  add: "+",
  edit: "~",
  refresh: "r",
  delete: "-",
  replace: "~",
  run: ">",
  bar: ":",
  mask: "*",
  bullet: ".",
  overflowUp: "^",
  overflowDown: "v",
};

export const glyphsFor = (unicode: boolean) =>
  unicode ? theme.glyph : asciiGlyphs;

export type StatusVariant = "info" | "success" | "warning" | "error";

export const statusColor = (variant: StatusVariant): string =>
  variant === "error" ? theme.color.danger : theme.color[variant];
