import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";

/**
 * The docs' code theme, for the app: "walnut sunrise" — the dark
 * walnut surface (#2a2620) and the bright sunrise syntax palette of
 * `website/src/styles/tokens.css` (`--alc-code-*`), which the website
 * paints in BOTH color modes. Code review follows: a diff is the same
 * walnut card on the parchment page and on the night page, so light
 * and dark are aligned and match alchemy.run. The token rules mirror
 * `website/plugins/alchemy-walnut-theme.mjs`; keep the two in step.
 */
export const CODE_THEME = "alchemy-walnut";

/** The surface and the colors the diff chrome draws with — the same
 *  values `ui/index.css` sets as `--code*`. */
export const CODE_SURFACE = {
  background: "#2a2620",
  foreground: "#faf5e3",
  muted: "#85714f",
  border: "#4e402c",
  addition: "#8fb15e",
  deletion: "#e07a5f",
  modified: "#7ddfff",
} as const;

const walnutSunrise: ThemeRegistration = {
  name: CODE_THEME,
  type: "dark",
  semanticHighlighting: true,
  colors: {
    "editor.background": CODE_SURFACE.background,
    "editor.foreground": CODE_SURFACE.foreground,
    "editor.lineHighlightBackground": "#36302280",
    "editor.selectionBackground": "#5c7a3e66",
    "editorLineNumber.foreground": CODE_SURFACE.muted,
    "editorLineNumber.activeForeground": CODE_SURFACE.foreground,
    "diffEditor.insertedTextBackground": "#5c7a3e26",
    "diffEditor.removedTextBackground": "#b3462e26",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#b3a27a", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.other",
      ],
      settings: { foreground: "#d4f26a" },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "#c7b795" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["string.template", "punctuation.definition.template-expression"],
      settings: { foreground: "#ffe38a" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "constant.language.boolean",
        "constant.language.null",
        "constant.language.undefined",
      ],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "meta.function-call.method entity.name.function",
        "variable.function",
        "meta.definition.method entity.name.function",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.interface",
        "entity.name.namespace",
        "support.type",
        "support.class",
        "support.other.namespace",
        "support.module",
        "meta.type",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: [
        "variable.other.object",
        "variable.other.readwrite.alias",
        "meta.import variable.other.readwrite",
        "meta.export variable.other.readwrite",
        "meta.object-literal.key support.type.object",
      ],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["entity.name.tag", "meta.tag entity.name.tag"],
      settings: { foreground: "#ffb968" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#d4f26a", fontStyle: "italic" },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "meta.definition.variable variable.other",
      ],
      settings: { foreground: CODE_SURFACE.foreground },
    },
    {
      scope: ["variable.other.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["variable.other.enummember"],
      settings: { foreground: "#ff9a6b" },
    },
    {
      scope: ["variable.other.property", "meta.object.member"],
      settings: { foreground: CODE_SURFACE.foreground },
    },
    {
      scope: ["support.variable", "support.constant"],
      settings: { foreground: "#7ddfff" },
    },
    {
      scope: ["punctuation.section.embedded", "meta.embedded"],
      settings: { foreground: CODE_SURFACE.foreground },
    },
    {
      scope: ["markup.heading", "markup.bold"],
      settings: { foreground: CODE_SURFACE.foreground, fontStyle: "bold" },
    },
    {
      scope: ["markup.italic"],
      settings: { foreground: CODE_SURFACE.foreground, fontStyle: "italic" },
    },
    {
      scope: ["markup.inserted", "markup.inserted.diff"],
      settings: { foreground: CODE_SURFACE.addition },
    },
    {
      scope: ["markup.deleted", "markup.deleted.diff"],
      settings: { foreground: CODE_SURFACE.deletion },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: CODE_SURFACE.deletion },
    },
  ],
};

const REGISTERED = Symbol.for("alchemy-org/code-theme");

/** Register the theme with the renderer — once per page, however many
 *  times the module re-evaluates (Vite's HMR). */
export const ensureCodeTheme = (): void => {
  const global = globalThis as { [REGISTERED]?: true };
  if (global[REGISTERED]) return;
  global[REGISTERED] = true;
  registerCustomTheme(CODE_THEME, () => Promise.resolve(walnutSunrise));
};
