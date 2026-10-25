import { AbsoluteFill } from "remotion";
import { enter, progress } from "../anim.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";

type Props = Extract<Scene, { kind: "hero" }> & { t: number };

export const Hero = ({ eyebrow, heading, lede, footer, t }: Props) => (
  <AbsoluteFill style={{ padding: "0 160px", justifyContent: "center" }}>
    <div
      style={{
        fontFamily: font.mono,
        fontSize: 26,
        letterSpacing: "0.3em",
        color: color.moss,
        ...enter(progress(t)),
      }}
    >
      {eyebrow.toUpperCase()}
    </div>
    <div
      style={{
        fontFamily: font.serif,
        fontWeight: 600,
        fontSize: 112,
        lineHeight: 1.06,
        color: color.fg,
        marginTop: 26,
        whiteSpace: "pre",
        ...enter(progress(t, 3)),
      }}
    >
      {heading}
    </div>
    <div
      style={{
        fontFamily: font.sans,
        fontSize: 38,
        lineHeight: 1.45,
        color: color.muted,
        marginTop: 34,
        maxWidth: 1300,
        ...enter(progress(t, 8)),
      }}
    >
      {lede}
    </div>
    {footer && (
      <div
        style={{
          position: "absolute",
          left: 160,
          bottom: 100,
          fontFamily: font.mono,
          fontSize: 30,
          color: color.moss,
          ...enter(progress(t, 12)),
        }}
      >
        {footer}
      </div>
    )}
  </AbsoluteFill>
);
