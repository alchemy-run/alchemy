/**
 * Satori template for Open Graph cards. This module is consumed only by
 * the static `og/[...slug].png.ts` endpoint at build time — never shipped
 * to the browser. The JSX is interpreted by satori, which supports a
 * Flexbox subset and inline `style` props (no CSS classes).
 *
 * The card mirrors the homepage hero: parchment background, Source Serif
 * headline with a key word italicized in deep moss, the yantra glyph, and
 * a hand-drawn "alchemy.run" caption in the bottom-right corner.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  bgNav: "#efe7d6",
  fg1: "#2a2620",
  fg2: "#4e402c",
  fg3: "#85714f",
  accent: "#5c7a3e",
  accentDeep: "#3f5a2a",
  hairline: "rgba(42,38,32,0.14)",
} as const;

export type OgCardKind = "marketing" | "doc" | "blog";

export interface OgCardProps {
  title: string;
  description?: string;
  /** Drives the eyebrow label (e.g. "guide", "concept", "blog"). */
  eyebrow?: string;
  kind?: OgCardKind;
}

const W = 1200;
const H = 630;

/**
 * Splits the title into two halves so we can italicize the second half in
 * the brand accent color — same treatment as the homepage hero ("Zero →
 * production"). When the title has no obvious split point we just render
 * it plain.
 */
function splitTitle(title: string): { head: string; tail?: string } {
  // Prefer splitting on a long arrow, em-dash, or colon.
  const match = title.match(/^(.+?)\s*(?:→|->|—|-|:)\s*(.+)$/);
  if (match) return { head: match[1], tail: match[2] };
  return { head: title };
}

export function OgCard({
  title,
  description,
  eyebrow,
  kind = "doc",
}: OgCardProps): any {
  const { head, tail } = splitTitle(title);
  const eyebrowText = (
    eyebrow ?? defaultEyebrow(kind)
  ).toUpperCase();

  // Encode the yantra as a data URL so satori embeds it as an <img>.
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
        fontFamily: "Inter",
        color: COLORS.fg1,
        position: "relative",
      },
      children: [
        // Top row: yantra + eyebrow
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
                    fontWeight: 500,
                  },
                  children: eyebrowText,
                },
              },
            ],
          },
        },
        // Title — serif, large, with optional italicized tail in moss
        {
          type: "div",
          key: "title",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              marginTop: 64,
              fontFamily: "Source Serif 4",
              fontWeight: 500,
              fontSize: titleFontSize(title),
              lineHeight: 1.06,
              letterSpacing: -1.5,
              color: COLORS.fg1,
            },
            children: tail
              ? [
                  { type: "span", key: "h", props: { children: head + "\u00A0" } },
                  {
                    type: "span",
                    key: "t",
                    props: {
                      style: {
                        fontStyle: "italic",
                        color: COLORS.accentDeep,
                      },
                      children: tail,
                    },
                  },
                ]
              : head,
          },
        },
        // Description
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
                children: truncate(description, 180),
              },
            }
          : null,
        // Spacer to push footer to the bottom
        {
          type: "div",
          key: "spacer",
          props: { style: { display: "flex", flexGrow: 1 } },
        },
        // Footer row: hairline + url tag
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
              fontFamily: "JetBrains Mono",
              fontSize: 18,
              color: COLORS.fg3,
            },
            children: [
              {
                type: "div",
                key: "wm",
                props: {
                  style: {
                    fontFamily: "Source Serif 4",
                    fontStyle: "italic",
                    fontWeight: 500,
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

/** Headline font size shrinks for very long titles so they always fit. */
function titleFontSize(title: string): number {
  const len = title.length;
  if (len <= 32) return 88;
  if (len <= 56) return 72;
  if (len <= 80) return 60;
  return 52;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
