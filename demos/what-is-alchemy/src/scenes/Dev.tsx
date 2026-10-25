import { AbsoluteFill, interpolate } from "remotion";
import { progress } from "../anim.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";
import { Svg } from "../ui.tsx";

type Props = { scene: Extract<Scene, { kind: "dev" }>; prev?: Scene; t: number };
type Lane = "m" | "c" | "b";
type Hop = { label: string; lane: Lane };
type Row = { tool: string; headline: string; sub: string; hops: Hop[]; ours?: boolean };

/** Where one request goes in dev (the compare page's local dev section). */
const ALCHEMY_LOCAL: Row = {
  tool: "Alchemy",
  ours: true,
  headline: "0 round trips",
  sub: "Runs offline. Edits reload in place.",
  hops: [
    { label: "browser", lane: "m" },
    { label: "Lambda · Docker", lane: "m" },
    { label: "DynamoDB · floci", lane: "m" },
  ],
};
const ALCHEMY_REMOTE: Row = {
  ...ALCHEMY_LOCAL,
  headline: "2 round trips",
  sub: "remote() deploys the Lambda for real. It still reads and writes your local DynamoDB.",
  hops: [
    { label: "browser", lane: "m" },
    { label: "Lambda", lane: "c" },
    { label: "DynamoDB · floci", lane: "m" },
  ],
};
const OTHERS: Row[] = [
  {
    tool: "SST",
    headline: "3 round trips",
    sub: "Per request, through a deployed stage.",
    hops: [
      { label: "browser", lane: "m" },
      { label: "API Gateway", lane: "c" },
      { label: "Lambda stub", lane: "c" },
      { label: "your code", lane: "m" },
      { label: "DynamoDB", lane: "c" },
    ],
  },
  {
    tool: "Pulumi & Terraform",
    headline: "Deploy first",
    sub: "No local runtime. Every change is a redeploy.",
    hops: [
      { label: "edit", lane: "m" },
      { label: "deploy", lane: "b" },
      { label: "Lambda", lane: "c" },
      { label: "DynamoDB", lane: "c" },
    ],
  },
];

const DX = 620;
const DW = 1180;

/** One row: its caption on the left, the two lanes and the request's path on the right. */
const RowView = (p: {
  row: Row;
  y: number;
  h: number;
  opacity: number;
  /** One hop gliding from your machine (0) to the cloud (1). */
  move?: { hop: number; p: number };
}) => {
  const net = p.y + p.h / 2;
  const laneY = (l: Lane) => (l === "m" ? p.y + p.h * 0.25 : l === "c" ? p.y + p.h * 0.75 : net);
  const step = (DW - 200) / (p.row.hops.length - 1);
  const pts = p.row.hops.map((h, i) => ({
    ...h,
    x: DX + 100 + i * step,
    y: p.move?.hop === i ? laneY("m") + (laneY("c") - laneY("m")) * p.move.p : laneY(h.lane),
  }));
  const d = pts
    .slice(1)
    .map((b, i) => {
      const a = pts[i]!;
      return `M ${a.x} ${a.y} C ${a.x + step / 2} ${a.y}, ${b.x - step / 2} ${b.y}, ${b.x} ${b.y}`;
    })
    .join(" ");
  // A network crossing is a hop between your machine and the cloud.
  const crossings = pts.slice(1).flatMap((b, i) => {
    const a = pts[i]!;
    return a.lane !== "b" && b.lane !== "b" && Math.abs(a.y - b.y) > p.h * 0.45
      ? [{ x: (a.x + b.x) / 2, y: net }]
      : [];
  });
  return (
    <div style={{ opacity: p.opacity }}>
      <div style={{ position: "absolute", left: 120, top: p.y + p.h / 2 - 70, width: 460 }}>
        <div style={{ fontFamily: font.sans, fontWeight: 600, fontSize: 24, color: color.muted }}>
          {p.row.tool}
        </div>
        <div
          style={{
            fontFamily: font.serif,
            fontWeight: 600,
            fontSize: 46,
            color: p.row.ours ? color.moss : color.fg,
            marginTop: 2,
          }}
        >
          {p.row.headline}
        </div>
        <div
          style={{
            fontFamily: font.sans,
            fontSize: 20,
            lineHeight: 1.4,
            color: color.muted,
            marginTop: 6,
          }}
        >
          {p.row.sub}
        </div>
      </div>
      <Svg>
        <rect x={DX} y={p.y} width={DW} height={p.h / 2} fill="rgba(163,196,115,0.05)" />
        <rect x={DX} y={net} width={DW} height={p.h / 2} fill="rgba(139,156,246,0.05)" />
        <line
          x1={DX}
          x2={DX + DW}
          y1={net}
          y2={net}
          stroke={color.muted}
          strokeDasharray="6 8"
          strokeWidth={2}
        />
        <text
          x={DX + 14}
          y={net - 10}
          fontFamily={font.mono}
          fontSize={15}
          fill={color.muted}
          letterSpacing="0.15em"
        >
          YOUR MACHINE
        </text>
        <text
          x={DX + 14}
          y={net + 24}
          fontFamily={font.mono}
          fontSize={15}
          fill={color.muted}
          letterSpacing="0.15em"
        >
          CLOUD
        </text>
        <path d={d} stroke={color.moss} strokeWidth={3} strokeDasharray="8 8" fill="none" />
        {crossings.map((c, k) => (
          <circle key={k} cx={c.x} cy={c.y} r={10} fill={color.red} />
        ))}
      </Svg>
      {pts.map((h, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: h.x,
            top: h.y,
            transform: "translate(-50%, -50%)",
            padding: "10px 20px",
            borderRadius: 12,
            border: `2px solid ${h.lane === "b" ? color.ember : color.hairline}`,
            background: "#1d1a15",
            fontFamily: font.mono,
            fontSize: 22,
            color: color.fg,
            whiteSpace: "nowrap",
          }}
        >
          {h.label}
        </div>
      ))}
    </div>
  );
};

export const Dev = ({ scene, prev, t }: Props) => {
  const was = prev?.kind === "dev" ? prev.stage : 0;
  if (scene.stage === 1)
    return <RowView row={ALCHEMY_LOCAL} y={330} h={420} opacity={was ? 1 : progress(t)} />;
  if (scene.stage === 2) {
    // Lambda glides from your machine into the cloud; the caption switches halfway.
    const p = was === 2 ? 1 : progress(t, 4, 22);
    return (
      <RowView
        row={p > 0.5 ? ALCHEMY_REMOTE : ALCHEMY_LOCAL}
        y={330}
        h={420}
        opacity={1}
        move={{ hop: 1, p }}
      />
    );
  }
  const p = was === 3 ? 1 : progress(t, 0, 18);
  const h = interpolate(p, [0, 1], [420, 210]);
  const y = interpolate(p, [0, 1], [330, 250]);
  return (
    <AbsoluteFill>
      <RowView row={ALCHEMY_LOCAL} y={y} h={h} opacity={1} />
      {OTHERS.map((row, k) => (
        <RowView
          key={row.tool}
          row={row}
          y={250 + (k + 1) * 260}
          h={210}
          opacity={was === 3 ? 1 : progress(t, 10 + k * 8, 12)}
        />
      ))}
    </AbsoluteFill>
  );
};
