/**
 * Satori template for the README hero image at the top of the repository's
 * `README.md`. Rendered offline by `scripts/generate-readme-hero.ts` to
 * `images/readme-hero.png` and committed to the repo so GitHub serves it
 * straight out of the tree (no external CDN, no satori dependency at view
 * time).
 *
 * Layout is intentionally a stamped-nameplate composition that scales
 * gracefully from desktop READMEs (~900px wide) down to mobile renderings
 * (~390px wide on github.com): centered yantra glyph, large italic serif
 * "alchemy" wordmark, and a monospace tagline beneath. A hairline frame
 * gives the artwork a deliberate, branded edge instead of bleeding into the
 * page background.
 *
 * The native render size is 2400×1000 (2.4:1). At a README `width="900"`
 * attribute the displayed pixel ratio is ~2.67×, so the artwork stays crisp
 * on retina without bloating the file size.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  fg: "#2a2620",
  accent: "#3f5a2a",
  muted: "#85714f",
  hairline: "rgba(42,38,32,0.18)",
} as const;

export const README_HERO_W = 2400;
export const README_HERO_H = 1000;

export function ReadmeHero(): any {
  const yantra = yantraSvg({
    size: 320,
    stroke: COLORS.accent,
    dot: COLORS.accent,
    strokeWidth: 0.7,
  });
  const yantraDataUrl = `data:image/svg+xml;base64,${Buffer.from(yantra).toString("base64")}`;

  return {
    type: "div",
    key: null,
    props: {
      style: {
        width: README_HERO_W,
        height: README_HERO_H,
        display: "flex",
        backgroundColor: COLORS.bg,
        position: "relative",
        fontFamily: "Source Serif 4",
        color: COLORS.fg,
      },
      children: [
        // Hairline frame — gives the artwork a deliberate edge.
        {
          type: "div",
          key: "frame",
          props: {
            style: {
              position: "absolute",
              top: 36,
              left: 36,
              right: 36,
              bottom: 36,
              border: `1px solid ${COLORS.hairline}`,
              display: "flex",
            },
          },
        },
        // Centered stack — yantra + wordmark + tagline.
        {
          type: "div",
          key: "stack",
          props: {
            style: {
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 36,
            },
            children: [
              // Yantra glyph.
              {
                type: "img",
                key: "yantra",
                props: {
                  src: yantraDataUrl,
                  width: 320,
                  height: 320,
                  style: { display: "flex" },
                },
              },
              // Wordmark — italic serif, oversized, the visual anchor.
              {
                type: "div",
                key: "wm",
                props: {
                  style: {
                    display: "flex",
                    fontFamily: "Source Serif 4 Display",
                    fontStyle: "italic",
                    fontWeight: 600,
                    fontSize: 260,
                    lineHeight: 1,
                    letterSpacing: -4,
                    color: COLORS.fg,
                    marginTop: -8,
                  },
                  children: "alchemy",
                },
              },
              // Tagline — wide-tracked mono caps, deep moss, with em-dash
              // separators for a typographic rhythm rather than dots.
              {
                type: "div",
                key: "tag",
                props: {
                  style: {
                    display: "flex",
                    fontFamily: "JetBrains Mono",
                    fontWeight: 400,
                    fontSize: 36,
                    letterSpacing: 12,
                    color: COLORS.accent,
                    marginTop: 12,
                  },
                  children: "INFRASTRUCTURE — AS — EFFECTS",
                },
              },
            ],
          },
        },
        // Bottom-right URL stamp, mirrors the OG card.
        {
          type: "div",
          key: "url",
          props: {
            style: {
              position: "absolute",
              right: 72,
              bottom: 60,
              display: "flex",
              fontFamily: "Caveat",
              fontWeight: 400,
              fontSize: 56,
              color: COLORS.accent,
            },
            children: "alchemy.run",
          },
        },
        // Bottom-left eyebrow stamp — provider rollcall.
        {
          type: "div",
          key: "providers",
          props: {
            style: {
              position: "absolute",
              left: 72,
              bottom: 72,
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontWeight: 400,
              fontSize: 24,
              letterSpacing: 4,
              color: COLORS.muted,
            },
            children: "EFFECT  ·  AWS  ·  CLOUDFLARE",
          },
        },
      ],
    },
  };
}
