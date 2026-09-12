import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";

/**
 * The app's two code themes, one per color mode, both on the brand
 * palette of `website/src/styles/tokens.css`:
 *
 * - **walnut sunrise** (dark) — the docs' code block: the walnut
 *   surface (#2a2620) and its bright sunrise syntax colors. The token
 *   rules mirror `website/plugins/alchemy-walnut-theme.mjs`; keep the
 *   two in step.
 * - **parchment** (light) — the same roles on lifted paper (#fbf6ea,
 *   the page's card color): moss keywords, honey strings, terracotta
 *   literals, slate types — the earthy semantics, deepened to read on
 *   the light page.
 *
 * The renderer draws inside a shadow root the page's tokens can't
 * reach, so it is handed both themes and told which is showing; the
 * chrome around it (`code-surface` in `ui/index.css`, the `--code*`
 * tokens) follows the page's mode the ordinary way. Keep the surface
 * values here and there identical.
 */
export const DARK_CODE_THEME = "alchemy-walnut";
export const LIGHT_CODE_THEME = "alchemy-parchment";

/** Every color a theme needs — the surface and the chrome (`--code*`
 *  in `ui/index.css`) plus the syntax roles. */
interface CodePalette {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  addition: string;
  deletion: string;
  modified: string;
  lineHighlight: string;
  selection: string;
  comment: string;
  keyword: string;
  operator: string;
  string: string;
  literal: string;
  fn: string;
  type: string;
  tag: string;
  /** Quoted data values — YAML strings: green, so a document of keys
   *  and values reads in the code's cool spread. */
  data: string;
}

export const WALNUT: CodePalette = {
  background: "#2a2620",
  foreground: "#faf5e3",
  muted: "#85714f",
  border: "#4e402c",
  addition: "#8fb15e",
  deletion: "#e07a5f",
  modified: "#7ddfff",
  lineHighlight: "#36302280",
  selection: "#5c7a3e66",
  comment: "#b3a27a",
  keyword: "#d4f26a",
  operator: "#c7b795",
  string: "#ffe38a",
  literal: "#ff9a6b",
  fn: "#7ddfff",
  type: "#7ddfff",
  tag: "#ffb968",
  data: "#8fb15e",
};

export const PARCHMENT: CodePalette = {
  background: "#fbf6ea",
  foreground: "#2a2620",
  muted: "#85714f",
  border: "#e2d7bc",
  addition: "#5c7a3e",
  deletion: "#b3462e",
  modified: "#3a7a8a",
  lineHighlight: "#ebe3d080",
  selection: "#5c7a3e33",
  comment: "#8a7452",
  // the roles deepened and saturated for paper: the same hues as the
  // walnut theme's, dark enough to hold their own against #fbf6ea
  keyword: "#2f6b12",
  operator: "#68573c",
  string: "#8f5a00",
  literal: "#b8461a",
  fn: "#1256b0",
  type: "#0d6e86",
  tag: "#a8351c",
  data: "#2f7a1a",
};

const makeTheme = (
  name: string,
  type: "light" | "dark",
  p: CodePalette,
): ThemeRegistration => ({
  name,
  type,
  semanticHighlighting: true,
  colors: {
    "editor.background": p.background,
    "editor.foreground": p.foreground,
    "editor.lineHighlightBackground": p.lineHighlight,
    "editor.selectionBackground": p.selection,
    "editorLineNumber.foreground": p.muted,
    "editorLineNumber.activeForeground": p.foreground,
    "diffEditor.insertedTextBackground": `${p.addition}26`,
    "diffEditor.removedTextBackground": `${p.deletion}26`,
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: p.comment, fontStyle: "italic" },
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
      settings: { foreground: p.keyword },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: p.operator },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: p.string },
    },
    {
      scope: ["string.template", "punctuation.definition.template-expression"],
      settings: { foreground: p.string },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: p.literal },
    },
    {
      scope: [
        "constant.language.boolean",
        "constant.language.null",
        "constant.language.undefined",
      ],
      settings: { foreground: p.literal },
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
      settings: { foreground: p.fn },
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
      settings: { foreground: p.type },
    },
    {
      scope: [
        "variable.other.object",
        "variable.other.readwrite.alias",
        "meta.import variable.other.readwrite",
        "meta.export variable.other.readwrite",
        "meta.object-literal.key support.type.object",
      ],
      settings: { foreground: p.type },
    },
    {
      scope: ["entity.name.tag", "meta.tag entity.name.tag"],
      settings: { foreground: p.tag },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: p.keyword, fontStyle: "italic" },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "meta.definition.variable variable.other",
      ],
      settings: { foreground: p.foreground },
    },
    {
      scope: ["variable.other.constant"],
      settings: { foreground: p.type },
    },
    {
      scope: ["variable.other.enummember"],
      settings: { foreground: p.literal },
    },
    {
      scope: ["variable.other.property", "meta.object.member"],
      settings: { foreground: p.foreground },
    },
    {
      scope: ["support.variable", "support.constant"],
      settings: { foreground: p.type },
    },
    {
      scope: ["punctuation.section.embedded", "meta.embedded"],
      settings: { foreground: p.foreground },
    },
    {
      scope: ["markup.heading", "markup.bold"],
      settings: { foreground: p.foreground, fontStyle: "bold" },
    },
    {
      scope: ["markup.italic"],
      settings: { foreground: p.foreground, fontStyle: "italic" },
    },
    {
      scope: ["markup.inserted", "markup.inserted.diff"],
      settings: { foreground: p.addition },
    },
    {
      scope: ["markup.deleted", "markup.deleted.diff"],
      settings: { foreground: p.deletion },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: p.deletion },
    },
    // YAML — data, not code: the generic rules would paint every key
    // tag-orange and every value string-yellow, a wall of warm tones.
    // Keys take the function blue, quoted text the addition green,
    // bare words the plain foreground, and numbers/booleans/null the
    // keyword tone — the same cool spread a program has.
    {
      scope: ["entity.name.tag.yaml"],
      settings: { foreground: p.fn },
    },
    {
      scope: [
        "string.unquoted.plain.out.yaml",
        "string.unquoted.plain.in.yaml",
      ],
      settings: { foreground: p.foreground },
    },
    {
      scope: [
        "string.quoted.double.yaml",
        "string.quoted.single.yaml",
        "string.unquoted.block.yaml",
        "punctuation.definition.string.begin.yaml",
        "punctuation.definition.string.end.yaml",
      ],
      settings: { foreground: p.data },
    },
    {
      scope: [
        "constant.numeric.integer.yaml",
        "constant.numeric.float.yaml",
        "constant.language.boolean.yaml",
        "constant.language.null.yaml",
      ],
      settings: { foreground: p.keyword },
    },
    {
      scope: [
        "punctuation.definition.block.sequence.item.yaml",
        "punctuation.separator.key-value.mapping.yaml",
        "keyword.control.flow.block-scalar.literal.yaml",
        "keyword.control.flow.block-scalar.folded.yaml",
      ],
      settings: { foreground: p.operator },
    },
  ],
});

const walnutSunrise = makeTheme(DARK_CODE_THEME, "dark", WALNUT);
const parchment = makeTheme(LIGHT_CODE_THEME, "light", PARCHMENT);

const REGISTERED = Symbol.for("alchemy-org/code-theme");

/** Register both themes with the renderer — each once per page, however
 *  many times the module re-evaluates (Vite's HMR). Tracked BY NAME, so
 *  a theme added in a later edit still registers on a page whose
 *  earlier module already ran (a boolean "done" flag would skip it and
 *  the renderer, asked for a name it never got, draws nothing). */
export const ensureCodeTheme = (): void => {
  const global = globalThis as { [REGISTERED]?: Set<string> };
  const registered = (global[REGISTERED] ??= new Set());
  for (const [name, theme] of [
    [DARK_CODE_THEME, walnutSunrise],
    [LIGHT_CODE_THEME, parchment],
  ] as const) {
    if (registered.has(name)) continue;
    registered.add(name);
    registerCustomTheme(name, () => Promise.resolve(theme));
  }
};
