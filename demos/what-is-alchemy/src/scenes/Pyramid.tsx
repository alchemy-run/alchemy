import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import type { Scene } from "../scene.ts";
import { color, font } from "../theme.ts";

type PyramidScene = Extract<Scene, { kind: "pyramid" }>;

/** An app's layers, bottom first. */
const LAYERS = [
  { title: "Infrastructure", detail: "compute · databases · buckets · queues", color: "#8b9cf6" },
  { title: "Configuration & policies", detail: "IAM · env vars · secrets", color: "#e0a86b" },
  { title: "APIs & business logic", detail: "handlers · services", color: "#a3c473" },
  { title: "Frontend", detail: "websites · CDN · domains", color: "#e06c9f" },
];
const CX = 760;
const BASE = 900;
const H = 140;
const GAP = 10;
const BOTTOM_W = 1120;
const SHRINK = 95;
const SLICE_W = 380;

const top = (k: number) => BASE - (k + 1) * H - k * GAP;

export const Pyramid = ({ scene, prev, t }: { scene: PyramidScene; prev?: Scene; t: number }) => {
  const before = prev?.kind === "pyramid" ? prev : undefined;
  // The cut and the slice draw in when they arrive and fade out when they leave.
  const cut = scene.cut
    ? before?.cut
      ? 1
      : progress(t, 4, 16)
    : before?.cut
      ? 1 - progress(t, 0, 12)
      : 0;
  const slice = scene.slice ? (before?.slice ? 1 : progress(t, 4, 20)) : 0;
  const label = scene.slice && before?.slice?.label !== scene.slice.label ? progress(t, 6, 12) : 1;
  const cutY = top(1) - GAP / 2;
  const sliceTop = top(3);

  return (
    <AbsoluteFill>
      {LAYERS.map((layer, k) => {
        const p = before ? 1 : progress(t, k * 5, 14);
        const wb = BOTTOM_W - k * SHRINK * 2;
        const wt = wb - SHRINK * 2;
        const y = top(k);
        return (
          <div key={layer.title} style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}>
            <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
              <polygon
                points={`${CX - wt / 2},${y} ${CX + wt / 2},${y} ${CX + wb / 2},${y + H} ${CX - wb / 2},${y + H}`}
                fill={`${layer.color}22`}
                stroke={layer.color}
                strokeWidth={2.5}
                strokeLinejoin="round"
              />
            </svg>
            <div
              style={{
                position: "absolute",
                left: CX - 400,
                width: 800,
                top: y + H / 2 - 38,
                textAlign: "center",
                opacity: 1 - slice,
              }}
            >
              <div
                style={{ fontFamily: font.sans, fontWeight: 600, fontSize: 36, color: color.fg }}
              >
                {layer.title}
              </div>
              <div
                style={{ fontFamily: font.mono, fontSize: 19, color: color.muted, marginTop: 6 }}
              >
                {layer.detail}
              </div>
            </div>
            {scene.slice && (
              <div
                style={{
                  position: "absolute",
                  left: CX - SLICE_W / 2,
                  width: SLICE_W,
                  top: y + H / 2 - 36,
                  textAlign: "center",
                  opacity: slice,
                }}
              >
                <div style={{ fontFamily: font.mono, fontSize: 17, color: layer.color }}>
                  {layer.title.toLowerCase()}
                </div>
                <div
                  style={{
                    fontFamily: font.sans,
                    fontWeight: 600,
                    fontSize: 32,
                    color: color.fg,
                    marginTop: 4,
                  }}
                >
                  {scene.slice.items[k]}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {slice > 0 && (
          <rect
            x={CX - SLICE_W / 2}
            y={sliceTop + (BASE - sliceTop) * (1 - slice)}
            width={SLICE_W}
            height={(BASE - sliceTop) * slice}
            rx={18}
            fill={`${color.moss}10`}
            stroke={color.moss}
            strokeWidth={4}
          />
        )}
        {cut > 0 && (
          <line
            x1={CX - 640}
            x2={CX - 640 + 1280 * cut}
            y1={cutY}
            y2={cutY}
            stroke={color.red}
            strokeWidth={3.5}
            strokeDasharray="14 10"
          />
        )}
      </svg>
      {cut > 0 && (
        <div
          style={{
            position: "absolute",
            left: CX + 660,
            top: cutY - 70,
            fontFamily: font.hand,
            fontWeight: 700,
            fontSize: 44,
            lineHeight: "64px",
            color: color.fg,
            opacity: cut,
          }}
        >
          <div>↑ runtime program</div>
          <div>↓ infrastructure program</div>
        </div>
      )}
      {scene.slice && (
        <div
          style={{
            position: "absolute",
            left: CX - 300,
            width: 600,
            top: BASE + 14,
            textAlign: "center",
            fontFamily: font.hand,
            fontWeight: 700,
            fontSize: 48,
            color: color.moss,
            opacity: slice * label,
          }}
        >
          {scene.slice.label}
        </div>
      )}
    </AbsoluteFill>
  );
};
