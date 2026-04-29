/**
 * Satori template for Open Graph cards. Consumed only by the static
 * `og/[...slug].png.ts` endpoint at build time — never shipped to the
 * browser. The JSX is interpreted by satori, which supports a Flexbox
 * subset and inline `style` props (no CSS classes).
 *
 * The card mirrors the homepage hero: parchment background, Source Serif
 * for the headline, the yantra glyph in deep moss, JetBrains Mono eyebrow
 * label, and a hand-drawn "alchemy.run" caption in the bottom-right
 * corner. Title and description are rendered verbatim from the source
 * page's frontmatter — no splitting, truncation, or glyph workarounds.
 * The full unsubsetted variable TTFs loaded by the endpoint cover every
 * Unicode codepoint we use.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  fg1: "#2a2620",
  fg2: "#4e402c",
  fg3: "#85714f",
  accent: "#5c7a3e",
  accentDeep: "#3f5a2a",
  hairline: "rgba(42,38,32,0.14)",
} as const;

export type OgCardKind = "marketing" | "doc" | "blog";

/**
 * One styled segment of a structured title — mirrors the way the
 * homepage hero declares its own emphasis with explicit `<span>` markup.
 * Pages that want the accent treatment supply an array; doc pages pass
 * a plain string and get plain text.
 */
export interface TitlePart {
  text: string;
  italic?: boolean;
  /** Render this part in the deep-moss accent color. */
  accent?: boolean;
  /**
   * Override the font family for this part. Use `"tinos"` for glyphs
   * that should render from the TNR-equivalent face (the marketing
   * arrow `→` — mirrors the website's font stack falling through to
   * Times New Roman for U+2192). Default: Source Serif 4 Display.
   */
  font?: "tinos";
}

export interface OgCardProps {
  title: string | TitlePart[];
  description?: string;
  /** Drives the eyebrow label (e.g. "guide", "concept", "blog"). */
  eyebrow?: string;
  kind?: OgCardKind;
}

const W = 1200;
const H = 630;

export function OgCard({
  title,
  description,
  eyebrow,
  kind = "doc",
}: OgCardProps): any {
  const eyebrowText = (eyebrow ?? defaultEyebrow(kind)).toUpperCase();

  // Embed the yantra as a data URL so satori inlines it as an <img>.
  const yantra = yantraSvg({
    size: 96,
    stroke: COLORS.accentDeep,
    dot: COLORS.accentDeep,
    strokeWidth: 0.7,
  });
  const yantraDataUrl = `data:image/svg+xml;base64,${Buffer.from(yantra).toString("base64")}`;

  return {
    type: "div",
    key: null,
    props: {
      style: {
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.bg,
        padding: "56px 64px",
        fontFamily: "Source Serif 4",
        color: COLORS.fg1,
        position: "relative",
      },
      children: [
        // Eyebrow row — yantra mark + monospace label.
        {
          type: "div",
          key: "top",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 18,
            },
            children: [
              {
                type: "img",
                key: "y",
                props: {
                  src: yantraDataUrl,
                  width: 56,
                  height: 56,
                  style: { display: "flex" },
                },
              },
              {
                type: "div",
                key: "eb",
                props: {
                  style: {
                    fontFamily: "JetBrains Mono",
                    fontSize: 18,
                    letterSpacing: 3,
                    color: COLORS.accentDeep,
                    fontWeight: 400,
                  },
                  children: eyebrowText,
                },
              },
            ],
          },
        },
        // Title — serif, large, rendered verbatim. Either a plain string
        // (doc pages) or an array of styled parts (marketing pages, which
        // mirror the homepage hero's explicit per-word accent markup).
        // Source Serif 4 static TTFs carry arrows, em-dashes etc. so no
        // splitting or glyph substitution is needed.
        {
          type: "div",
          key: "title",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              marginTop: 56,
              // Display optical-size variant — chunkier serifs + more
              // stroke contrast for headline scale. Matches the hero,
              // which uses the variable font's display axis at ~72px.
              fontFamily: "Source Serif 4 Display",
              fontWeight: 600,
              fontSize: 110,
              lineHeight: 1.02,
              letterSpacing: -2,
              color: COLORS.fg1,
            },
            children: Array.isArray(title)
              ? title.map((part, i) => ({
                  type: "span",
                  key: `tp${i}`,
                  props: {
                    style: {
                      // Explicit fontFamily on the span (not just inherited)
                      // — satori's font matcher is fussier about (family,
                      // weight, style) tuples when style is overridden on a
                      // child. Without this, the italic span often
                      // resolves to faux italic (skewed upright) instead
                      // of the true SemiboldIt cut.
                      fontFamily:
                        part.font === "tinos"
                          ? "Tinos"
                          : "Source Serif 4 Display",
                      fontStyle: part.italic ? "italic" : "normal",
                      color: part.accent ? COLORS.accentDeep : COLORS.fg1,
                      // Tinos only ships at weight 400 in our pipeline.
                      // Forcing 600 here would trigger faux-bold synthesis.
                      fontWeight: part.font === "tinos" ? 400 : 600,
                    },
                    children: part.text,
                  },
                }))
              : title,
          },
        },
        // Description.
        description
          ? {
              type: "div",
              key: "desc",
              props: {
                style: {
                  display: "flex",
                  marginTop: 36,
                  fontSize: 26,
                  lineHeight: 1.45,
                  color: COLORS.fg2,
                  maxWidth: 980,
                },
                children: description,
              },
            }
          : null,
        // Spacer pushes the footer to the bottom.
        {
          type: "div",
          key: "spacer",
          props: { style: { display: "flex", flexGrow: 1 } },
        },
        // Footer — hairline + wordmark + hand-drawn URL.
        {
          type: "div",
          key: "footer",
          props: {
            style: {
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              borderTop: `1px solid ${COLORS.hairline}`,
              paddingTop: 24,
            },
            children: [
              {
                type: "div",
                key: "wm",
                props: {
                  style: {
                    fontFamily: "Source Serif 4",
                    fontStyle: "italic",
                    fontWeight: 400,
                    fontSize: 32,
                    color: COLORS.fg1,
                  },
                  children: "alchemy",
                },
              },
              {
                type: "div",
                key: "url",
                props: {
                  style: {
                    fontFamily: "Caveat",
                    fontWeight: 400,
                    fontSize: 36,
                    color: COLORS.accentDeep,
                  },
                  children: "alchemy.run",
                },
              },
            ],
          },
        },
      ].filter(Boolean),
    },
  };
}

function defaultEyebrow(kind: OgCardKind): string {
  switch (kind) {
    case "marketing":
      return "alchemy · zero to production";
    case "blog":
      return "blog · alchemy.run";
    case "doc":
    default:
      return "alchemy · documentation";
  }
}
