import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { color, font } from "../theme.ts";
import { Svg } from "../ui.tsx";

/** The compare page's permissions: what the code needs against what each tool grants. */
const ROWS = [
  {
    tool: "Alchemy",
    code: "DynamoDB.GetItem(table)",
    grant: "dynamodb:GetItem on table",
    granted: 42,
    verdict: "Exact",
    c: color.moss,
  },
  {
    tool: "SST",
    code: "link: [table]",
    grant: "dynamodb:* on table",
    granted: 60,
    verdict: "Over-grants",
    c: color.ember,
  },
  {
    tool: "Pulumi & Terraform",
    code: "a policy you write",
    grant: "often dynamodb:* on *",
    granted: 78,
    verdict: "Unenforced",
    c: color.red,
    dashed: true,
  },
];
const NEEDED = 42;
const X = 700;
const UNIT = 12;
const Y = 300;
const ROW = 230;

export const Permissions = ({ t }: { t: number }) => (
  <AbsoluteFill>
    <Svg>
      <line
        x1={X + NEEDED * UNIT}
        x2={X + NEEDED * UNIT}
        y1={Y - 30}
        y2={Y + ROW * 3 - 60}
        stroke={color.fg}
        strokeWidth={2}
        strokeDasharray="8 8"
        opacity={progress(t, 0, 10) * 0.7}
      />
    </Svg>
    <div
      style={{
        position: "absolute",
        left: X + NEEDED * UNIT - 200,
        width: 400,
        textAlign: "center",
        top: Y - 72,
        fontFamily: font.sans,
        fontSize: 22,
        color: color.fg,
        opacity: progress(t, 0, 10),
      }}
    >
      what the code needs
    </div>
    {ROWS.map((row, k) => {
      const p = progress(t, 6 + k * 8, 20);
      const y = Y + k * ROW;
      return (
        <div key={row.tool} style={{ opacity: progress(t, k * 8, 10) }}>
          <div
            style={{
              position: "absolute",
              left: 120,
              top: y,
              fontFamily: font.serif,
              fontWeight: 600,
              fontSize: 40,
              color: color.fg,
            }}
          >
            {row.tool}
          </div>
          <div
            style={{
              position: "absolute",
              left: 120,
              top: y + 58,
              fontFamily: font.mono,
              fontSize: 22,
              color: color.muted,
            }}
          >
            {row.code}
          </div>
          <div
            style={{
              position: "absolute",
              left: X,
              top: y + 6,
              width: row.granted * UNIT * p,
              height: 48,
              borderRadius: 10,
              boxSizing: "border-box",
              background: row.dashed
                ? "transparent"
                : `color-mix(in srgb, ${row.c} 55%, transparent)`,
              border: `3px ${row.dashed ? "dashed" : "solid"} ${row.c}`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: X,
              top: y + 70,
              fontFamily: font.mono,
              fontSize: 22,
              color: color.fg,
              opacity: p,
            }}
          >
            {row.grant}
          </div>
          <div
            style={{
              position: "absolute",
              left: X + row.granted * UNIT + 24,
              top: y + 10,
              fontFamily: font.sans,
              fontWeight: 700,
              fontSize: 28,
              color: row.c,
              opacity: progress(t, 18 + k * 8, 10),
            }}
          >
            {row.verdict}
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);
