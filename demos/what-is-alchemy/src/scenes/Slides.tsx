import { AbsoluteFill } from "remotion";
import { enter, progress } from "../anim.ts";
import { color, font } from "../theme.ts";

export const Title = (p: { heading: string; subtitle?: string; footer?: string; t: number }) => (
  <AbsoluteFill style={{ padding: "0 160px", justifyContent: "center" }}>
    <div style={enter(progress(p.t))}>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 26,
          letterSpacing: "0.3em",
          color: color.moss,
          marginBottom: 28,
        }}
      >
        ALCHEMY
      </div>
      <div
        style={{
          fontFamily: font.serif,
          fontWeight: 600,
          fontSize: 108,
          lineHeight: 1.08,
          color: color.fg,
          whiteSpace: "pre",
        }}
      >
        {p.heading}
      </div>
      {p.subtitle && (
        <div style={{ fontFamily: font.sans, fontSize: 42, color: color.muted, marginTop: 32 }}>
          {p.subtitle}
        </div>
      )}
    </div>
    {p.footer && (
      <div
        style={{
          position: "absolute",
          left: 160,
          bottom: 110,
          fontFamily: font.mono,
          fontSize: 32,
          color: color.moss,
          ...enter(progress(p.t, 8)),
        }}
      >
        {p.footer}
      </div>
    )}
  </AbsoluteFill>
);

export const Section = (p: { heading: string; t: number }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
    <div
      style={{
        fontFamily: font.serif,
        fontWeight: 600,
        fontSize: 110,
        lineHeight: 1.15,
        color: color.fg,
        textAlign: "center",
        whiteSpace: "pre-line",
        ...enter(progress(p.t)),
      }}
    >
      {p.heading}
    </div>
  </AbsoluteFill>
);
