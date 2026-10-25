import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { code } from "../code.ts";
import { color, font } from "../theme.ts";
import { Window } from "../ui.tsx";

type Seg = { text: string; c?: string; bold?: boolean };
const dim = "#6f6656";
const LINES: Seg[][] = [
  [{ text: "$ ", c: dim }, { text: "alchemy deploy" }],
  [
    { text: "Plan", bold: true },
    { text: ": ", c: dim },
    { text: "2 to create", c: color.moss },
  ],
  [
    { text: "  + ", c: color.moss },
    { text: "Uploads ", bold: true },
    { text: "(Cloudflare.R2.Bucket)", c: dim },
  ],
  [
    { text: "  + ", c: color.moss },
    { text: "Api ", bold: true },
    { text: "(Cloudflare.Worker)", c: dim },
    { text: "  ↳ Uploads", c: color.moss },
  ],
  [],
  [
    { text: "Proceed? ", c: color.fg },
    { text: "● Yes", c: color.moss },
    { text: " ○ No", c: dim },
  ],
  [],
  [
    { text: "✓ ", c: color.moss },
    { text: "Uploads ", bold: true },
    { text: "created", c: color.moss },
  ],
  [
    { text: "✓ ", c: color.moss },
    { text: "Api ", bold: true },
    { text: "created", c: color.moss },
  ],
  [],
  [
    { text: "{ url: ", c: dim },
    { text: '"https://myapp-api.workers.dev"', c: "#ce9178" },
    { text: " }", c: dim },
  ],
];

/** The Stack on the left, `alchemy deploy` on the right. */
export const Deploy = ({ t }: { t: number }) => (
  <AbsoluteFill>
    <Window
      x={120}
      y={270}
      w={820}
      fs={20}
      file="alchemy.run.ts"
      code={code.stack}
      style={{ opacity: progress(t) }}
    />
    <div
      style={{
        position: "absolute",
        left: 1000,
        top: 270,
        width: 800,
        height: 620,
        borderRadius: 16,
        border: `1px solid ${color.hairline}`,
        background: "#12100d",
        padding: "28px 32px",
        boxSizing: "border-box",
        fontFamily: font.mono,
        fontSize: 25,
        lineHeight: 1.6,
        opacity: progress(t, 4),
      }}
    >
      {LINES.map((line, k) => (
        <div
          key={k}
          style={{ minHeight: "1.6em", whiteSpace: "pre", opacity: progress(t, 10 + k * 4, 4) }}
        >
          {line.map((s, i) => (
            <span key={i} style={{ color: s.c ?? color.fg, fontWeight: s.bold ? 700 : 400 }}>
              {s.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  </AbsoluteFill>
);
