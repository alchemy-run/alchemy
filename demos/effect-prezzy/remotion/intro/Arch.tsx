import { interpolate } from "remotion";
import type { ArchStep } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";
import { Arrow, drawProgress } from "./draw.tsx";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const W = 270;
const H = 124;

/**
 * An architecture drawing: boxes appear one after another in the order
 * given, and each arrow draws itself once both of its ends are on screen.
 */
export const ArchView = ({ step, local }: { step: ArchStep; local: number }) => {
  const byId = new Map(step.nodes.map((n) => [n.id, n]));
  const order = (id: string) => step.nodes.findIndex((n) => n.id === id);
  const appear = (id: string) => interpolate(local, [order(id) * 5, order(id) * 5 + 8], [0, 1], clamp);
  const width = (id: string) => byId.get(id)?.w ?? W;

  /** Where a line from `a` towards `b` leaves `a`'s box. */
  const port = (a: string, b: string) => {
    const p = byId.get(a)!;
    const q = byId.get(b)!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (Math.abs(dx) * H > Math.abs(dy) * width(a)) {
      return { x: p.x + Math.sign(dx) * (width(a) / 2 + 10), y: p.y };
    }
    return { x: p.x, y: p.y + Math.sign(dy) * (H / 2 + 10) };
  };

  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      {step.edges.map((edge) => {
        const start = Math.max(order(edge.from), order(edge.to)) * 5 + 6;
        const a = port(edge.from, edge.to);
        const b = port(edge.to, edge.from);
        const color = edge.dashed ? "#56b6c2" : brand.fgMuted;
        const p = drawProgress(local, start, 10);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <g key={`${edge.from}-${edge.to}`}>
            {edge.dashed ? (
              <path
                d={`M ${a.x} ${a.y} L ${a.x + (b.x - a.x) * p} ${a.y + (b.y - a.y) * p}`}
                stroke={color}
                strokeWidth={3}
                strokeDasharray="10 9"
                opacity={0.8}
              />
            ) : (
              <Arrow x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={color} progress={p} bend={0} />
            )}
            {edge.label ? (
              // Above a horizontal arrow, beside a vertical one: never on the line.
              <g opacity={interpolate(local, [start + 6, start + 12], [0, 1], clamp)}>
                <text
                  x={Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? mx : mx + 18}
                  y={Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? my - 18 : my + 8}
                  textAnchor={Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? "middle" : "start"}
                  fontFamily={mono}
                  fontSize={24}
                  fill={edge.dashed ? color : "#7ee787"}
                >
                  {edge.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {step.nodes.map((node) => {
        const q = appear(node.id);
        const w = width(node.id);
        return (
          <g key={node.id} opacity={q} transform={`translate(${node.x} ${node.y}) scale(${0.92 + 0.08 * q})`}>
            <rect x={-w / 2} y={-H / 2} width={w} height={H} rx={20} fill={brand.bgElevated} stroke={node.color} strokeWidth={3.5} />
            <text x={0} y={node.sub ? -6 : 12} textAnchor="middle" fontFamily={sans} fontWeight={700} fontSize={36} fill={brand.fg}>
              {node.title}
            </text>
            {node.sub ? (
              <text x={0} y={34} textAnchor="middle" fontFamily={mono} fontSize={22} fill={brand.fgMuted}>
                {node.sub}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
};
