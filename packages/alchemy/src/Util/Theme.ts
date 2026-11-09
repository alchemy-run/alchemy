import type { Paint } from "@alchemy.run/sigil/color";

/**
 * Alchemy's palette is anchored in terracotta and green. The supporting
 * amber, olive, sage, and coral tones stay within that warm botanical range.
 */
const color = {
  brand: "#e28a5b",
  accent: "#9acb69",
  accentBright: "#c5df8c",
  accentMuted: "#60764b",
  success: "#9acb69",
  warning: "#efb85a",
  danger: "#d96f52",
  magenta: "#c084d6",
  info: "#b6c77a",
  sage: "#b8cf83",
  olive: "#9ea85e",
  coral: "#ef9a6a",
  muted: "#8f887c",
  diffAddBackground: "#263b2a",
  diffRemoveBackground: "#422a26",
  onAccent: "#14110d",
  emphasis: "#f5f0e6",
} as const;

export const theme = {
  color,
  space: {
    inline: 1,
    indent: 2,
    section: 1,
  },
  paint: {
    focus: color.brand,
    interactive: color.brand,
    info: color.info,
    success: color.success,
    warning: color.warning,
    error: color.danger,
  },
  glyph: {
    section: "\u25cf",
    /**
     * Marks the step currently being answered -- the same "active one" glyph
     * the profile tabs use. Deliberately not a chevron so the list cursor
     * (`pointer`) is the only chevron on screen.
     */
    active: "\u25c6",
    /** List cursor: the one focus glyph shared by every prompt and dashboard row. */
    pointer: "\u276f",
    success: "\u2713",
    warning: "!",
    error: "×",
    info: "\u2022",
    selected: "\u25c6",
    unselected: "·",
    checked: "\u2713",
    unchecked: "·",
    add: "+",
    adopt: "(+)",
    edit: "~",
    refresh: "\u21bb",
    delete: "-",
    orphan: "(-)",
    replace: "\u2194",
    run: "\u25b6",
    bar: "\u250a",
    mask: "\u2022",
    bullet: "·",
    overflowUp: "\u2191",
    overflowDown: "\u2193",
    overflowLeft: "\u2039",
    overflowRight: "\u203a",
  },
  /**
   * Key-hint labels for KeyBar footers. Resolve through `useKeyGlyphs()`
   * (components/Environment.tsx) so ASCII terminals get readable fallbacks
   * instead of mojibake.
   */
  keyHint: {
    enter: "\u21a9",
    upDown: "\u2191/\u2193",
    leftRight: "\u2190/\u2192",
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
  active: "*",
  pointer: ">",
  success: "+",
  warning: "!",
  error: "x",
  info: "i",
  selected: "*",
  unselected: ".",
  checked: "x",
  unchecked: ".",
  add: "+",
  adopt: "(+)",
  edit: "~",
  refresh: "r",
  delete: "-",
  orphan: "(-)",
  replace: "~",
  run: ">",
  bar: ":",
  mask: "*",
  bullet: ".",
  overflowUp: "^",
  overflowDown: "v",
  overflowLeft: "<",
  overflowRight: ">",
};

export const glyphsFor = (unicode: boolean) => (unicode ? theme.glyph : asciiGlyphs);

const spinnerFrames = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
] as const;
const asciiSpinnerFrames = ["-", "\\", "|", "/"] as const;

export const spinnerFramesFor = (unicode: boolean): readonly string[] =>
  unicode ? spinnerFrames : asciiSpinnerFrames;

export type StatusVariant = "info" | "success" | "warning" | "error";

export const statusColor = (variant: StatusVariant): string =>
  variant === "error" ? theme.color.danger : theme.color[variant];

export const statusPaint = (variant: StatusVariant): Paint => theme.paint[variant];
