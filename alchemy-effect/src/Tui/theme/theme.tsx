import { RGBA, SyntaxStyle } from "@opentui/core";
import {
  createContext,
  createMemo,
  Show,
  useContext,
  type ParentProps,
} from "solid-js";
import aura from "./themes/aura.json" with { type: "json" };
import ayu from "./themes/ayu.json" with { type: "json" };
import carbonfox from "./themes/carbonfox.json" with { type: "json" };
import catppuccinFrappe from "./themes/catppuccin-frappe.json" with { type: "json" };
import catppuccinMacchiato from "./themes/catppuccin-macchiato.json" with { type: "json" };
import catppuccin from "./themes/catppuccin.json" with { type: "json" };
import cobalt2 from "./themes/cobalt2.json" with { type: "json" };
import cursor from "./themes/cursor.json" with { type: "json" };
import dracula from "./themes/dracula.json" with { type: "json" };
import everforest from "./themes/everforest.json" with { type: "json" };
import flexoki from "./themes/flexoki.json" with { type: "json" };
import github from "./themes/github.json" with { type: "json" };
import gruvbox from "./themes/gruvbox.json" with { type: "json" };
import kanagawa from "./themes/kanagawa.json" with { type: "json" };
import lucentOrng from "./themes/lucent-orng.json" with { type: "json" };
import material from "./themes/material.json" with { type: "json" };
import matrix from "./themes/matrix.json" with { type: "json" };
import mercury from "./themes/mercury.json" with { type: "json" };
import monokai from "./themes/monokai.json" with { type: "json" };
import nightowl from "./themes/nightowl.json" with { type: "json" };
import nord from "./themes/nord.json" with { type: "json" };
import onedark from "./themes/one-dark.json" with { type: "json" };
import opencode from "./themes/opencode.json" with { type: "json" };
import orng from "./themes/orng.json" with { type: "json" };
import osakaJade from "./themes/osaka-jade.json" with { type: "json" };
import palenight from "./themes/palenight.json" with { type: "json" };
import rosepine from "./themes/rosepine.json" with { type: "json" };
import solarized from "./themes/solarized.json" with { type: "json" };
import synthwave84 from "./themes/synthwave84.json" with { type: "json" };
import tokyonight from "./themes/tokyonight.json" with { type: "json" };
import vercel from "./themes/vercel.json" with { type: "json" };
import vesper from "./themes/vesper.json" with { type: "json" };
import zenburn from "./themes/zenburn.json" with { type: "json" };

type ThemeColors = {
  primary: RGBA;
  secondary: RGBA;
  accent: RGBA;
  error: RGBA;
  warning: RGBA;
  success: RGBA;
  info: RGBA;
  text: RGBA;
  textMuted: RGBA;
  selectedListItemText: RGBA;
  background: RGBA;
  backgroundPanel: RGBA;
  backgroundElement: RGBA;
  backgroundMenu: RGBA;
  border: RGBA;
  borderActive: RGBA;
  borderSubtle: RGBA;
  diffAdded: RGBA;
  diffRemoved: RGBA;
  diffContext: RGBA;
  diffHunkHeader: RGBA;
  diffHighlightAdded: RGBA;
  diffHighlightRemoved: RGBA;
  diffAddedBg: RGBA;
  diffRemovedBg: RGBA;
  diffContextBg: RGBA;
  diffLineNumber: RGBA;
  diffAddedLineNumberBg: RGBA;
  diffRemovedLineNumberBg: RGBA;
  markdownText: RGBA;
  markdownHeading: RGBA;
  markdownLink: RGBA;
  markdownLinkText: RGBA;
  markdownCode: RGBA;
  markdownBlockQuote: RGBA;
  markdownEmph: RGBA;
  markdownStrong: RGBA;
  markdownHorizontalRule: RGBA;
  markdownListItem: RGBA;
  markdownListEnumeration: RGBA;
  markdownImage: RGBA;
  markdownImageText: RGBA;
  markdownCodeBlock: RGBA;
  syntaxComment: RGBA;
  syntaxKeyword: RGBA;
  syntaxFunction: RGBA;
  syntaxVariable: RGBA;
  syntaxString: RGBA;
  syntaxNumber: RGBA;
  syntaxType: RGBA;
  syntaxOperator: RGBA;
  syntaxPunctuation: RGBA;
};

type Theme = ThemeColors & {
  _hasSelectedListItemText: boolean;
  thinkingOpacity: number;
};

export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  // If theme explicitly defines selectedListItemText, use it
  if (theme._hasSelectedListItemText) {
    return theme.selectedListItemText;
  }

  // For transparent backgrounds, calculate contrast based on the actual bg (or fallback to primary)
  if (theme.background.a === 0) {
    const targetColor = bg ?? theme.primary;
    const { r, g, b } = targetColor;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 0.5
      ? RGBA.fromInts(0, 0, 0)
      : RGBA.fromInts(255, 255, 255);
  }

  // Fall back to background color
  return theme.background;
}

type HexColor = `#${string}`;
type RefName = string;
type Variant = {
  dark: HexColor | RefName;
  light: HexColor | RefName;
};
type ColorValue = HexColor | RefName | Variant | RGBA;
type ThemeJson = {
  $schema?: string;
  defs?: Record<string, HexColor | RefName>;
  theme: Omit<
    Record<keyof ThemeColors, ColorValue>,
    "selectedListItemText" | "backgroundMenu"
  > & {
    selectedListItemText?: ColorValue;
    backgroundMenu?: ColorValue;
    thinkingOpacity?: number;
  };
};

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  aura,
  ayu,
  catppuccin,
  ["catppuccin-frappe"]: catppuccinFrappe,
  ["catppuccin-macchiato"]: catppuccinMacchiato,
  cobalt2,
  cursor,
  dracula,
  everforest,
  flexoki,
  github,
  gruvbox,
  kanagawa,
  material,
  matrix,
  mercury,
  monokai,
  nightowl,
  nord,
  ["one-dark"]: onedark,
  ["osaka-jade"]: osakaJade,
  opencode,
  orng,
  ["lucent-orng"]: lucentOrng,
  palenight,
  rosepine,
  solarized,
  synthwave84,
  tokyonight,
  vesper,
  vercel,
  zenburn,
  carbonfox,
};

function resolveTheme(theme: ThemeJson, mode: "dark" | "light") {
  const defs = theme.defs ?? {};
  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c;
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0);

      if (c.startsWith("#")) return RGBA.fromHex(c);

      if (defs[c] != null) {
        return resolveColor(defs[c]);
      } else if (theme.theme[c as keyof ThemeColors] !== undefined) {
        return resolveColor(theme.theme[c as keyof ThemeColors]!);
      } else {
        throw new Error(`Color reference "${c}" not found in defs or theme`);
      }
    }
    if (typeof c === "number") {
      return ansiToRgba(c);
    }
    return resolveColor(c[mode]);
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(
        ([key]) =>
          key !== "selectedListItemText" &&
          key !== "backgroundMenu" &&
          key !== "thinkingOpacity",
      )
      .map(([key, value]) => {
        return [key, resolveColor(value as ColorValue)];
      }),
  ) as Partial<ThemeColors>;

  // Handle selectedListItemText separately since it's optional
  const hasSelectedListItemText =
    theme.theme.selectedListItemText !== undefined;
  if (hasSelectedListItemText) {
    resolved.selectedListItemText = resolveColor(
      theme.theme.selectedListItemText!,
    );
  } else {
    // Backward compatibility: if selectedListItemText is not defined, use background color
    // This preserves the current behavior for all existing themes
    resolved.selectedListItemText = resolved.background;
  }

  // Handle backgroundMenu - optional with fallback to backgroundElement
  if (theme.theme.backgroundMenu !== undefined) {
    resolved.backgroundMenu = resolveColor(theme.theme.backgroundMenu);
  } else {
    resolved.backgroundMenu = resolved.backgroundElement;
  }

  // Handle thinkingOpacity - optional with default of 0.6
  const thinkingOpacity = theme.theme.thinkingOpacity ?? 0.6;

  return {
    ...resolved,
    _hasSelectedListItemText: hasSelectedListItemText,
    thinkingOpacity,
  } as Theme;
}

function ansiToRgba(code: number): RGBA {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      "#000000", // Black
      "#800000", // Red
      "#008000", // Green
      "#808000", // Yellow
      "#000080", // Blue
      "#800080", // Magenta
      "#008080", // Cyan
      "#c0c0c0", // White
      "#808080", // Bright Black
      "#ff0000", // Bright Red
      "#00ff00", // Bright Green
      "#ffff00", // Bright Yellow
      "#0000ff", // Bright Blue
      "#ff00ff", // Bright Magenta
      "#00ffff", // Bright Cyan
      "#ffffff", // Bright White
    ];
    return RGBA.fromHex(ansiColors[code] ?? "#000000");
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);

    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return RGBA.fromInts(val(r), val(g), val(b));
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8;
    return RGBA.fromInts(gray, gray, gray);
  }

  // Fallback for invalid codes
  return RGBA.fromInts(0, 0, 0);
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light"; theme?: string }) => {
    const mode = props.mode;
    const activeTheme = props.theme ?? "opencode";

    const values = createMemo(() => {
      return resolveTheme(
        DEFAULT_THEMES[activeTheme] ?? DEFAULT_THEMES.opencode,
        mode,
      );
    });

    const syntax = createMemo(() => generateSyntax(values()));
    const subtleSyntax = createMemo(() => generateSubtleSyntax(values()));

    return {
      theme: new Proxy(values(), {
        get(_target, prop) {
          // @ts-expect-error
          return values()[prop];
        },
      }),
      get selected() {
        return activeTheme;
      },
      all() {
        return DEFAULT_THEMES;
      },
      syntax,
      subtleSyntax,
      mode() {
        return mode;
      },
      setMode(_mode: "dark" | "light") {
        // No-op in simplified version
      },
      set(_theme: string) {
        // No-op in simplified version
      },
      get ready() {
        return true;
      },
    };
  },
});

function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string;
  init: ((input: Props) => T) | (() => T);
}) {
  const ctx = createContext<T>();

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props);
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      );
    },
    use() {
      const value = useContext(ctx);
      if (!value)
        throw new Error(
          `${input.name} context must be used within a context provider`,
        );
      return value;
    },
  };
}

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha;
  const g = base.g + (overlay.g - base.g) * alpha;
  const b = base.b + (overlay.b - base.b) * alpha;
  return RGBA.fromInts(
    Math.round(r * 255),
    Math.round(g * 255),
    Math.round(b * 255),
  );
}

function generateSyntax(theme: Theme) {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme));
}

function generateSubtleSyntax(theme: Theme) {
  const rules = getSyntaxRules(theme);
  return SyntaxStyle.fromTheme(
    rules.map((rule) => {
      if (rule.style.foreground) {
        const fg = rule.style.foreground;
        return {
          ...rule,
          style: {
            ...rule.style,
            foreground: RGBA.fromInts(
              Math.round(fg.r * 255),
              Math.round(fg.g * 255),
              Math.round(fg.b * 255),
              Math.round(theme.thinkingOpacity * 255),
            ),
          },
        };
      }
      return rule;
    }),
  );
}

function getSyntaxRules(theme: Theme) {
  return [
    {
      scope: ["default"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["prompt"],
      style: {
        foreground: theme.accent,
      },
    },
    {
      scope: ["extmark.file"],
      style: {
        foreground: theme.warning,
        bold: true,
      },
    },
    {
      scope: ["extmark.agent"],
      style: {
        foreground: theme.secondary,
        bold: true,
      },
    },
    {
      scope: ["extmark.paste"],
      style: {
        foreground: theme.background,
        background: theme.warning,
        bold: true,
      },
    },
    {
      scope: ["comment"],
      style: {
        foreground: theme.syntaxComment,
        italic: true,
      },
    },
    {
      scope: ["comment.documentation"],
      style: {
        foreground: theme.syntaxComment,
        italic: true,
      },
    },
    {
      scope: ["string", "symbol"],
      style: {
        foreground: theme.syntaxString,
      },
    },
    {
      scope: ["number", "boolean"],
      style: {
        foreground: theme.syntaxNumber,
      },
    },
    {
      scope: ["character.special"],
      style: {
        foreground: theme.syntaxString,
      },
    },
    {
      scope: [
        "keyword.return",
        "keyword.conditional",
        "keyword.repeat",
        "keyword.coroutine",
      ],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.type"],
      style: {
        foreground: theme.syntaxType,
        bold: true,
        italic: true,
      },
    },
    {
      scope: ["keyword.function", "function.method"],
      style: {
        foreground: theme.syntaxFunction,
      },
    },
    {
      scope: ["keyword"],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.import"],
      style: {
        foreground: theme.syntaxKeyword,
      },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: {
        foreground: theme.syntaxOperator,
      },
    },
    {
      scope: ["keyword.conditional.ternary"],
      style: {
        foreground: theme.syntaxOperator,
      },
    },
    {
      scope: [
        "variable",
        "variable.parameter",
        "function.method.call",
        "function.call",
      ],
      style: {
        foreground: theme.syntaxVariable,
      },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: {
        foreground: theme.syntaxFunction,
      },
    },
    {
      scope: ["type", "module"],
      style: {
        foreground: theme.syntaxType,
      },
    },
    {
      scope: ["constant"],
      style: {
        foreground: theme.syntaxNumber,
      },
    },
    {
      scope: ["property"],
      style: {
        foreground: theme.syntaxVariable,
      },
    },
    {
      scope: ["class"],
      style: {
        foreground: theme.syntaxType,
      },
    },
    {
      scope: ["parameter"],
      style: {
        foreground: theme.syntaxVariable,
      },
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: {
        foreground: theme.syntaxPunctuation,
      },
    },
    {
      scope: [
        "variable.builtin",
        "type.builtin",
        "function.builtin",
        "module.builtin",
        "constant.builtin",
      ],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["variable.super"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["string.escape", "string.regexp"],
      style: {
        foreground: theme.syntaxKeyword,
      },
    },
    {
      scope: ["keyword.directive"],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    {
      scope: ["punctuation.special"],
      style: {
        foreground: theme.syntaxOperator,
      },
    },
    {
      scope: ["keyword.modifier"],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.exception"],
      style: {
        foreground: theme.syntaxKeyword,
        italic: true,
      },
    },
    // Markdown specific styles
    {
      scope: ["markup.heading"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.1"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.2"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.3"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.4"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.5"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.6"],
      style: {
        foreground: theme.markdownHeading,
        bold: true,
      },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: {
        foreground: theme.markdownStrong,
        bold: true,
      },
    },
    {
      scope: ["markup.italic"],
      style: {
        foreground: theme.markdownEmph,
        italic: true,
      },
    },
    {
      scope: ["markup.list"],
      style: {
        foreground: theme.markdownListItem,
      },
    },
    {
      scope: ["markup.quote"],
      style: {
        foreground: theme.markdownBlockQuote,
        italic: true,
      },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.markdownCode,
      },
    },
    {
      scope: ["markup.raw.inline"],
      style: {
        foreground: theme.markdownCode,
        background: theme.background,
      },
    },
    {
      scope: ["markup.link"],
      style: {
        foreground: theme.markdownLink,
        underline: true,
      },
    },
    {
      scope: ["markup.link.label"],
      style: {
        foreground: theme.markdownLinkText,
        underline: true,
      },
    },
    {
      scope: ["markup.link.url"],
      style: {
        foreground: theme.markdownLink,
        underline: true,
      },
    },
    {
      scope: ["label"],
      style: {
        foreground: theme.markdownLinkText,
      },
    },
    {
      scope: ["spell", "nospell"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["conceal"],
      style: {
        foreground: theme.textMuted,
      },
    },
    // Additional common highlight groups
    {
      scope: ["string.special", "string.special.url"],
      style: {
        foreground: theme.markdownLink,
        underline: true,
      },
    },
    {
      scope: ["character"],
      style: {
        foreground: theme.syntaxString,
      },
    },
    {
      scope: ["float"],
      style: {
        foreground: theme.syntaxNumber,
      },
    },
    {
      scope: ["comment.error"],
      style: {
        foreground: theme.error,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.warning"],
      style: {
        foreground: theme.warning,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.todo", "comment.note"],
      style: {
        foreground: theme.info,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["namespace"],
      style: {
        foreground: theme.syntaxType,
      },
    },
    {
      scope: ["field"],
      style: {
        foreground: theme.syntaxVariable,
      },
    },
    {
      scope: ["type.definition"],
      style: {
        foreground: theme.syntaxType,
        bold: true,
      },
    },
    {
      scope: ["keyword.export"],
      style: {
        foreground: theme.syntaxKeyword,
      },
    },
    {
      scope: ["attribute", "annotation"],
      style: {
        foreground: theme.warning,
      },
    },
    {
      scope: ["tag"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["tag.attribute"],
      style: {
        foreground: theme.syntaxKeyword,
      },
    },
    {
      scope: ["tag.delimiter"],
      style: {
        foreground: theme.syntaxOperator,
      },
    },
    {
      scope: ["markup.strikethrough"],
      style: {
        foreground: theme.textMuted,
      },
    },
    {
      scope: ["markup.underline"],
      style: {
        foreground: theme.text,
        underline: true,
      },
    },
    {
      scope: ["markup.list.checked"],
      style: {
        foreground: theme.success,
      },
    },
    {
      scope: ["markup.list.unchecked"],
      style: {
        foreground: theme.textMuted,
      },
    },
    {
      scope: ["diff.plus"],
      style: {
        foreground: theme.diffAdded,
        background: theme.diffAddedBg,
      },
    },
    {
      scope: ["diff.minus"],
      style: {
        foreground: theme.diffRemoved,
        background: theme.diffRemovedBg,
      },
    },
    {
      scope: ["diff.delta"],
      style: {
        foreground: theme.diffContext,
        background: theme.diffContextBg,
      },
    },
    {
      scope: ["error"],
      style: {
        foreground: theme.error,
        bold: true,
      },
    },
    {
      scope: ["warning"],
      style: {
        foreground: theme.warning,
        bold: true,
      },
    },
    {
      scope: ["info"],
      style: {
        foreground: theme.info,
      },
    },
    {
      scope: ["debug"],
      style: {
        foreground: theme.textMuted,
      },
    },
  ];
}
