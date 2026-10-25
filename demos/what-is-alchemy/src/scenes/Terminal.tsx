import { AbsoluteFill } from "remotion";
import { enter, progress } from "../anim.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";

type Props = Extract<Scene, { kind: "terminal" }> & { t: number };

/** A terminal window; its lines print one after another. */
export const Terminal = ({ lines, t }: Props) => (
  <AbsoluteFill style={{ padding: "150px 80px 90px" }}>
    <div
      style={{
        height: "100%",
        background: "#1a1814",
        border: `1px solid ${color.hairline}`,
        borderRadius: 16,
        overflow: "hidden",
        ...enter(progress(t)),
      }}
    >
      <div style={{ display: "flex", gap: 10, padding: "18px 22px", background: "#211e19" }}>
        {["#e5675f", "#e0b04f", "#7cb36b"].map((c) => (
          <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
        ))}
      </div>
      <div style={{ padding: "26px 36px", fontFamily: font.mono, fontSize: 30, lineHeight: 1.55 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ minHeight: "1.55em", opacity: progress(t, 6 + i * 3, 4) }}>
            {line.map((s, k) => (
              <span
                key={k}
                style={{
                  color: s.color ?? color.fg,
                  fontWeight: s.bold ? 700 : 400,
                  whiteSpace: "pre",
                }}
              >
                {s.text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  </AbsoluteFill>
);
