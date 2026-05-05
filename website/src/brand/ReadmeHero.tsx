/**
 * Satori template for the README hero — a tight logo lockup of the yantra
 * mark and the italic "alchemy" wordmark on a parchment ground. No frame,
 * no tagline, no URL stamp. Rendered offline by
 * `scripts/generate-readme-hero.ts` to `images/readme-hero.png`.
 *
 * The native render size is 1600×480 (10:3). Cropped tight to the lockup
 * so there's no dead space at any GitHub display width.
 */

import { yantraSvg } from "./yantra";

const COLORS = {
  bg: "#f5efe3",
  fg: "#2a2620",
  accent: "#3f5a2a",
} as const;

export const README_HERO_W = 1600;
export const README_HERO_H = 480;

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
        alignItems: "center",
        justifyContent: "center",
        gap: 56,
        backgroundColor: COLORS.bg,
        fontFamily: "Source Serif 4 Display",
        color: COLORS.fg,
      },
      children: [
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
        {
          type: "div",
          key: "wm",
          props: {
            style: {
              display: "flex",
              fontFamily: "Source Serif 4 Display",
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 320,
              lineHeight: 1,
              letterSpacing: -4,
              color: COLORS.fg,
              // Optical alignment: pull the wordmark up slightly so the
              // visual center of the lowercase x-height lines up with the
              // yantra's centroid (the geometric centers don't match
              // because "alchemy" has descenders but no ascenders).
              marginTop: -24,
            },
            children: "alchemy",
          },
        },
      ],
    },
  };
}
